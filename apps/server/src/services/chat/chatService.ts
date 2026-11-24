import { createHash } from "node:crypto";
import { prisma, type Message, type GenerationRun, type OutboxEvent } from "@messiah/db";
import type { SendMessageInput, MessageInfo, GenerationRunInfo } from "@messiah/shared";
import { threadService } from "./threadService.js";
import { messageService } from "./messageService.js";
import { generationService } from "./generationService.js";
import { chatQueueManager, type GenerationJobPayload } from "./chatQueue.js";
import { executionEngine } from "./executionEngine.js";
import { logAuditEvent } from "../auditService.js";

export class ChatServiceError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode = 400, code = "CHAT_SERVICE_ERROR") {
    super(message);
    this.name = "ChatServiceError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * Computes a deterministic SHA-256 request fingerprint from the input payload.
 * Used to detect when an idempotency key is reused with different parameters.
 */
export function computeRequestFingerprint(input: {
  content: string;
  modelId: string;
  providerConnectionId: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}): string {
  const canonical = JSON.stringify({
    content: input.content.trim(),
    modelId: input.modelId.trim(),
    providerConnectionId: input.providerConnectionId,
    systemPrompt: input.systemPrompt?.trim() || "",
    temperature: input.temperature ?? null,
    maxTokens: input.maxTokens ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export class ChatService {
  /**
   * Accepts user message input, creates persistent database records within a single transaction,
   * enforces database-level idempotency and single active run concurrency,
   * creates an Outbox event, and dispatches streaming background generation.
   */
  public async sendMessage(
    userId: string,
    threadId: string,
    input: SendMessageInput,
    meta?: { ipAddress?: string; userAgent?: string }
  ): Promise<{ userMessage: MessageInfo; assistantMessage: MessageInfo; run: GenerationRunInfo }> {
    // 1. Verify thread access & workspace membership
    const thread = await threadService.verifyThreadAccess(userId, threadId);

    // Compute canonical request fingerprint
    const fingerprint = computeRequestFingerprint(input);

    // 2. Database-enforced idempotency pre-check
    if (input.idempotencyKey) {
      const trimmedKey = input.idempotencyKey.trim();
      const existingKeyRecord = await prisma.idempotencyKey.findUnique({
        where: {
          threadId_key: {
            threadId,
            key: trimmedKey,
          },
        },
        include: {
          generationRun: {
            include: {
              assistantMessage: true,
            },
          },
        },
      });

      if (existingKeyRecord) {
        // Reused key with different payload must be rejected
        if (existingKeyRecord.requestFingerprint !== fingerprint) {
          throw new ChatServiceError(
            "Idempotency key was reused with a different request payload.",
            422,
            "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD"
          );
        }

        // Duplicate request with matching payload returns existing result
        if (existingKeyRecord.generationRun) {
          const userMsg = await prisma.message.findFirst({
            where: {
              threadId,
              id: existingKeyRecord.userMessageId || undefined,
            },
          });

          if (userMsg) {
            return {
              userMessage: messageService.formatMessage(userMsg),
              assistantMessage: messageService.formatMessage(existingKeyRecord.generationRun.assistantMessage),
              run: generationService.formatRun(existingKeyRecord.generationRun),
            };
          }
        }
      }
    }

    // 3. Application-level pre-check for active generation runs in this thread
    const activeRun = await prisma.generationRun.findFirst({
      where: {
        threadId,
        status: { in: ["PENDING", "STREAMING"] },
      },
    });

    if (activeRun) {
      throw new ChatServiceError(
        "A generation run is already in progress for this conversation thread.",
        409,
        "CONCURRENT_RUN_ACTIVE"
      );
    }

    // 4. Verify provider connection exists, is active, and belongs to workspace
    const connection = await prisma.providerConnection.findFirst({
      where: {
        id: input.providerConnectionId,
        workspaceId: thread.workspaceId,
      },
      include: { credential: true },
    });

    if (!connection || !connection.credential) {
      throw new ChatServiceError(
        "Selected provider connection was not found in this workspace.",
        404,
        "CONNECTION_NOT_FOUND"
      );
    }

    if (connection.status !== "ACTIVE") {
      throw new ChatServiceError(
        `Selected provider connection is not active (current status: ${connection.status}).`,
        400,
        "CONNECTION_NOT_ACTIVE"
      );
    }

    // 5. Transactionally create user message, assistant placeholder, generation run, idempotency record, and outbox event
    let result: {
      userMessage: Message;
      assistantMessage: Message;
      run: GenerationRun;
      outboxEvent: OutboxEvent;
    };

    try {
      result = await prisma.$transaction(async (tx) => {
        const nextSeq = await messageService.getNextSequence(threadId);

        // User Message
        const userMessage = await tx.message.create({
          data: {
            threadId,
            sequence: nextSeq,
            role: "USER",
            content: input.content.trim(),
            status: "COMPLETED",
            completedAt: new Date(),
          },
        });

        // Assistant Message Placeholder
        const assistantMessage = await tx.message.create({
          data: {
            threadId,
            sequence: nextSeq + 1,
            role: "ASSISTANT",
            content: "",
            status: "PENDING",
            providerConnectionId: connection.id,
            modelId: input.modelId.trim(),
          },
        });

        // Generation Run (startedAt is null until execution worker transitions to STREAMING)
        const run = await tx.generationRun.create({
          data: {
            threadId,
            assistantMessageId: assistantMessage.id,
            providerConnectionId: connection.id,
            provider: connection.provider,
            modelId: input.modelId.trim(),
            status: "PENDING",
            startedAt: null,
            idempotencyKey: input.idempotencyKey?.trim() || null,
            requestFingerprint: fingerprint,
          },
        });

        // Idempotency Key Record
        if (input.idempotencyKey) {
          await tx.idempotencyKey.create({
            data: {
              workspaceId: thread.workspaceId,
              userId,
              threadId,
              key: input.idempotencyKey.trim(),
              requestFingerprint: fingerprint,
              generationRunId: run.id,
              userMessageId: userMessage.id,
              assistantMessageId: assistantMessage.id,
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hour retention
            },
          });
        }

        // Transactional Outbox Event
        const outboxEvent = await tx.outboxEvent.create({
          data: {
            eventType: "generation.dispatch",
            aggregateType: "GenerationRun",
            aggregateId: run.id,
            payload: {
              runId: run.id,
              threadId,
              workspaceId: thread.workspaceId,
              userId,
              userMessageId: userMessage.id,
              assistantMessageId: assistantMessage.id,
              providerConnectionId: connection.id,
              provider: connection.provider,
              modelId: input.modelId.trim(),
              content: input.content.trim(),
              temperature: input.temperature,
              maxTokens: input.maxTokens,
              systemPrompt: input.systemPrompt,
            },
            status: "PENDING",
          },
        });

        // Update thread timestamp and title if first message
        const shouldUpdateTitle = thread.title === "New Conversation" && nextSeq === 1;
        const autoTitle = shouldUpdateTitle
          ? input.content.trim().slice(0, 48) + (input.content.length > 48 ? "..." : "")
          : undefined;

        await tx.thread.update({
          where: { id: threadId },
          data: {
            lastMessageAt: new Date(),
            preferredProviderConnectionId: connection.id,
            preferredModelId: input.modelId.trim(),
            ...(autoTitle ? { title: autoTitle } : {}),
          },
        });

        return { userMessage, assistantMessage, run, outboxEvent };
      });
    } catch (txErr: unknown) {
      const err = txErr as { code?: string; meta?: Record<string, unknown> };
      if (err.code === "P2002") {
        const metaStr = JSON.stringify(err.meta || {});
        // Conflict on single active run partial unique index
        if (metaStr.includes("idx_generation_runs_single_active_per_thread") || metaStr.includes("thread_id")) {
          throw new ChatServiceError(
            "A generation run is already in progress for this conversation thread.",
            409,
            "CONCURRENT_RUN_ACTIVE"
          );
        }
        // Conflict on idempotency key
        if (input.idempotencyKey && (metaStr.includes("idempotency_keys") || metaStr.includes("key"))) {
          const existingKeyRecord = await prisma.idempotencyKey.findUnique({
            where: {
              threadId_key: {
                threadId,
                key: input.idempotencyKey.trim(),
              },
            },
            include: {
              generationRun: {
                include: { assistantMessage: true },
              },
            },
          });
          if (existingKeyRecord) {
            if (existingKeyRecord.requestFingerprint !== fingerprint) {
              throw new ChatServiceError(
                "Idempotency key was reused with a different request payload.",
                422,
                "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD"
              );
            }
            if (existingKeyRecord.generationRun) {
              const userMsg = await prisma.message.findFirst({
                where: { threadId, id: existingKeyRecord.userMessageId || undefined },
              });
              if (userMsg) {
                return {
                  userMessage: messageService.formatMessage(userMsg),
                  assistantMessage: messageService.formatMessage(existingKeyRecord.generationRun.assistantMessage),
                  run: generationService.formatRun(existingKeyRecord.generationRun),
                };
              }
            }
          }
        }
      }
      throw txErr;
    }

    // 6. Log audit event
    await logAuditEvent({
      workspaceId: thread.workspaceId,
      actorId: userId,
      action: "CHAT_MESSAGE_SENT",
      resourceType: "Thread",
      resourceId: thread.id,
      details: {
        messageId: result.userMessage.id,
        runId: result.run.id,
        provider: connection.provider,
        modelId: input.modelId,
      },
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });

    // 7. Dispatch to BullMQ with transactional outbox fallback
    const jobPayload: GenerationJobPayload = {
      runId: result.run.id,
      outboxEventId: result.outboxEvent.id,
      threadId,
      workspaceId: thread.workspaceId,
      userId,
      userMessageId: result.userMessage.id,
      assistantMessageId: result.assistantMessage.id,
      providerConnectionId: connection.id,
      provider: connection.provider,
      modelId: input.modelId.trim(),
      content: input.content.trim(),
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      systemPrompt: input.systemPrompt,
    };

    chatQueueManager.enqueueRun(jobPayload).then(async (enqueued) => {
      if (!enqueued) {
        // If queue is not running (e.g. monolithic test/dev or redis queue offline),
        // fallback to executionEngine direct background execution
        executionEngine.execute(jobPayload).catch((err) => {
          console.error("[ChatService] Unhandled error during direct execution fallback:", err);
        });
      }
    });

    return {
      userMessage: messageService.formatMessage(result.userMessage),
      assistantMessage: messageService.formatMessage(result.assistantMessage),
      run: generationService.formatRun(result.run),
    };
  }
}

export const chatService = new ChatService();
