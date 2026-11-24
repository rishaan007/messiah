import type { Redis } from "ioredis";

export interface DevicePresenceMetadata {
  connectedAt: string;
  lastHeartbeatAt: string;
  ipAddress?: string;
  userAgent?: string;
  platform?: string;
}

export class DevicePresenceService {
  private redis: Redis | null = null;
  private localPresence = new Map<string, { metadata: DevicePresenceMetadata; expiresAt: number }>();

  constructor(redis?: Redis) {
    if (redis) {
      this.redis = redis;
    }
  }

  public setRedis(redis: Redis): void {
    this.redis = redis;
  }

  private getKey(deviceId: string): string {
    return `messiah:device:presence:${deviceId}`;
  }

  private getRevocationChannel(deviceId: string): string {
    return `messiah:device:revoked:${deviceId}`;
  }

  private getDisconnectChannel(deviceId: string): string {
    return `messiah:device:disconnect:${deviceId}`;
  }

  public async setDeviceOnline(
    deviceId: string,
    metadata: DevicePresenceMetadata,
    ttlSeconds = 45
  ): Promise<void> {
    if (this.redis) {
      const key = this.getKey(deviceId);
      await this.redis.set(key, JSON.stringify(metadata), "EX", ttlSeconds);
    } else {
      this.localPresence.set(deviceId, {
        metadata,
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
    }
  }

  public async refreshHeartbeat(deviceId: string, ttlSeconds = 45): Promise<boolean> {
    if (this.redis) {
      const key = this.getKey(deviceId);
      const res = await this.redis.expire(key, ttlSeconds);
      return res === 1;
    } else {
      const current = this.localPresence.get(deviceId);
      if (current && current.expiresAt > Date.now()) {
        current.metadata.lastHeartbeatAt = new Date().toISOString();
        current.expiresAt = Date.now() + ttlSeconds * 1000;
        return true;
      }
      return false;
    }
  }

  public async setDeviceOffline(deviceId: string): Promise<void> {
    if (this.redis) {
      const key = this.getKey(deviceId);
      await this.redis.del(key);
    } else {
      this.localPresence.delete(deviceId);
    }
  }

  public async isDeviceOnline(deviceId: string): Promise<boolean> {
    if (this.redis) {
      const key = this.getKey(deviceId);
      const exists = await this.redis.exists(key);
      return exists === 1;
    } else {
      const current = this.localPresence.get(deviceId);
      if (!current) return false;
      if (current.expiresAt <= Date.now()) {
        this.localPresence.delete(deviceId);
        return false;
      }
      return true;
    }
  }

  public async publishRevoke(deviceId: string, reason = "Device revoked by administrator"): Promise<void> {
    await this.setDeviceOffline(deviceId);
    if (this.redis) {
      await this.redis.publish(this.getRevocationChannel(deviceId), JSON.stringify({ deviceId, reason }));
    }
  }

  public async publishDisconnect(deviceId: string, reason = "Device paused by administrator"): Promise<void> {
    await this.setDeviceOffline(deviceId);
    if (this.redis) {
      await this.redis.publish(this.getDisconnectChannel(deviceId), JSON.stringify({ deviceId, reason }));
    }
  }
}

export const devicePresenceService = new DevicePresenceService();
