import { prisma } from "@messiah/db";
import { defaultProviderRegistry } from "@messiah/providers";
import { streamPublisher } from "./streamPublisher.js";
import { cancellationService } from "./cancellationService.js";
import { providerConnectionService } from "../providerConnectionService.js";
import { ContextBuilder } from "./contextBuilder.js";
import type { GenerationJobPayload } from "./chatQueue.js";

/**
 * Core generation execution engine.
 * Executed by BullMQ workers (or background tasks) to process generation runs safely and durably.
 */
export class GenerationExecutionEngine {
  public async execute(jobPayload: GenerationJobPayload): Promise<void> {
    const { runId, threadId, workspaceId, assistantMessageId, userMessageId, modelId, content, temperature, maxTokens, systemPrompt } = jobPayload;

    // Register cancellation controller & signal
    const abortSignal = cancellationService.register(runId);
    let eventSequence = 1;
    let accumulatedContent = "";
    let lastCheckpointContent = "";
    let lastCheckpointTime = Date.now();

    try {
      // 1. Verify run state and check if already claimed or finished
      const currentRun = await prisma.generationRun.findUnique({
        where: { id: runId },
      });

      if (!currentRun || currentRun.status !== "PENDING") {
        console.warn(`[ExecutionEngine] Run ${runId} is not in PENDING state (current: ${currentRun?.status}). Skipping duplicate execution.`);
        return;
      }

      // Check persisted cancellation state if Redis cancellation was missed
      if (currentRun.cancellationRequestedAt || abortSignal.aborted) {
        await this.handleCancellation(runId, threadId, assistantMessageId, accumulatedContent, eventSequence);
        return;
      }

      // 2. Atomically transition state to STREAMING and populate startedAt AT THIS TIME (never earlier)
      const nowStarted = new Date();
      const claimResult = await prisma.generationRun.updateMany({
        where: { id: runId, status: "PENDING" },
        data: {
          status: "STREAMING",
          startedAt: nowStarted,
        },
      });

      if (claimResult.count === 0) {
        console.warn(`[ExecutionEngine] Run ${runId} was already claimed by another worker. Skipping.`);
        return;
      }

      await prisma.message.update({
        where: { id: assistantMessageId },
        data: { status: "STREAMING" },
      });

      // 3. Publish run.started event
      await streamPublisher.publish({
        type: "run.started",
        threadId,
        runId,
        messageId: assistantMessageId,
        sequence: eventSequence++,
        timestamp: nowStarted.toISOString(),
        payload: { status: "STREAMING" },
      });

      // Check cancellation immediately
      if (abortSignal.aborted) {
        await this.handleCancellation(runId, threadId, assistantMessageId, accumulatedContent, eventSequence);
        return;
      }

      // 4. Decrypt credentials in transient memory using AAD binding
      const { apiKey, provider } = await providerConnectionService.getDecryptedKeyForInternalUse(
        currentRun.providerConnectionId,
        workspaceId
      );

      // 5. Retrieve conversation history for context building
      const priorMessages = await prisma.message.findMany({
        where: {
          threadId,
          id: { notIn: [userMessageId, assistantMessageId] },
        },
        orderBy: { sequence: "asc" },
      });

      const { messages: formattedHistory, systemPrompt: builtSystemPrompt } = ContextBuilder.buildHistory(
        priorMessages,
        content,
        { systemPrompt }
      );

      // 6. Get adapter from registry
      const adapter = defaultProviderRegistry.getAdapter(provider);

      // 7. Execute stream (Zero automatic SDK retries to prevent duplicate billing)
      const stream = adapter.streamResponse(
        {
          model: modelId,
          messages: formattedHistory,
          temperature,
          maxTokens,
          credentials: { apiKey },
          systemPrompt: builtSystemPrompt,
        },
        abortSignal
      );

      let inputTokens = 0;
      let outputTokens = 0;
      let cachedTokens = 0;
      let responseId: string | undefined;

      for await (const chunk of stream) {
        if (abortSignal.aborted) {
          break;
        }

        if (chunk.type === "text_delta") {
          accumulatedContent += chunk.text;

          // Publish real-time text delta
          await streamPublisher.publish({
            type: "message.delta",
            threadId,
            runId,
            messageId: assistantMessageId,
            sequence: eventSequence++,
            timestamp: new Date().toISOString(),
            payload: { delta: chunk.text },
          });

          // Periodic checkpoint to database (every 200 chars or 1.5 seconds)
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

            // Persisted cancellation state check:
            // In case the Redis Pub/Sub broadcast was missed due to network partition,
            // recover cancellation state directly from the database record!
            const persistedRun = await prisma.generationRun.findUnique({
              where: { id: runId },
              select: { cancellationRequestedAt: true, status: true },
            });
            if (persistedRun?.cancellationRequestedAt || persistedRun?.status === "CANCELLED") {
              break;
            }
          }
        } else if (chunk.type === "usage") {
          inputTokens = chunk.inputTokens;
          outputTokens = chunk.outputTokens;
          cachedTokens = chunk.cachedInputTokens || 0;

          await streamPublisher.publish({
            type: "usage.updated",
            threadId,
            runId,
            messageId: assistantMessageId,
            sequence: eventSequence++,
            timestamp: new Date().toISOString(),
            payload: {
              usage: {
                inputTokens,
                outputTokens,
                cachedInputTokens: cachedTokens,
                totalTokens: inputTokens + outputTokens,
              },
            },
          });
        } else if (chunk.type === "completed") {
          responseId = chunk.responseId;
        }
      }

      // 8. Handle Cancellation if triggered mid-stream
      if (abortSignal.aborted) {
        await this.handleCancellation(runId, threadId, assistantMessageId, accumulatedContent, eventSequence);
        return;
      }

      // 9. Normal Completion: Persist final content and usage
      const now = new Date();
      await prisma.$transaction([
        prisma.message.update({
          where: { id: assistantMessageId },
          data: {
            content: accumulatedContent,
            status: "COMPLETED",
            completedAt: now,
          },
        }),
        prisma.generationRun.update({
          where: { id: runId },
          data: {
            status: "COMPLETED",
            completedAt: now,
            inputTokens,
            outputTokens,
            cachedInputTokens: cachedTokens,
            providerResponseId: responseId,
          },
        }),
      ]);

      // 10. Publish completion & snapshot events
      await streamPublisher.publish({
        type: "message.snapshot",
        threadId,
        runId,
        messageId: assistantMessageId,
        sequence: eventSequence++,
        timestamp: now.toISOString(),
        payload: {
          content: accumulatedContent,
          status: "COMPLETED",
        },
      });

      await streamPublisher.publish({
        type: "run.completed",
        threadId,
        runId,
        messageId: assistantMessageId,
        sequence: eventSequence++,
        timestamp: now.toISOString(),
        payload: {
          status: "COMPLETED",
          usage: {
            inputTokens,
            outputTokens,
            cachedInputTokens: cachedTokens,
            totalTokens: inputTokens + outputTokens,
          },
        },
      });
    } catch (err: unknown) {
      console.error(`[ExecutionEngine] Generation failed for run ${runId}:`, err);
      const safeErrorCode = err instanceof Error ? err.name : "UNKNOWN_ERROR";
      const safeMessage = err instanceof Error ? err.message : "Generation failed";

      const now = new Date();
      await prisma.$transaction([
        prisma.message.update({
          where: { id: assistantMessageId },
          data: {
            content: accumulatedContent,
            status: "FAILED",
            completedAt: now,
          },
        }),
        prisma.generationRun.update({
          where: { id: runId },
          data: {
            status: "FAILED",
            safeErrorCode,
            completedAt: now,
          },
        }),
      ]).catch(() => {});

      await streamPublisher.publish({
        type: "run.failed",
        threadId,
        runId,
        messageId: assistantMessageId,
        sequence: eventSequence++,
        timestamp: now.toISOString(),
        payload: {
          status: "FAILED",
          error: {
            code: safeErrorCode,
            message: safeMessage,
          },
        },
      });
    } finally {
      cancellationService.deregister(runId);
    }
  }

  private async handleCancellation(
    runId: string,
    threadId: string,
    assistantMessageId: string,
    accumulatedContent: string,
    eventSequence: number
  ): Promise<void> {
    const now = new Date();
    await prisma.$transaction([
      prisma.message.update({
        where: { id: assistantMessageId },
        data: {
          content: accumulatedContent,
          status: "CANCELLED",
          completedAt: now,
        },
      }),
      prisma.generationRun.update({
        where: { id: runId },
        data: {
          status: "CANCELLED",
          completedAt: now,
          safeErrorCode: "USER_CANCELLED",
        },
      }),
    ]).catch(() => {});

    await streamPublisher.publish({
      type: "run.cancelled",
      threadId,
      runId,
      messageId: assistantMessageId,
      sequence: eventSequence,
      timestamp: now.toISOString(),
      payload: { status: "CANCELLED", content: accumulatedContent },
    });
  }
}

export const executionEngine = new GenerationExecutionEngine();
