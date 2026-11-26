import { EventEmitter } from "node:events";
import type { Redis } from "ioredis";
import type { NotificationItemInfo } from "@messiah/shared";

export interface WorkspaceRealtimeNotificationEvent {
  type: "notification.created" | "approval.resolved" | "device.status_changed";
  workspaceId: string;
  recipientUserId?: string;
  notification?: NotificationItemInfo;
  payload?: Record<string, unknown>;
  timestamp: string;
}

class NotificationStreamPublisher {
  private emitter = new EventEmitter();
  private redisPub: Redis | null = null;
  private redisSub: Redis | null = null;
  private activeChannels = new Set<string>();

  constructor() {
    this.emitter.setMaxListeners(500);
  }

  public setRedis(redis: Redis): void {
    this.redisPub = redis;
    try {
      this.redisSub = redis.duplicate();
      this.redisSub.on("message", (channel: string, message: string) => {
        try {
          const parsed = JSON.parse(message) as WorkspaceRealtimeNotificationEvent;
          this.emitter.emit(channel, parsed);
        } catch {
          // Ignore malformed pub/sub frames
        }
      });
    } catch {
      this.redisSub = null;
    }
  }

  private getChannel(workspaceId: string): string {
    return `messiah:workspace:${workspaceId}:notifications`;
  }

  public async publish(event: WorkspaceRealtimeNotificationEvent): Promise<void> {
    const channel = this.getChannel(event.workspaceId);
    if (this.redisPub && this.redisPub.status === "ready") {
      try {
        await this.redisPub.publish(channel, JSON.stringify(event));
        return;
      } catch {
        // Fallback to local emitter
      }
    }
    this.emitter.emit(channel, event);
  }

  public onWorkspaceEvent(
    workspaceId: string,
    listener: (event: WorkspaceRealtimeNotificationEvent) => void
  ): () => void {
    const channel = this.getChannel(workspaceId);
    if (this.redisSub && !this.activeChannels.has(channel)) {
      this.activeChannels.add(channel);
      this.redisSub.subscribe(channel).catch(() => {});
    }

    this.emitter.on(channel, listener);
    return () => {
      this.emitter.off(channel, listener);
      if (this.emitter.listenerCount(channel) === 0 && this.redisSub && this.activeChannels.has(channel)) {
        this.activeChannels.delete(channel);
        this.redisSub.unsubscribe(channel).catch(() => {});
      }
    };
  }
}

export const notificationStreamPublisher = new NotificationStreamPublisher();
