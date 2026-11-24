import { Queue, type ConnectionOptions } from "bullmq";
import { prisma } from "@messiah/db";

export const CHAT_GENERATION_QUEUE_NAME = "messiah-chat-generation";

export interface GenerationJobPayload {
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

export class ChatQueueManager {
  private queue: Queue<GenerationJobPayload> | null = null;

  public initialize(redisUrl: string): Queue<GenerationJobPayload> {
    if (this.queue) {
      return this.queue;
    }

    // Parse Redis connection options for BullMQ
    const parsedUrl = new URL(redisUrl);
    const connection: ConnectionOptions = {
      host: parsedUrl.hostname,
      port: Number(parsedUrl.port) || 6379,
      password: parsedUrl.password || undefined,
      maxRetriesPerRequest: null, // Required by BullMQ
    };

    this.queue = new Queue<GenerationJobPayload>(CHAT_GENERATION_QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        // Strict: 0 retries on external LLM calls to prevent duplicate token charges and duplicate billing!
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: false,
      },
    });

    return this.queue;
  }

  public getQueue(): Queue<GenerationJobPayload> | null {
    return this.queue;
  }

  /**
   * Enqueues a generation run to BullMQ with deterministic jobId = runId (or optional jobIdOverride for resumed runs).
   * This guarantees deduplication at the queue level even if called multiple times.
   */
  public async enqueueRun(payload: GenerationJobPayload, jobIdOverride?: string): Promise<boolean> {
    if (!this.queue) {
      return false;
    }

    try {
      await this.queue.add("generate", payload, {
        jobId: jobIdOverride || payload.runId, // Deterministic Job ID prevents duplicate execution
      });

      // If outbox event ID is provided, mark it as PROCESSED
      if (payload.outboxEventId) {
        await prisma.outboxEvent.update({
          where: { id: payload.outboxEventId },
          data: {
            status: "PROCESSED",
            processedAt: new Date(),
          },
        }).catch(() => {});
      }

      return true;
    } catch (err) {
      console.warn(`[ChatQueueManager] Failed to enqueue job for run ${payload.runId}:`, err);
      return false;
    }
  }

  /**
   * Outbox Sweeper: Finds any PENDING outbox events and dispatches them to BullMQ.
   */
  public async sweepOutbox(): Promise<number> {
    if (!this.queue) {
      return 0;
    }

    try {
      const pendingEvents = await prisma.outboxEvent.findMany({
        where: {
          status: "PENDING",
          eventType: { in: ["generation.dispatch", "generation.resume"] },
        },
        orderBy: { createdAt: "asc" },
        take: 50,
      });

      let dispatchedCount = 0;
      for (const event of pendingEvents) {
        const payload = event.payload as unknown as GenerationJobPayload;
        payload.outboxEventId = event.id;

        const jobId = event.eventType === "generation.resume"
          ? `${payload.runId}-resume-${event.id}`
          : payload.runId;

        const success = await this.enqueueRun(payload, jobId);
        if (success) {
          dispatchedCount++;
        }
      }

      return dispatchedCount;
    } catch (err) {
      console.error("[ChatQueueManager] Error during outbox sweep:", err);
      return 0;
    }
  }

  public async close(): Promise<void> {
    if (this.queue) {
      await this.queue.close();
      this.queue = null;
    }
  }
}

export const chatQueueManager = new ChatQueueManager();
