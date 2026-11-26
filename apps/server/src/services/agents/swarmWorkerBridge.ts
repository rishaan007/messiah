import { SwarmExecutionRuntime, type SwarmJobPayload } from "@messiah/agents";
import { prisma } from "@messiah/db";
import { VaultService, type EncryptedPayload } from "../vaultService.js";
import { streamPublisher } from "../chat/streamPublisher.js";
import { cancellationService } from "../chat/cancellationService.js";
import { deviceTaskService } from "../devices/deviceTaskService.js";
import { swarmStreamPublisher } from "./swarmStreamPublisher.js";
import { workflowEventRouter } from "../workflows/workflowEventRouter.js";
import { notificationService } from "../notifications/index.js";

const vaultService = new VaultService();

/**
 * Instantiates the server/embedded SwarmExecutionRuntime wired directly to MESSIAH's
 * encrypted VaultService, realtime stream publishers, cancellation registry, and Local Agent Bridge.
 */
export function createServerSwarmRuntime(): SwarmExecutionRuntime {
  return new SwarmExecutionRuntime({
    decryptProviderSecret: (input) =>
      vaultService.decrypt(
        {
          ciphertext: input.ciphertext,
          initializationVector: input.initializationVector,
          authenticationTag: input.authenticationTag,
          keyVersion: input.keyVersion,
        },
        {
          workspaceId: input.workspaceId,
          providerConnectionId: input.providerConnectionId,
          provider: input.provider,
          keyVersion: input.keyVersion,
        }
      ),
    decryptMcpSecret: (encryptedValue, context) => {
      const payload = JSON.parse(encryptedValue) as EncryptedPayload;
      return vaultService.decrypt(payload, {
        workspaceId: context.workspaceId,
        providerConnectionId: context.connectionId,
        provider: "mcp",
        keyVersion: context.keyVersion,
      });
    },
    publishEvent: async (event) => {
      await swarmStreamPublisher.publish(event);
      if (event.type === "swarm.run.awaiting_plan_approval") {
        notificationService
          .emitWorkspaceNotification({
            workspaceId: event.workspaceId,
            category: "SWARM_APPROVAL",
            title: "Swarm Execution Plan Ready for Approval",
            preview: "A multi-agent swarm plan is awaiting administrator sign-off before execution.",
            resourceType: "agent_run",
            resourceId: event.runId,
            deepLink: `/approvals?kind=SWARM_PLAN&id=${event.runId}`,
            dedupKey: `swarm-plan-${event.runId}`,
            approversOnly: true,
          })
          .catch(() => {});
      }
      if (
        event.type === "swarm.run.completed" ||
        event.type === "swarm.run.partial_completed" ||
        event.type === "swarm.run.failed"
      ) {
        const isFailure = event.type === "swarm.run.failed";
        const domainType = isFailure ? "swarm.failed" : "swarm.completed";
        notificationService
          .emitWorkspaceNotification({
            workspaceId: event.workspaceId,
            category: isFailure ? "AGENT_RUN_FAILED" : "AGENT_RUN_COMPLETED",
            title: isFailure ? "Agent Swarm Failed" : "Agent Swarm Completed",
            preview: String(
              (event.payload as Record<string, unknown>)?.finalSummary ||
                (event.payload as Record<string, unknown>)?.errorMessage ||
                `Swarm run finished (${event.type}).`
            ),
            resourceType: "agent_run",
            resourceId: event.runId,
            deepLink: `/swarms/${event.runId}`,
            dedupKey: `swarm-terminal-${event.runId}-${event.type}`,
          })
          .catch(() => {});
        workflowEventRouter
          .emitDomainEvent({
            workspaceId: event.workspaceId,
            eventType: domainType,
            dedupKey: `swarm-${event.runId}-${domainType}`,
            payload: {
              runId: event.runId,
              threadId: event.threadId || null,
              summary: String((event.payload as Record<string, unknown>)?.finalSummary || ""),
              status: event.type,
            },
          })
          .catch(() => {});
      }
    },
    publishThreadMessageUpdate: async ({ threadId, assistantMessageId, runId, status, content }) => {
      await prisma.message
        .update({
          where: { id: assistantMessageId },
          data: {
            content,
            status,
            completedAt: new Date(),
          },
        })
        .catch(() => {});

      await streamPublisher.publish({
        type: "message.snapshot",
        threadId,
        runId,
        messageId: assistantMessageId,
        sequence: 1,
        timestamp: new Date().toISOString(),
        payload: {
          content,
          status,
        },
      });
    },
    dispatchBridgeTask: async (params) => {
      const task = await deviceTaskService.createAndDispatchTask({
        workspaceId: params.workspaceId,
        userId: params.userId,
        deviceId: params.deviceId,
        capability: params.capability,
        resourceScopes: params.resourceScopes,
        parameters: params.parameters,
        threadId: params.threadId,
        agentRunId: params.agentRunId,
        agentTaskId: params.agentTaskId,
      });

      // Poll briefly (up to 15s) for fast read-only local ops; if AWAITING_APPROVAL or still running, return immediately so DAG scheduler pauses cleanly!
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const latest = await prisma.bridgeTask.findUnique({ where: { id: task.id } });
        if (!latest) break;
        if (
          latest.status === "SUCCEEDED" ||
          latest.status === "FAILED" ||
          latest.status === "AWAITING_APPROVAL" ||
          latest.status === "CANCELLED" ||
          latest.status === "UNKNOWN_OUTCOME" ||
          latest.status === "EXPIRED"
        ) {
          return {
            bridgeTaskId: latest.id,
            status: latest.status,
            result: latest.result,
            errorMessage: latest.errorMessage,
          };
        }
        await new Promise((r) => setTimeout(r, 250));
      }

      const current = await prisma.bridgeTask.findUnique({ where: { id: task.id } });
      return {
        bridgeTaskId: task.id,
        status: current?.status || task.status,
        result: current?.result || null,
        errorMessage: current?.errorMessage || null,
      };
    },
    isCancellationRequested: async (runId) => {
      return cancellationService.isCancelled(runId);
    },
  });
}

let sharedRuntime: SwarmExecutionRuntime | null = null;

export async function executeServerSwarmJob(payload: SwarmJobPayload): Promise<void> {
  if (!sharedRuntime) {
    sharedRuntime = createServerSwarmRuntime();
  }
  await sharedRuntime.processJob(payload);
}
