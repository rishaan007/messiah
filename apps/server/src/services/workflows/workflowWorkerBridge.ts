import { prisma } from "@messiah/db";
import { WorkflowExecutionRuntime, type WorkflowJobPayload } from "@messiah/workflows";
import { VaultService, type EncryptedPayload } from "../vaultService.js";
import { cancellationService } from "../chat/cancellationService.js";
import { deviceTaskService } from "../devices/deviceTaskService.js";
import { workflowStreamPublisher } from "./workflowStreamPublisher.js";
import { workflowEventRouter } from "./workflowEventRouter.js";

let workflowVaultInstance: VaultService | null = null;
function getWorkflowVault(): VaultService {
  if (!workflowVaultInstance) {
    workflowVaultInstance = new VaultService();
  }
  return workflowVaultInstance;
}

export function createServerWorkflowRuntime(): WorkflowExecutionRuntime {
  return new WorkflowExecutionRuntime({
    decryptProviderSecret: (input) =>
      getWorkflowVault().decrypt(
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
      return getWorkflowVault().decrypt(payload, {
        workspaceId: context.workspaceId,
        providerConnectionId: context.connectionId,
        provider: "mcp",
        keyVersion: context.keyVersion,
      });
    },
    publishEvent: async (event) => {
      await workflowStreamPublisher.publish(event);
    },
    dispatchBridgeTask: async (params) => {
      const task = await deviceTaskService.createAndDispatchTask({
        workspaceId: params.workspaceId,
        userId: params.userId,
        deviceId: params.deviceId,
        capability: params.capability,
        resourceScopes: params.resourceScopes,
        parameters: params.parameters,
        workflowRunId: params.workflowRunId,
        workflowNodeExecId: params.workflowNodeExecId,
      });

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

      const finalCheck = await prisma.bridgeTask.findUnique({ where: { id: task.id } });
      return {
        bridgeTaskId: task.id,
        status: finalCheck?.status || task.status,
        result: finalCheck?.result,
        errorMessage: finalCheck?.errorMessage,
      };
    },
    isCancellationRequested: async (runId) => {
      if (cancellationService.isCancelled(runId)) return true;
      const r = await prisma.workflowRun.findUnique({
        where: { id: runId },
        select: { cancellationRequestedAt: true, status: true },
      });
      return Boolean(r?.cancellationRequestedAt || r?.status === "CANCELLED");
    },
    onWorkflowTerminal: async (params) => {
      const domainType =
        params.status === "COMPLETED" || params.status === "PARTIAL_COMPLETED"
          ? "workflow.completed"
          : params.status === "FAILED"
          ? "workflow.failed"
          : null;
      if (!domainType) return;

      await workflowEventRouter.emitDomainEvent({
        workspaceId: params.workspaceId,
        eventType: domainType,
        dedupKey: `wf-${params.runId}-${domainType}`,
        sourceWorkflowId: params.workflowId,
        recursionDepth: params.recursionDepth,
        triggeredByUserId: params.triggeredByUserId,
        payload: {
          runId: params.runId,
          workflowId: params.workflowId,
          status: params.status,
          summary: params.summary,
        },
      });
    },
  });
}

export async function executeServerWorkflowJob(payload: WorkflowJobPayload): Promise<void> {
  const runtime = createServerWorkflowRuntime();
  await runtime.processJob(payload);
}
