import { Worker, type ConnectionOptions, type Job } from "bullmq";
import { Redis } from "ioredis";
import { prisma } from "@messiah/db";
import { SwarmExecutionRuntime, type SwarmJobPayload } from "@messiah/agents";
import { WorkflowExecutionRuntime, type WorkflowJobPayload } from "@messiah/workflows";
import { MemoryService } from "@messiah/memory";
import { defaultProviderRegistry, type ProviderChatMessage } from "@messiah/providers";
import type { MessiahStreamEvent, SupportedProviderId, WorkspaceRole } from "@messiah/shared";
import {
  ToolAuthorizationService,
  computeArgumentsHash,
} from "@messiah/mcp";
import { CHAT_GENERATION_QUEUE_NAME } from "./dispatcher.js";
import { WorkerCancellationSubscriber } from "./cancellationSubscriber.js";
import { workerToolExecutor } from "./toolExecutor.js";
import { VaultService } from "./vault.js";

export interface GenerationJobData {
  runId: string;
  outboxEventId?: string;
  threadId: string;
  workspaceId: string;
  userId: string;
  userMessageId: string;
  assistantMessageId: string;
  providerConnectionId: string;
  provider: string;
  modelId: string;
  content: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export class ChatGenerationWorker {
  private worker: Worker<GenerationJobData> | null = null;
  private redisPublisher: Redis | null = null;
  private cancellationSub: WorkerCancellationSubscriber;
  private authService = new ToolAuthorizationService();

  public static readonly MAX_AGENT_ROUNDS = 6;
  public static readonly MAX_TOOL_CALLS = 10;
  public static readonly MAX_RUN_DURATION_MS = 10 * 60 * 1000; // 10 minutes

  constructor(private redisUrl: string, private concurrency = 5) {
    this.cancellationSub = new WorkerCancellationSubscriber(redisUrl);
  }

  public async start(): Promise<void> {
    await this.cancellationSub.start();

    // Publisher for realtime events
    this.redisPublisher = new Redis(this.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
    });
    await this.redisPublisher.connect();

    const parsedUrl = new URL(this.redisUrl);
    const connection: ConnectionOptions = {
      host: parsedUrl.hostname,
      port: Number(parsedUrl.port) || 6379,
      password: parsedUrl.password || undefined,
      maxRetriesPerRequest: null,
    };

    const swarmRuntime = new SwarmExecutionRuntime({
      decryptProviderSecret: (input) =>
        VaultService.decrypt(
          input.ciphertext,
          input.initializationVector,
          input.authenticationTag,
          input.providerConnectionId,
          input.workspaceId,
          input.keyVersion
        ),
      decryptMcpSecret: (encryptedValue, context) => {
        const parsed = JSON.parse(encryptedValue) as {
          ciphertext: string;
          initializationVector?: string;
          authenticationTag?: string;
          iv?: string;
          tag?: string;
        };
        return VaultService.decrypt(
          parsed.ciphertext,
          parsed.initializationVector || parsed.iv || "",
          parsed.authenticationTag || parsed.tag || "",
          context.connectionId,
          context.workspaceId,
          context.keyVersion
        );
      },
      publishEvent: async (event) => {
        if (!this.redisPublisher) return;
        await this.redisPublisher
          .publish(`messiah:swarms:${event.runId}:events`, JSON.stringify(event))
          .catch(() => {});
      },
      publishThreadMessageUpdate: async ({ threadId, assistantMessageId, runId, status, content }) => {
        await prisma.message
          .update({
            where: { id: assistantMessageId },
            data: { content, status, completedAt: new Date() },
          })
          .catch(() => {});

        await this.publishEvent(threadId, {
          type: "message.snapshot",
          threadId,
          runId,
          messageId: assistantMessageId,
          sequence: 1,
          timestamp: new Date().toISOString(),
          payload: { content, status },
        });
      },
      isCancellationRequested: async (runId) => {
        const signal = this.cancellationSub.register(runId);
        return signal.aborted;
      },
    });

    const workflowRuntime = new WorkflowExecutionRuntime({
      decryptProviderSecret: (input) =>
        VaultService.decrypt(
          input.ciphertext,
          input.initializationVector,
          input.authenticationTag,
          input.providerConnectionId,
          input.workspaceId,
          input.keyVersion
        ),
      decryptMcpSecret: (encryptedValue, context) => {
        const parsed = JSON.parse(encryptedValue) as {
          ciphertext: string;
          initializationVector?: string;
          authenticationTag?: string;
          iv?: string;
          tag?: string;
        };
        return VaultService.decrypt(
          parsed.ciphertext,
          parsed.initializationVector || parsed.iv || "",
          parsed.authenticationTag || parsed.tag || "",
          context.connectionId,
          context.workspaceId,
          context.keyVersion
        );
      },
      publishEvent: async (event) => {
        if (!this.redisPublisher) return;
        await this.redisPublisher
          .publish(`messiah:workflows:${event.runId}:events`, JSON.stringify(event))
          .catch(() => {});
      },
      isCancellationRequested: async (runId) => {
        const signal = this.cancellationSub.register(runId);
        return signal.aborted;
      },
    });

    this.worker = new Worker<GenerationJobData>(
      CHAT_GENERATION_QUEUE_NAME,
      async (job: Job<GenerationJobData>) => {
        const maybeWorkflow = job.data as unknown as WorkflowJobPayload;
        if (job.name === "workflow.execute" || maybeWorkflow?.kind === "workflow.execute") {
          await workflowRuntime.processJob(maybeWorkflow);
          return;
        }
        const maybeSwarm = job.data as unknown as SwarmJobPayload;
        if (job.name === "swarm.execute" || maybeSwarm?.kind === "swarm.execute") {
          await swarmRuntime.processJob(maybeSwarm);
          return;
        }
        await this.processJob(job.data);
      },
      {
        connection,
        concurrency: this.concurrency,
      }
    );

    this.worker.on("error", (err) => {
      console.error("[ChatGenerationWorker] Worker encountered error:", err);
    });

    this.worker.on("failed", (job, err) => {
      console.error(`[ChatGenerationWorker] Job ${job?.id} failed:`, err);
    });

    console.log(`[ChatGenerationWorker] Started BullMQ worker for '${CHAT_GENERATION_QUEUE_NAME}' (concurrency: ${this.concurrency})`);
  }

  private async publishEvent(threadId: string, event: MessiahStreamEvent): Promise<void> {
    if (!this.redisPublisher) return;
    try {
      const channel = `messiah:threads:${threadId}:events`;
      await this.redisPublisher.publish(channel, JSON.stringify(event));
    } catch (err) {
      console.warn(`[ChatGenerationWorker] Failed to publish stream event:`, err);
    }
  }

  private async processJob(data: GenerationJobData): Promise<void> {
    const { runId, threadId, assistantMessageId, userMessageId, modelId, content, temperature, maxTokens, systemPrompt } = data;
    const abortSignal = this.cancellationSub.register(runId);

    let eventSequence = 1;
    let accumulatedContent = "";
    let lastCheckpointContent = "";
    let lastCheckpointTime = Date.now();

    try {
      // 1. Verify run state
      const run = await prisma.generationRun.findUnique({
        where: { id: runId },
        include: {
          providerConnection: {
            include: { credential: true },
          },
        },
      });

      // Ensure run is still PENDING. If already claimed, completed, or cancelled, do not re-execute!
      if (!run || run.status !== "PENDING") {
        console.warn(`[ChatGenerationWorker] Run ${runId} is not in PENDING state (current: ${run?.status}). Skipping duplicate execution.`);
        return;
      }

      // Check persisted cancellation state if Redis cancellation was missed
      if (run.cancellationRequestedAt || abortSignal.aborted) {
        await this.handleCancellation(runId, threadId, assistantMessageId, accumulatedContent, eventSequence);
        return;
      }

      // 2. Atomically transition state to STREAMING and populate startedAt AT THIS EXACT MOMENT
      const startedAt = new Date();
      const claimResult = await prisma.generationRun.updateMany({
        where: { id: runId, status: "PENDING" },
        data: {
          status: "STREAMING",
          startedAt,
        },
      });

      if (claimResult.count === 0) {
        console.warn(`[ChatGenerationWorker] Run ${runId} was already claimed by another process. Skipping.`);
        return;
      }

      await prisma.message.update({
        where: { id: assistantMessageId },
        data: { status: "STREAMING" },
      });

      // 3. Emit run.started event
      await this.publishEvent(threadId, {
        type: "run.started",
        threadId,
        runId,
        messageId: assistantMessageId,
        sequence: eventSequence++,
        timestamp: startedAt.toISOString(),
        payload: { status: "STREAMING" },
      });

      if (abortSignal.aborted) {
        await this.handleCancellation(runId, threadId, assistantMessageId, accumulatedContent, eventSequence);
        return;
      }

      // 4. Decrypt provider API key
      const credential = run.providerConnection.credential;
      if (!credential) {
        throw new Error("Provider credential not found");
      }

      const { VaultService } = await import("./vault.js");
      const apiKey = VaultService.decrypt(
        credential.ciphertext,
        credential.initializationVector,
        credential.authenticationTag,
        run.providerConnectionId,
        data.workspaceId
      );

      // 5. Look up user workspace membership to evaluate tool permissions
      const member = await prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: data.workspaceId,
            userId: data.userId,
          },
        },
      });
      const userRole = (member?.role || "MEMBER") as WorkspaceRole;

      // 6. Discover active tools in the workspace
      const { definitions, mappings } = await workerToolExecutor.getAvailableToolsForWorkspace(data.workspaceId);

      // 7. Check for previously requested tool calls in this run (e.g. approved or denied upon resume)
      const existingToolCalls = await prisma.toolCall.findMany({
        where: { generationRunId: runId },
        orderBy: { createdAt: "asc" },
      });

      for (const tc of existingToolCalls) {
        if (tc.status === "APPROVED" && tc.completedAt === null) {
          // Human approved this tool call! Execute it now!
          await this.publishEvent(threadId, {
            type: "tool.executing",
            threadId,
            runId,
            messageId: tc.providerCallId,
            sequence: eventSequence++,
            timestamp: new Date().toISOString(),
            payload: {
              toolCall: {
                id: tc.id,
                providerCallId: tc.providerCallId,
                toolName: tc.toolName,
                providerToolAlias: tc.providerToolAlias,
                status: "EXECUTING",
              },
            },
          });

          const mapping = mappings.get(tc.providerToolAlias);
          const outcome = await workerToolExecutor.executeTool(
            data.workspaceId,
            tc.connectionId,
            tc.toolName,
            mapping?.inputSchema || {},
            tc.schemaHash,
            (tc.argumentsPreview as Record<string, unknown>) || {}
          );

          await prisma.toolCall.update({
            where: { id: tc.id },
            data: {
              status: outcome.status,
              result: outcome.result as any,
              isError: outcome.isError,
              errorMessage: outcome.errorMessage || null,
              durationMs: outcome.durationMs,
              completedAt: new Date(),
            },
          });

          await this.publishEvent(threadId, {
            type:
              outcome.status === "UNKNOWN_OUTCOME"
                ? "tool.unknown_outcome"
                : outcome.isError
                ? "tool.failed"
                : "tool.completed",
            threadId,
            runId,
            messageId: tc.providerCallId,
            sequence: eventSequence++,
            timestamp: new Date().toISOString(),
            payload: {
              toolCall: {
                id: tc.id,
                providerCallId: tc.providerCallId,
                status: outcome.status,
                isError: outcome.isError,
                errorMessage: outcome.errorMessage,
                durationMs: outcome.durationMs,
              },
            },
          });
        } else if (tc.status === "DENIED" && tc.completedAt === null) {
          await prisma.toolCall.update({
            where: { id: tc.id },
            data: { completedAt: new Date() },
          });
        }
      }

      // 8. Reconstruct conversation messages history
      const priorMessages = await prisma.message.findMany({
        where: {
          threadId,
          id: { notIn: [userMessageId, assistantMessageId] },
        },
        orderBy: { sequence: "asc" },
      });

      const conversationHistory: ProviderChatMessage[] = priorMessages.map((m) => ({
        role: m.role === "TOOL" ? "tool" : (m.role.toLowerCase() as "user" | "assistant" | "system"),
        content: m.content,
      }));

      // Append current user message
      conversationHistory.push({ role: "user", content });

      // If existing completed/denied tool calls exist in this run, append them to the history
      const reloadedToolCalls = await prisma.toolCall.findMany({
        where: { generationRunId: runId },
        orderBy: { createdAt: "asc" },
      });

      for (const tc of reloadedToolCalls) {
        if (tc.completedAt !== null) {
          conversationHistory.push({
            role: "assistant",
            toolCalls: [
              {
                providerCallId: tc.providerCallId,
                toolName: tc.providerToolAlias,
                arguments: (tc.argumentsPreview as Record<string, unknown>) || {},
              },
            ],
          });

          const toolContent = tc.isError
            ? `Tool execution failed: ${tc.errorMessage || "Unknown error"}`
            : typeof tc.result === "string"
            ? tc.result
            : JSON.stringify(tc.result ?? "");

          conversationHistory.push({
            role: "tool",
            toolCallId: tc.providerCallId,
            toolName: tc.providerToolAlias,
            content: toolContent,
            toolResults: [
              {
                providerCallId: tc.providerCallId,
                toolName: tc.providerToolAlias,
                result: tc.result,
                isError: tc.isError,
              },
            ],
          });
        }
      }

      // Existing message content if resumed
      const currentAssistantMsg = await prisma.message.findUnique({
        where: { id: assistantMessageId },
        select: { content: true },
      });
      if (currentAssistantMsg?.content) {
        accumulatedContent = currentAssistantMsg.content;
      }

      // 9. Multi-turn Controlled Agent Loop
      let effectiveSystemPrompt = systemPrompt;
      try {
        const workerMemory = new MemoryService({
          decryptProviderSecret: (input) =>
            VaultService.decrypt(
              input.ciphertext,
              input.initializationVector,
              input.authenticationTag,
              input.providerConnectionId,
              input.workspaceId,
              input.keyVersion
            ),
        });
        const memBundle = await workerMemory.buildPromptMemoryBlock({
          workspaceId: data.workspaceId,
          userId: data.userId,
          query: content,
          scopes: ["PERSONAL", "WORKSPACE"],
          channel: "chat",
        });
        if (memBundle.contextBlock) {
          effectiveSystemPrompt = effectiveSystemPrompt
            ? `${effectiveSystemPrompt}\n\n${memBundle.contextBlock}`
            : memBundle.contextBlock;
        }
      } catch {
        // Non-blocking fallback when embeddings or memory unavailable
      }

      const adapter = defaultProviderRegistry.getAdapter(run.provider as SupportedProviderId);
      let round = 0;
      let executedToolCallsCount = reloadedToolCalls.filter((t) => t.completedAt !== null).length;
      let consecutiveDuplicateCount = 0;
      let lastToolFingerprint = "";

      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCachedTokens = 0;
      let responseId: string | undefined;

      while (round < ChatGenerationWorker.MAX_AGENT_ROUNDS) {
        round++;

        // Enforce time budget
        if (Date.now() - startedAt.getTime() > ChatGenerationWorker.MAX_RUN_DURATION_MS) {
          accumulatedContent += "\n\n[Execution halted: Maximum run duration (10 minutes) exceeded.]";
          break;
        }

        if (abortSignal.aborted) {
          await this.handleCancellation(runId, threadId, assistantMessageId, accumulatedContent, eventSequence);
          return;
        }

        const stream = adapter.streamResponse(
          {
            model: modelId,
            messages: conversationHistory,
            temperature,
            maxTokens,
            credentials: { apiKey },
            systemPrompt: effectiveSystemPrompt,
            tools: definitions.length > 0 ? definitions : undefined,
          },
          abortSignal
        );

        const roundToolCalls: Array<{
          callId: string;
          toolName: string;
          arguments: Record<string, unknown> | string;
        }> = [];

        let turnGeneratedText = "";

        for await (const chunk of stream) {
          if (abortSignal.aborted) {
            break;
          }

          if (chunk.type === "text_delta") {
            turnGeneratedText += chunk.text;
            accumulatedContent += chunk.text;

            await this.publishEvent(threadId, {
              type: "message.delta",
              threadId,
              runId,
              messageId: assistantMessageId,
              sequence: eventSequence++,
              timestamp: new Date().toISOString(),
              payload: { delta: chunk.text },
            });

            const now = Date.now();
            if (
              accumulatedContent.length - lastCheckpointContent.length > 200 ||
              now - lastCheckpointTime > 1500
            ) {
              lastCheckpointContent = accumulatedContent;
              lastCheckpointTime = now;
              await prisma.message.update({
                where: { id: assistantMessageId },
                data: { content: accumulatedContent },
              });

              // Persisted cancellation state check
              const persistedRun = await prisma.generationRun.findUnique({
                where: { id: runId },
                select: { cancellationRequestedAt: true, status: true },
              });
              if (persistedRun?.cancellationRequestedAt || persistedRun?.status === "CANCELLED") {
                break;
              }
            }
          } else if (chunk.type === "tool_call_delta") {
            await this.publishEvent(threadId, {
              type: "tool.delta",
              threadId,
              runId,
              messageId: assistantMessageId,
              sequence: eventSequence++,
              timestamp: new Date().toISOString(),
              payload: {
                argumentsDelta: chunk.argumentsDelta,
                toolCall: {
                  providerCallId: chunk.callId,
                  toolName: chunk.toolName || "",
                },
              },
            });
          } else if (chunk.type === "tool_call") {
            roundToolCalls.push({
              callId: chunk.callId,
              toolName: chunk.toolName,
              arguments: chunk.arguments,
            });
          } else if (chunk.type === "usage") {
            totalInputTokens += chunk.inputTokens;
            totalOutputTokens += chunk.outputTokens;
            totalCachedTokens += chunk.cachedInputTokens || 0;

            await this.publishEvent(threadId, {
              type: "usage.updated",
              threadId,
              runId,
              messageId: assistantMessageId,
              sequence: eventSequence++,
              timestamp: new Date().toISOString(),
              payload: {
                usage: {
                  inputTokens: totalInputTokens,
                  outputTokens: totalOutputTokens,
                  cachedInputTokens: totalCachedTokens,
                  totalTokens: totalInputTokens + totalOutputTokens,
                },
              },
            });
          } else if (chunk.type === "completed") {
            responseId = chunk.responseId;
          }
        }

        if (abortSignal.aborted) {
          await this.handleCancellation(runId, threadId, assistantMessageId, accumulatedContent, eventSequence);
          return;
        }

        // If the model produced no tool calls, it finished its final answer
        if (roundToolCalls.length === 0) {
          break;
        }

        // If the model produced tool calls, process them
        let pausedForApproval = false;

        for (const tc of roundToolCalls) {
          // Check tool budget limit
          if (executedToolCallsCount >= ChatGenerationWorker.MAX_TOOL_CALLS) {
            accumulatedContent += "\n\n[Execution halted: Maximum tool execution limit (10) reached.]";
            break;
          }

          let parsedArgs: Record<string, unknown> = {};
          if (typeof tc.arguments === "string") {
            try {
              parsedArgs = JSON.parse(tc.arguments);
            } catch {
              parsedArgs = { raw: tc.arguments };
            }
          } else if (tc.arguments && typeof tc.arguments === "object") {
            parsedArgs = tc.arguments as Record<string, unknown>;
          }

          // Repetition guard: detect identical consecutive tool calls
          const fingerprint = `${tc.toolName}:${JSON.stringify(parsedArgs)}`;
          if (fingerprint === lastToolFingerprint) {
            consecutiveDuplicateCount++;
            if (consecutiveDuplicateCount >= 3) {
              accumulatedContent += "\n\n[Execution halted: Repetitive tool loop detected.]";
              break;
            }
          } else {
            consecutiveDuplicateCount = 0;
            lastToolFingerprint = fingerprint;
          }

          // Resolve tool mapping
          const mapping = mappings.get(tc.toolName);
          if (!mapping) {
            const unknownMsg = `Tool '${tc.toolName}' is not recognized or available in this workspace.`;
            conversationHistory.push({
              role: "assistant",
              toolCalls: [{ providerCallId: tc.callId, toolName: tc.toolName, arguments: parsedArgs }],
            });
            conversationHistory.push({
              role: "tool",
              toolCallId: tc.callId,
              toolName: tc.toolName,
              content: unknownMsg,
              toolResults: [{ providerCallId: tc.callId, toolName: tc.toolName, result: unknownMsg, isError: true }],
            });
            continue;
          }

          // Evaluate authorization
          const decision = this.authService.evaluateToolCall({
            workspaceId: data.workspaceId,
            threadId,
            userId: data.userId,
            userRole,
            toolName: mapping.originalToolName,
            permissionMode: mapping.permissionMode,
            isReadOnly: mapping.isReadOnly,
            arguments: parsedArgs,
          });

          if (decision.status === "DENIED") {
            const deniedMsg = `Tool execution denied by policy: ${decision.reason}`;
            conversationHistory.push({
              role: "assistant",
              toolCalls: [{ providerCallId: tc.callId, toolName: tc.toolName, arguments: parsedArgs }],
            });
            conversationHistory.push({
              role: "tool",
              toolCallId: tc.callId,
              toolName: tc.toolName,
              content: deniedMsg,
              toolResults: [{ providerCallId: tc.callId, toolName: tc.toolName, result: deniedMsg, isError: true }],
            });
            continue;
          }

          if (decision.status === "REQUIRE_APPROVAL") {
            // Check if already approved
            const existingApproval = await prisma.toolCall.findFirst({
              where: {
                generationRunId: runId,
                providerCallId: tc.callId,
                status: "APPROVED",
              },
            });

            if (!existingApproval) {
              // Pause execution and create pending approval record
              await prisma.message.update({
                where: { id: assistantMessageId },
                data: { content: accumulatedContent },
              });

              const toolCallRecord = await prisma.toolCall.create({
                data: {
                  generationRunId: runId,
                  threadId,
                  workspaceId: data.workspaceId,
                  toolDefinitionId: mapping.toolDefinitionId,
                  connectionId: mapping.connectionId,
                  providerCallId: tc.callId,
                  providerToolAlias: tc.toolName,
                  toolName: mapping.originalToolName,
                  schemaHash: mapping.schemaHash,
                  argumentsHash: computeArgumentsHash(parsedArgs),
                  argumentsPreview: parsedArgs as any,
                  status: "AWAITING_APPROVAL",
                },
              });

              const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
              const approvalRecord = await prisma.toolApproval.create({
                data: {
                  toolCallId: toolCallRecord.id,
                  workspaceId: data.workspaceId,
                  requestedByUserId: data.userId,
                  status: "PENDING",
                  argumentsHash: toolCallRecord.argumentsHash,
                  schemaHash: toolCallRecord.schemaHash,
                  expiresAt,
                },
              });

              await prisma.generationRun.update({
                where: { id: runId },
                data: { status: "AWAITING_APPROVAL" },
              });

              await this.publishEvent(threadId, {
                type: "tool.approval_requested",
                threadId,
                runId,
                messageId: tc.callId,
                sequence: eventSequence++,
                timestamp: new Date().toISOString(),
                payload: {
                  toolCall: {
                    id: toolCallRecord.id,
                    providerCallId: tc.callId,
                    toolName: mapping.originalToolName,
                    providerToolAlias: tc.toolName,
                    argumentsPreview: parsedArgs,
                    status: "AWAITING_APPROVAL",
                  },
                  toolApproval: {
                    id: approvalRecord.id,
                    toolCallId: toolCallRecord.id,
                    workspaceId: data.workspaceId,
                    requestedByUserId: data.userId,
                    status: "PENDING",
                    expiresAt: expiresAt.toISOString(),
                  },
                },
              });

              pausedForApproval = true;
              break; // Break inner loop and exit processJob cleanly!
            }
          }

          // Execute tool (ALLOWED or pre-approved)
          await this.publishEvent(threadId, {
            type: "tool.executing",
            threadId,
            runId,
            messageId: tc.callId,
            sequence: eventSequence++,
            timestamp: new Date().toISOString(),
            payload: {
              toolCall: {
                providerCallId: tc.callId,
                toolName: mapping.originalToolName,
                providerToolAlias: tc.toolName,
                status: "EXECUTING",
              },
            },
          });

          const outcome = await workerToolExecutor.executeTool(
            data.workspaceId,
            mapping.connectionId,
            mapping.originalToolName,
            mapping.inputSchema,
            mapping.schemaHash,
            parsedArgs
          );

          executedToolCallsCount++;

          const createdToolCall = await prisma.toolCall.create({
            data: {
              generationRunId: runId,
              threadId,
              workspaceId: data.workspaceId,
              toolDefinitionId: mapping.toolDefinitionId,
              connectionId: mapping.connectionId,
              providerCallId: tc.callId,
              providerToolAlias: tc.toolName,
              toolName: mapping.originalToolName,
              schemaHash: mapping.schemaHash,
              argumentsHash: computeArgumentsHash(parsedArgs),
              argumentsPreview: parsedArgs as any,
              status: outcome.status,
              result: outcome.result as any,
              isError: outcome.isError,
              errorMessage: outcome.errorMessage || null,
              durationMs: outcome.durationMs,
              completedAt: new Date(),
            },
          });

          await this.publishEvent(threadId, {
            type:
              outcome.status === "UNKNOWN_OUTCOME"
                ? "tool.unknown_outcome"
                : outcome.isError
                ? "tool.failed"
                : "tool.completed",
            threadId,
            runId,
            messageId: tc.callId,
            sequence: eventSequence++,
            timestamp: new Date().toISOString(),
            payload: {
              toolCall: {
                id: createdToolCall.id,
                providerCallId: tc.callId,
                status: outcome.status,
                isError: outcome.isError,
                errorMessage: outcome.errorMessage,
                durationMs: outcome.durationMs,
              },
            },
          });

          // Append to conversation history for next model turn
          conversationHistory.push({
            role: "assistant",
            toolCalls: [{ providerCallId: tc.callId, toolName: tc.toolName, arguments: parsedArgs }],
          });

          conversationHistory.push({
            role: "tool",
            toolCallId: tc.callId,
            toolName: tc.toolName,
            content: outcome.sanitizedText,
            toolResults: [{ providerCallId: tc.callId, toolName: tc.toolName, result: outcome.result, isError: outcome.isError }],
          });
        }

        if (pausedForApproval) {
          // Worker job exits cleanly without blocking!
          return;
        }
      }

      if (abortSignal.aborted) {
        await this.handleCancellation(runId, threadId, assistantMessageId, accumulatedContent, eventSequence);
        return;
      }

      // Normal completion
      const completedAt = new Date();
      await prisma.$transaction([
        prisma.message.update({
          where: { id: assistantMessageId },
          data: {
            content: accumulatedContent,
            status: "COMPLETED",
            completedAt,
          },
        }),
        prisma.generationRun.update({
          where: { id: runId },
          data: {
            status: "COMPLETED",
            completedAt,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            cachedInputTokens: totalCachedTokens,
            providerResponseId: responseId,
          },
        }),
      ]);

      await this.publishEvent(threadId, {
        type: "message.snapshot",
        threadId,
        runId,
        messageId: assistantMessageId,
        sequence: eventSequence++,
        timestamp: completedAt.toISOString(),
        payload: {
          content: accumulatedContent,
          status: "COMPLETED",
        },
      });

      await this.publishEvent(threadId, {
        type: "run.completed",
        threadId,
        runId,
        messageId: assistantMessageId,
        sequence: eventSequence++,
        timestamp: completedAt.toISOString(),
        payload: {
          status: "COMPLETED",
          usage: {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            cachedInputTokens: totalCachedTokens,
            totalTokens: totalInputTokens + totalOutputTokens,
          },
        },
      });
    } catch (err: unknown) {
      console.error(`[ChatGenerationWorker] Generation error for run ${runId}:`, err);
      const safeErrorCode = err instanceof Error ? err.name : "UNKNOWN_ERROR";
      const safeMessage = err instanceof Error ? err.message : "Generation failed";

      const failedAt = new Date();
      await prisma.$transaction([
        prisma.message.update({
          where: { id: assistantMessageId },
          data: {
            content: accumulatedContent,
            status: "FAILED",
            completedAt: failedAt,
          },
        }),
        prisma.generationRun.update({
          where: { id: runId },
          data: {
            status: "FAILED",
            safeErrorCode,
            completedAt: failedAt,
          },
        }),
      ]).catch(() => {});

      await this.publishEvent(threadId, {
        type: "run.failed",
        threadId,
        runId,
        messageId: assistantMessageId,
        sequence: eventSequence++,
        timestamp: failedAt.toISOString(),
        payload: {
          status: "FAILED",
          error: {
            code: safeErrorCode,
            message: safeMessage,
          },
        },
      });
    } finally {
      this.cancellationSub.deregister(runId);
    }
  }

  private async handleCancellation(
    runId: string,
    threadId: string,
    assistantMessageId: string,
    accumulatedContent: string,
    eventSequence: number
  ): Promise<void> {
    const cancelledAt = new Date();
    await prisma.$transaction([
      prisma.message.update({
        where: { id: assistantMessageId },
        data: {
          content: accumulatedContent,
          status: "CANCELLED",
          completedAt: cancelledAt,
        },
      }),
      prisma.generationRun.update({
        where: { id: runId },
        data: {
          status: "CANCELLED",
          completedAt: cancelledAt,
          safeErrorCode: "USER_CANCELLED",
        },
      }),
    ]).catch(() => {});

    await this.publishEvent(threadId, {
      type: "run.cancelled",
      threadId,
      runId,
      messageId: assistantMessageId,
      sequence: eventSequence,
      timestamp: cancelledAt.toISOString(),
      payload: { status: "CANCELLED", content: accumulatedContent },
    });
  }

  public async close(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
    if (this.redisPublisher) {
      await this.redisPublisher.quit().catch(() => {});
      this.redisPublisher = null;
    }
    await this.cancellationSub.close();
  }
}
