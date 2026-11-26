import { prisma, Prisma } from "@messiah/db";
import type { WorkflowGraphDefinition } from "@messiah/shared";
import { CronExpressionEngine } from "@messiah/workflows";
import { chatQueueManager } from "../chat/chatQueue.js";

/**
 * Durable PostgreSQL-backed cron scheduler sweep.
 * Safe across restarts and concurrent workers via optimistic `nextRunAt` CAS claim.
 */
export class WorkflowSchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  public async sweepDueSchedules(now: Date = new Date()): Promise<{
    claimed: number;
    dispatchedRunIds: string[];
    skipped: string[];
  }> {
    if (this.isRunning) {
      return { claimed: 0, dispatchedRunIds: [], skipped: ["SWEEP_ALREADY_RUNNING"] };
    }
    this.isRunning = true;

    const dispatchedRunIds: string[] = [];
    const skipped: string[] = [];
    let claimed = 0;

    try {
      const dueSchedules = await prisma.workflowSchedule.findMany({
        where: {
          enabled: true,
          nextRunAt: { lte: now },
          workflow: { status: "ACTIVE" },
        },
        include: {
          workflow: {
            include: {
              versions: { orderBy: { versionNumber: "desc" }, take: 1 },
            },
          },
        },
        take: 25,
      });

      for (const sched of dueSchedules) {
        const dueAt = sched.nextRunAt;
        if (!dueAt) continue;

        const evalRes = CronExpressionEngine.evaluateMisfire({
          cronExpression: sched.cronExpression,
          timezone: sched.timezone,
          dueAt,
          now,
          misfirePolicy: sched.misfirePolicy,
        });

        // Optimistically claim this exact dueAt tick so concurrent workers never double-enqueue
        const casClaim = await prisma.workflowSchedule.updateMany({
          where: {
            id: sched.id,
            enabled: true,
            nextRunAt: dueAt,
          },
          data: {
            lastTriggeredAt: evalRes.fireCount > 0 ? now : sched.lastTriggeredAt,
            nextRunAt: evalRes.nextRunAt,
          },
        });

        if (casClaim.count === 0) {
          skipped.push(`${sched.workflow.slug}:CLAIMED_BY_ANOTHER_INSTANCE`);
          continue;
        }
        claimed++;

        if (evalRes.fireCount === 0) {
          skipped.push(`${sched.workflow.slug}:MISFIRE_SKIPPED`);
          continue;
        }

        const version = sched.versionId
          ? await prisma.workflowVersion.findUnique({ where: { id: sched.versionId } })
          : sched.workflow.versions[0];

        if (!version) {
          skipped.push(`${sched.workflow.slug}:NO_PUBLISHED_VERSION`);
          continue;
        }

        // Enforce concurrency policy
        if (sched.concurrencyPolicy === "SKIP_IF_RUNNING") {
          const activeCount = await prisma.workflowRun.count({
            where: {
              workflowId: sched.workflowId,
              status: { in: ["PENDING", "RUNNING", "AWAITING_APPROVAL"] },
            },
          });
          if (activeCount > 0) {
            skipped.push(`${sched.workflow.slug}:CONCURRENT_RUN_ACTIVE`);
            continue;
          }
        } else if (sched.concurrencyPolicy === "REPLACE_QUEUED") {
          await prisma.workflowRun.updateMany({
            where: { workflowId: sched.workflowId, status: "PENDING" },
            data: {
              status: "CANCELLED",
              safeErrorCode: "REPLACED_BY_SCHEDULE",
              completedAt: now,
            },
          });
        }

        const fireCount = evalRes.fireCount;
        for (let tickIdx = 0; tickIdx < fireCount; tickIdx++) {
          const graph = version.definitionJson as unknown as WorkflowGraphDefinition;
          const payloadObj = {
            ...((sched.staticInput as Record<string, unknown>) || {}),
            scheduledFor: dueAt.toISOString(),
            catchUpIndex: tickIdx,
          };

          const created = await prisma.$transaction(async (tx) => {
            const run = await tx.workflowRun.create({
              data: {
                workflowId: sched.workflowId,
                versionId: version.id,
                workspaceId: sched.workspaceId,
                triggeredByUserId: sched.workflow.createdByUserId || null,
                triggerType: "SCHEDULE",
                triggerEventId: `sched-${sched.id}-${dueAt.getTime()}-${tickIdx}`,
                status: "PENDING",
                triggerPayload: payloadObj as Prisma.InputJsonValue,
              },
            });

            await tx.workflowNodeExecution.createMany({
              data: graph.nodes.map((n) => ({
                runId: run.id,
                workflowId: sched.workflowId,
                workspaceId: sched.workspaceId,
                nodeId: n.id,
                nodeType: n.type,
                title: n.title,
                status: "PENDING",
              })),
            });

            const outbox = await tx.outboxEvent.create({
              data: {
                eventType: "workflow.dispatch",
                aggregateType: "WorkflowRun",
                aggregateId: run.id,
                payload: {
                  kind: "workflow.execute",
                  runId: run.id,
                  workspaceId: sched.workspaceId,
                  userId: sched.workflow.createdByUserId || null,
                },
                status: "PENDING",
              },
            });

            return { run, outboxId: outbox.id };
          });

          await chatQueueManager
            .enqueueWorkflowRun(
              {
                kind: "workflow.execute",
                runId: created.run.id,
                workspaceId: sched.workspaceId,
                userId: sched.workflow.createdByUserId || null,
                outboxEventId: created.outboxId,
              },
              `workflow-${created.run.id}`
            )
            .catch(() => {});

          dispatchedRunIds.push(created.run.id);
        }
      }

      return { claimed, dispatchedRunIds, skipped };
    } finally {
      this.isRunning = false;
    }
  }

  public startPeriodicSweep(intervalMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sweepDueSchedules().catch((err) => {
        console.error("[WorkflowSchedulerService] Periodic sweep error:", err);
      });
    }, intervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const workflowSchedulerService = new WorkflowSchedulerService();
