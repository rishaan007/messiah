import { Worker, type ConnectionOptions, type Job } from "bullmq";
import { CHAT_GENERATION_QUEUE_NAME, type GenerationJobPayload } from "./chatQueue.js";
import { executionEngine } from "./executionEngine.js";

/**
 * BullMQ Worker Manager for MESSIAH chat generation.
 * Pulls jobs from queue 'messiah-chat-generation' with concurrency control,
 * delegates streaming execution to ExecutionEngine, and handles job lifecycles.
 */
export class ChatWorkerManager {
  private worker: Worker<GenerationJobPayload> | null = null;

  public start(redisUrl: string, concurrency = 5): Worker<GenerationJobPayload> {
    if (this.worker) {
      return this.worker;
    }

    const parsedUrl = new URL(redisUrl);
    const connection: ConnectionOptions = {
      host: parsedUrl.hostname,
      port: Number(parsedUrl.port) || 6379,
      password: parsedUrl.password || undefined,
      maxRetriesPerRequest: null,
    };

    this.worker = new Worker<GenerationJobPayload>(
      CHAT_GENERATION_QUEUE_NAME,
      async (job: Job<GenerationJobPayload>) => {
        await executionEngine.execute(job.data);
      },
      {
        connection,
        concurrency,
      }
    );

    this.worker.on("error", (err) => {
      console.error("[ChatWorker] Worker error:", err);
    });

    this.worker.on("failed", (job, err) => {
      console.error(`[ChatWorker] Job ${job?.id} failed:`, err);
    });

    return this.worker;
  }

  public getWorker(): Worker<GenerationJobPayload> | null {
    return this.worker;
  }

  public async close(): Promise<void> {
    if (this.worker) {
      await this.worker.close(true);
      this.worker = null;
    }
  }
}

export const chatWorkerManager = new ChatWorkerManager();
