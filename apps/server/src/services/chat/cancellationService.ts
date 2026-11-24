import type { Redis } from "ioredis";

/**
 * Active generation run cancellation manager.
 * Stores local AbortControllers for generation runs and propagates cancellation signals
 * across workers via Redis Pub/Sub channel messiah:cancel:<runId>.
 */
export class CancellationService {
  private controllers = new Map<string, AbortController>();
  private redis: Redis | null = null;
  private subscriber: Redis | null = null;
  private activeSubscriptions = new Map<string, () => void>();

  public setRedis(redis: Redis, subscriber?: Redis): void {
    this.redis = redis;
    if (subscriber) {
      this.subscriber = subscriber;
    }
  }

  public register(runId: string): AbortSignal {
    const controller = new AbortController();
    this.controllers.set(runId, controller);

    // If distributed subscriber is available, listen to Redis cancellation channel
    if (this.subscriber) {
      const channel = `messiah:cancel:${runId}`;
      const messageHandler = (ch: string) => {
        if (ch === channel) {
          controller.abort();
          this.deregister(runId);
        }
      };
      this.subscriber.subscribe(channel).catch(() => {});
      this.subscriber.on("message", messageHandler);
      this.activeSubscriptions.set(runId, () => {
        if (this.subscriber) {
          this.subscriber.removeListener("message", messageHandler);
          this.subscriber.unsubscribe(channel).catch(() => {});
        }
      });
    }

    return controller.signal;
  }

  public async requestCancellation(runId: string): Promise<boolean> {
    const localCancelled = this.cancel(runId);

    // Propagate to distributed workers via Redis channel
    if (this.redis) {
      try {
        const channel = `messiah:cancel:${runId}`;
        await this.redis.publish(
          channel,
          JSON.stringify({ runId, timestamp: new Date().toISOString() })
        );
      } catch (err) {
        console.warn(`[CancellationService] Failed to publish cancellation to Redis:`, err);
      }
    }

    return localCancelled;
  }

  public cancel(runId: string): boolean {
    const controller = this.controllers.get(runId);
    if (controller) {
      controller.abort();
      this.deregister(runId);
      return true;
    }
    return false;
  }

  public deregister(runId: string): void {
    this.controllers.delete(runId);
    const cleanup = this.activeSubscriptions.get(runId);
    if (cleanup) {
      cleanup();
      this.activeSubscriptions.delete(runId);
    }
  }

  public isCancelled(runId: string): boolean {
    const controller = this.controllers.get(runId);
    return controller?.signal.aborted ?? false;
  }
}

export const cancellationService = new CancellationService();
