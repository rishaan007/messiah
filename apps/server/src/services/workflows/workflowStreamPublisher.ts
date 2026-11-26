import { EventEmitter } from "node:events";
import { Redis } from "ioredis";
import type { WorkflowStreamEvent } from "@messiah/shared";

/**
 * Distributed Workflow Stream Publisher bridging worker BullMQ execution events
 * over Redis Pub/Sub and local EventEmitter for WebSocket listeners.
 */
export class WorkflowStreamPublisher {
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
        if (!channel.startsWith("messiah:workflows:")) return;
        try {
          const event = JSON.parse(message) as WorkflowStreamEvent;
          this.localEmitter.emit(event.runId, event);
        } catch {}
      });
    }
  }

  public static getChannelName(runId: string): string {
    return `messiah:workflows:${runId}:events`;
  }

  public async publish(event: WorkflowStreamEvent): Promise<void> {
    this.localEmitter.emit(event.runId, event);

    if (this.publisherClient) {
      try {
        await this.publisherClient.publish(
          WorkflowStreamPublisher.getChannelName(event.runId),
          JSON.stringify(event)
        );
      } catch (err) {
        console.warn("[WorkflowStreamPublisher] Redis publish error:", err);
      }
    }
  }

  public onWorkflowEvent(
    runId: string,
    handler: (event: WorkflowStreamEvent) => void
  ): () => void {
    const channel = WorkflowStreamPublisher.getChannelName(runId);

    if (this.subscriberClient && !this.subscribedRuns.has(channel)) {
      this.subscribedRuns.add(channel);
      this.subscriberClient.subscribe(channel).catch(() => {});
    }

    this.localEmitter.on(runId, handler);

    return () => {
      this.localEmitter.off(runId, handler);
      if (
        this.localEmitter.listenerCount(runId) === 0 &&
        this.subscriberClient &&
        this.subscribedRuns.has(channel)
      ) {
        this.subscribedRuns.delete(channel);
        this.subscriberClient.unsubscribe(channel).catch(() => {});
      }
    };
  }
}

export const workflowStreamPublisher = new WorkflowStreamPublisher();
