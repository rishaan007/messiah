import crypto from "node:crypto";
import type { Redis } from "ioredis";

export interface TicketPayload {
  userId: string;
  workspaceId?: string;
  createdAt: number;
}

export class TicketService {
  private redis: Redis | null = null;
  // Local in-memory fallback cache for tests or when Redis is absent
  private localTickets = new Map<string, { payload: TicketPayload; expiresAt: number }>();

  constructor(redis?: Redis) {
    if (redis) {
      this.redis = redis;
    }
  }

  public setRedis(redis: Redis): void {
    this.redis = redis;
  }

  private hashTicket(rawTicket: string): string {
    return crypto.createHash("sha256").update(rawTicket).digest("hex");
  }

  /**
   * Generates a cryptographically secure, short-lived single-use ticket.
   * Returns plaintext ticket to client; stores only the SHA-256 hash.
   */
  public async createTicket(
    userId: string,
    workspaceId?: string,
    ttlSeconds = 30
  ): Promise<{ ticket: string; expiresInSeconds: number; expiresAt: string }> {
    const rawTicket = crypto.randomBytes(32).toString("hex");
    const ticketHash = this.hashTicket(rawTicket);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    const payload: TicketPayload = {
      userId,
      workspaceId,
      createdAt: Date.now(),
    };

    if (this.redis) {
      const key = `messiah:ws_ticket:${ticketHash}`;
      await this.redis.set(key, JSON.stringify(payload), "EX", ttlSeconds);
    } else {
      this.localTickets.set(ticketHash, {
        payload,
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
    }

    return {
      ticket: rawTicket,
      expiresInSeconds: ttlSeconds,
      expiresAt,
    };
  }

  /**
   * Atomically validates and consumes the single-use ticket.
   * Returns the ticket payload or null if invalid, expired, or already used.
   */
  public async consumeTicket(rawTicket: string): Promise<TicketPayload | null> {
    if (!rawTicket || typeof rawTicket !== "string" || rawTicket.length < 16) {
      return null;
    }

    const ticketHash = this.hashTicket(rawTicket);

    if (this.redis) {
      const key = `messiah:ws_ticket:${ticketHash}`;
      // Atomically retrieve and delete (GETDEL is supported in Redis 6.2+)
      let rawData: string | null = null;
      try {
        rawData = await (this.redis as any).getdel(key);
      } catch {
        // Fallback for older Redis versions
        rawData = await this.redis.get(key);
        if (rawData) {
          await this.redis.del(key);
        }
      }

      if (!rawData) {
        return null;
      }

      try {
        return JSON.parse(rawData) as TicketPayload;
      } catch {
        return null;
      }
    } else {
      const entry = this.localTickets.get(ticketHash);
      if (!entry) {
        return null;
      }

      // Immediately delete to guarantee single-use
      this.localTickets.delete(ticketHash);

      if (Date.now() > entry.expiresAt) {
        return null;
      }

      return entry.payload;
    }
  }
}

export const ticketService = new TicketService();
