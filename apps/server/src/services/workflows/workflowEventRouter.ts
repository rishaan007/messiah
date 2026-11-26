import crypto from "node:crypto";
import { prisma, Prisma } from "@messiah/db";
import { WORKFLOW_CONSTANTS, type WorkflowGraphDefinition } from "@messiah/shared";
import { chatQueueManager } from "../chat/chatQueue.js";

export interface DomainEventInput {
  workspaceId: string;
  eventType: string;
  dedupKey?: string;
  payload: Record<string, unknown>;
  sourceWorkflowId?: string | null;
  recursionDepth?: number;
  triggeredByUserId?: string | null;
}

function matchesFilterRules(
  rules: Record<string, unknown>,
  payload: Record<string, unknown>
): boolean {
  if (!rules || Object.keys(rules).length === 0) return true;
  for (const [k, expected] of Object.entries(rules)) {
    if (expected === undefined || expected === null || expected === "") continue;
    const actual = payload[k];
    if (String(actual ?? "") !== String(expected)) {
      return false;
    }
  }
  return true;
}

export class WorkflowEventRouter {
  /**
   * Emits an internal MESSIAH domain event to matching active workflow event triggers
   * with deduplication, cooldown enforcement, and self-trigger / recursion loop protection.
   */
  public async emitDomainEvent(input: DomainEventInput): Promise<{
    triggeredRunIds: string[];
    skippedReasons: string[];
  }> {
    const recursionDepth = input.recursionDepth ?? 0;
    if (recursionDepth >= WORKFLOW_CONSTANTS.MAX_RECURSION_DEPTH) {
      return {
        triggeredRunIds: [],
        skippedReasons: [`MAX_RECURSION_DEPTH_REACHED (${recursionDepth})`],
      };
    }

    const triggers = await prisma.workflowEventTrigger.findMany({
      where: {
        workspaceId: input.workspaceId,
        eventType: input.eventType,
        enabled: true,
        workflow: { status: "ACTIVE" },
      },
      include: {
        workflow: {
          include: {
            versions: { orderBy: { versionNumber: "desc" }, take: 1 },
          },
        },
      },
    });

    const triggeredRunIds: string[] = [];
    const skippedReasons: string[] = [];

    for (const trig of triggers) {
      // Loop prevention: do not allow a workflow completion event to directly re-trigger itself
      if (input.sourceWorkflowId && input.sourceWorkflowId === trig.workflowId) {
        skippedReasons.push(`${trig.workflow.slug}:BLOCKED_SELF_TRIGGER`);
        continue;
      }

      const activeVersion = trig.workflow.versions[0];
      if (!activeVersion) {
        skippedReasons.push(`${trig.workflow.slug}:NO_PUBLISHED_VERSION`);
        continue;
      }

      const filterRules = (trig.filterRules as Record<string, unknown>) || {};
      if (!matchesFilterRules(filterRules, input.payload)) {
        skippedReasons.push(`${trig.workflow.slug}:FILTER_MISMATCH`);
        continue;
      }

      // Enforce per-trigger cooldown
      if (trig.lastTriggeredAt && trig.cooldownSeconds > 0) {
        const elapsedSec = (Date.now() - trig.lastTriggeredAt.getTime()) / 1000;
        if (elapsedSec < trig.cooldownSeconds && !input.dedupKey) {
          skippedReasons.push(`${trig.workflow.slug}:COOLDOWN_ACTIVE`);
          continue;
        }
      }

      const dedupKey =
        input.dedupKey ||
        crypto
          .createHash("sha256")
          .update(
            JSON.stringify({
              triggerId: trig.id,
              eventType: input.eventType,
              payload: input.payload,
              bucket: Math.floor(Date.now() / Math.max(1000, trig.cooldownSeconds * 1000)),
            })
          )
          .digest("hex");

      try {
        const created = await prisma.$transaction(async (tx) => {
          // Unique [triggerId, dedupKey] enforces idempotency across duplicate event delivery
          await tx.workflowEventDispatchLog.create({
            data: {
              workspaceId: input.workspaceId,
              triggerId: trig.id,
              workflowId: trig.workflowId,
              eventType: input.eventType,
              dedupKey,
              status: "TRIGGERED",
            },
          });

          const graph = activeVersion.definitionJson as unknown as WorkflowGraphDefinition;
          const run = await tx.workflowRun.create({
            data: {
              workflowId: trig.workflowId,
              versionId: activeVersion.id,
              workspaceId: input.workspaceId,
              triggeredByUserId: input.triggeredByUserId || trig.workflow.createdByUserId || null,
              triggerType: "EVENT",
              triggerEventId: dedupKey,
              correlationId: input.sourceWorkflowId || null,
              sourceWorkflowId: input.sourceWorkflowId || null,
              recursionDepth: recursionDepth + 1,
              status: "PENDING",
              triggerPayload: input.payload as Prisma.InputJsonValue,
            },
          });

          await tx.workflowNodeExecution.createMany({
            data: graph.nodes.map((n) => ({
              runId: run.id,
              workflowId: trig.workflowId,
              workspaceId: input.workspaceId,
              nodeId: n.id,
              nodeType: n.type,
              title: n.title,
              status: "PENDING",
            })),
          });

          await tx.workflowEventTrigger.update({
            where: { id: trig.id },
            data: { lastTriggeredAt: new Date() },
          });

          await tx.workflowEventDispatchLog.updateMany({
            where: { triggerId: trig.id, dedupKey },
            data: { runId: run.id },
          });

          const outbox = await tx.outboxEvent.create({
            data: {
              eventType: "workflow.dispatch",
              aggregateType: "WorkflowRun",
              aggregateId: run.id,
              payload: {
                kind: "workflow.execute",
                runId: run.id,
                workspaceId: input.workspaceId,
                userId: input.triggeredByUserId || trig.workflow.createdByUserId || null,
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
              workspaceId: input.workspaceId,
              userId: input.triggeredByUserId || trig.workflow.createdByUserId || null,
              outboxEventId: created.outboxId,
            },
            `workflow-${created.run.id}`
          )
          .catch(() => {});

        triggeredRunIds.push(created.run.id);
      } catch (err: any) {
        if (err?.code === "P2002") {
          skippedReasons.push(`${trig.workflow.slug}:DUPLICATE_EVENT`);
          continue;
        }
        skippedReasons.push(
          `${trig.workflow.slug}:ERROR:${err instanceof Error ? err.message : "unknown"}`
        );
      }
    }

    return { triggeredRunIds, skippedReasons };
  }
}

export const workflowEventRouter = new WorkflowEventRouter();
