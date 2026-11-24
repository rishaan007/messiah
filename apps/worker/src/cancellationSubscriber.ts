import { Redis } from "ioredis";

export class WorkerCancellationSubscriber {
  private subscriber: Redis | null = null;
  private activeControllers = new Map<string, AbortController>();

  constructor(redisUrl?: string) {
    if (redisUrl) {
      this.subscriber = new Redis(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: null,
      });
    }
  }

  public async start(): Promise<void> {
    if (!this.subscriber) return;

    try {
      await this.subscriber.connect();
      // Listen to all messiah:cancel:* channels using psubscribe
      await this.subscriber.psubscribe("messiah:cancel:*");

      this.subscriber.on("pmessage", (_pattern, channel) => {
        const runId = channel.replace("messiah:cancel:", "");
        const controller = this.activeControllers.get(runId);
        if (controller) {
          console.log(`[WorkerCancellation] Aborting active generation for run ${runId}`);
          controller.abort();
          this.activeControllers.delete(runId);
        }
      });
    } catch (err) {
      console.warn("[WorkerCancellation] Failed to start Redis cancellation subscriber:", err);
    }
  }

  public register(runId: string): AbortSignal {
    const controller = new AbortController();
    this.activeControllers.set(runId, controller);
    return controller.signal;
  }

  public deregister(runId: string): void {
    this.activeControllers.delete(runId);
  }

  public async close(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.quit().catch(() => {});
      this.subscriber = null;
    }
  }
}
