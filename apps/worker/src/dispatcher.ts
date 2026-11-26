import { Queue, type ConnectionOptions } from "bullmq";
import { prisma } from "@messiah/db";

export const CHAT_GENERATION_QUEUE_NAME = "messiah-chat-generation";

export class OutboxDispatcher {
  private queue: Queue | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private isSweeping = false;

  constructor(redisUrl: string) {
    const parsedUrl = new URL(redisUrl);
    const connection: ConnectionOptions = {
      host: parsedUrl.hostname,
      port: Number(parsedUrl.port) || 6379,
      password: parsedUrl.password || undefined,
      maxRetriesPerRequest: null,
    };

    this.queue = new Queue(CHAT_GENERATION_QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 1, // 0 retries on external LLM calls!
        removeOnComplete: true,
        removeOnFail: false,
      },
    });
  }

  /**
   * Sweeps pending transactional outbox events and pushes them to BullMQ
   * with deterministic jobId = run.id (providing at-least-once delivery with idempotent downstream processing).
   */
  public async sweep(): Promise<number> {
    if (this.isSweeping || !this.queue) return 0;
    this.isSweeping = true;

    try {
      const pendingEvents = await prisma.outboxEvent.findMany({
        where: {
          status: "PENDING",
          eventType: { in: ["generation.dispatch", "generation.resume", "swarm.dispatch", "swarm.resume"] },
        },
        orderBy: { createdAt: "asc" },
        take: 50,
      });

      let dispatched = 0;
      for (const event of pendingEvents) {
        const payload = event.payload as Record<string, unknown>;
        const runId = String(payload.runId || event.aggregateId);

        if (event.eventType === "swarm.dispatch" || event.eventType === "swarm.resume") {
          try {
            await this.queue.add(
              "swarm.execute",
              { ...payload, kind: "swarm.execute", outboxEventId: event.id },
              {
                jobId:
                  event.eventType === "swarm.resume"
                    ? `swarm-${runId}-resume-${event.id}`
                    : `swarm-${runId}`,
              }
            );
            await prisma.outboxEvent.update({
              where: { id: event.id },
              data: { status: "PROCESSED", processedAt: new Date() },
            });
            dispatched++;
          } catch (jobErr) {
            console.warn(`[OutboxDispatcher] Error enqueueing swarm run ${runId}:`, jobErr);
          }
          continue;
        }

        try {
          await this.queue.add("generate", { ...payload, outboxEventId: event.id }, {
            jobId:
              event.eventType === "generation.resume"
                ? `${runId}-resume-${event.id}`
                : runId,
          });

          await prisma.outboxEvent.update({
            where: { id: event.id },
            data: {
              status: "PROCESSED",
              processedAt: new Date(),
            },
          });
          dispatched++;
        } catch (jobErr) {
          console.warn(`[OutboxDispatcher] Error enqueueing run ${runId}:`, jobErr);
        }
      }

      return dispatched;
    } catch (err) {
      console.error("[OutboxDispatcher] Error querying outbox events:", err);
      return 0;
    } finally {
      this.isSweeping = false;
    }
  }

  public startPeriodicSweep(intervalMs = 5000): void {
    if (this.intervalTimer) return;
    this.intervalTimer = setInterval(() => {
      this.sweep().catch((err) => {
        console.error("[OutboxDispatcher] Periodic sweep error:", err);
      });
    }, intervalMs);
  }

  public async close(): Promise<void> {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.queue) {
      await this.queue.close();
      this.queue = null;
    }
  }
}
