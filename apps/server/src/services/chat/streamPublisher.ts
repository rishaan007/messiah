import { EventEmitter } from "node:events";
import type { Redis } from "ioredis";
import type { MessiahStreamEvent } from "@messiah/shared";

export class StreamPublisher {
  private redis: Redis | null = null;
  private localEmitter = new EventEmitter();

  constructor(redis?: Redis) {
    if (redis) {
      this.redis = redis;
    }
  }

  public setRedis(redis: Redis): void {
    this.redis = redis;
  }

  public getChannel(threadId: string): string {
    return `messiah:threads:${threadId}:events`;
  }

  /**
   * Publishes a normalized Messiah stream event to Redis Pub/Sub and the local bus.
   */
  public async publish(event: MessiahStreamEvent): Promise<void> {
    const channel = this.getChannel(event.threadId);
    const serialized = JSON.stringify(event);

    // Always emit on local bus
    this.localEmitter.emit(channel, event);

    // If Redis is connected, publish to distributed channel
    if (this.redis) {
      try {
        await this.redis.publish(channel, serialized);
      } catch (err) {
        // Non-blocking: log and preserve local distribution
        console.warn(`[StreamPublisher] Failed to publish event to Redis channel ${channel}:`, err);
      }
    }
  }

  /**
   * Subscribes to local event notifications for testing or in-process listeners.
   */
  public onThreadEvent(
    threadId: string,
    listener: (event: MessiahStreamEvent) => void
  ): () => void {
    const channel = this.getChannel(threadId);
    this.localEmitter.on(channel, listener);
    return () => {
      this.localEmitter.off(channel, listener);
    };
  }
}

export const streamPublisher = new StreamPublisher();
