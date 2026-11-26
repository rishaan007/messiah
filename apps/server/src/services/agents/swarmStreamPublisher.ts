import { EventEmitter } from "node:events";
import { Redis } from "ioredis";
import type { SwarmStreamEvent } from "@messiah/shared";

/**
 * Distributed Swarm Stream Publisher supporting multi-process BullMQ workers via Redis Pub/Sub
 * plus local EventEmitter fast-path inside the embedded server process.
 */
export class SwarmStreamPublisher {
  private localEmitter = new EventEmitter();
  private publisherClient: Redis | null = null;
  private subscriberClient: Redis | null = null;
  private subscribedRuns = new Set<string>();

  constructor() {
    this.localEmitter.setMaxListeners(500);
  }

  public setRedis(redis: Redis): void {
    this.publisherClient = redis;

    if (!this.subscriberClient) {
      this.subscriberClient = redis.duplicate();
      this.subscriberClient.on("message", (channel, message) => {
        if (!channel.startsWith("messiah:swarms:")) return;
        try {
          const event = JSON.parse(message) as SwarmStreamEvent;
          this.localEmitter.emit(event.runId, event);
        } catch {}
      });
    }
  }

  public static getChannelName(runId: string): string {
    return `messiah:swarms:${runId}:events`;
  }

  public async publish(event: SwarmStreamEvent): Promise<void> {
    this.localEmitter.emit(event.runId, event);

    if (this.publisherClient) {
      try {
        await this.publisherClient.publish(
          SwarmStreamPublisher.getChannelName(event.runId),
          JSON.stringify(event)
        );
      } catch (err) {
        console.warn("[SwarmStreamPublisher] Redis publish error:", err);
      }
    }
  }

  public onSwarmEvent(runId: string, handler: (event: SwarmStreamEvent) => void): () => void {
    const channel = SwarmStreamPublisher.getChannelName(runId);

    if (this.subscriberClient && !this.subscribedRuns.has(channel)) {
      this.subscribedRuns.add(channel);
      this.subscriberClient.subscribe(channel).catch(() => {});
    }

    this.localEmitter.on(runId, handler);

    return () => {
      this.localEmitter.off(runId, handler);
      if (this.localEmitter.listenerCount(runId) === 0 && this.subscriberClient && this.subscribedRuns.has(channel)) {
        this.subscribedRuns.delete(channel);
        this.subscriberClient.unsubscribe(channel).catch(() => {});
      }
    };
  }
}

export const swarmStreamPublisher = new SwarmStreamPublisher();
