import crypto from "node:crypto";
import { prisma } from "@messiah/db";
import { TASK_CONSTANTS, type DeviceTaskCancelFrame } from "@messiah/shared";
import { workspaceService } from "../workspaceService.js";
import { devicePresenceService } from "./devicePresenceService.js";
import { deviceConnectionGateway } from "./deviceConnectionGateway.js";
import { taskAuthorizationService } from "./taskAuthorizationService.js";
import { chatQueueManager } from "../chat/chatQueue.js";

export class DeviceTaskError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "DeviceTaskError";
  }
}

export class DeviceTaskService {
  /**
   * Creates a new bridge task, binds immutable execution parameters & MCP metadata,
   * signs with the target device's unique HMAC key, and dispatches over WebSocket.
   */
  public async createAndDispatchTask(params: {
    workspaceId: string;
    userId: string;
    deviceId: string;
    capability: string;
    resourceScopes: string[];
    parameters: Record<string, unknown>;
    threadId?: string;
    generationRunId?: string;
    agentRunId?: string;
    agentTaskId?: string;
    workflowRunId?: string;
    workflowNodeExecId?: string;
  }) {
    const isMember = await workspaceService.isUserMember(params.workspaceId, params.userId);
    if (!isMember) {
      throw new DeviceTaskError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }

    const device = await prisma.bridgeDevice.findUnique({
      where: { id: params.deviceId },
    });

    if (!device || device.workspaceId !== params.workspaceId) {
      throw new DeviceTaskError(404, "DEVICE_NOT_FOUND", "Target bridge device not found in workspace.");
    }

    if (device.status !== "ACTIVE") {
      throw new DeviceTaskError(400, "DEVICE_NOT_ACTIVE", `Device is in ${device.status} status and cannot execute tasks.`);
    }

    const isOnline =
      (await devicePresenceService.isDeviceOnline(device.id)) ||
      deviceConnectionGateway.isDeviceConnected(device.id);

    if (!isOnline) {
      throw new DeviceTaskError(400, "DEVICE_OFFLINE", "Device is currently offline. Cannot dispatch task.");
    }

    if (device.capabilities && device.capabilities.length > 0) {
      if (!device.capabilities.includes(params.capability)) {
        throw new DeviceTaskError(
          400,
          "CAPABILITY_NOT_SUPPORTED",
          `Device does not support requested capability: ${params.capability}`
        );
      }
    }

    const policy = device.devicePolicy as Record<string, unknown> | null;
    if (policy) {
      if (
        (params.capability.startsWith("process.") || params.capability.startsWith("agent.")) &&
        policy.terminalExecutionEnabled === false
      ) {
        throw new DeviceTaskError(
          403,
          "TERMINAL_EXECUTION_DISABLED",
          "Terminal and process execution is disabled by device security policy."
        );
      }
    }

    // Resolve and bind MCP server identity / schema hash if capability is mcp.invoke
    let mcpServerName: string | undefined;
    let mcpSchemaHash: string | undefined;
    let executableIdentity: string | undefined;

    if (params.capability === "mcp.invoke") {
      const serverNameParam = String(params.parameters?.serverName || "");
      const mcpServer = await prisma.bridgeLocalMcpServer.findUnique({
        where: { deviceId_serverName: { deviceId: params.deviceId, serverName: serverNameParam } },
      });
      if (!mcpServer || mcpServer.workspaceId !== params.workspaceId) {
        throw new DeviceTaskError(404, "MCP_SERVER_NOT_FOUND", `Local MCP server '${serverNameParam}' is not registered.`);
      }
      if (mcpServer.status !== "ACTIVE") {
        throw new DeviceTaskError(400, "MCP_SERVER_INACTIVE", `Local MCP server '${serverNameParam}' is ${mcpServer.status}.`);
      }
      if (mcpServer.schemaDriftDetected) {
        throw new DeviceTaskError(
          409,
          "MCP_SCHEMA_DRIFT",
          `Local MCP server '${serverNameParam}' tool schema changed since last approval. Re-confirmation required.`
        );
      }
      mcpServerName = mcpServer.serverName;
      mcpSchemaHash = mcpServer.approvedSchemaHash || mcpServer.schemaHash || undefined;
      executableIdentity = mcpServer.pinnedExecutableSha256 || mcpServer.pinnedExecutablePath || mcpServer.command;
    } else if (params.capability === "process.run") {
      executableIdentity = String(params.parameters?.executable || "");
    }

    const serializedParams = JSON.stringify(params.parameters);
    const argumentsHash = crypto.createHash("sha256").update(serializedParams).digest("hex");
    const expiresAt = new Date(Date.now() + TASK_CONSTANTS.DEFAULT_TIMEOUT_MS);

    const task = await prisma.bridgeTask.create({
      data: {
        workspaceId: params.workspaceId,
        deviceId: params.deviceId,
        userId: params.userId,
        capability: params.capability,
        resourceScopes: params.resourceScopes,
        parameters: params.parameters as any,
        argumentsHash,
        expiresAt,
        status: "DISPATCHED",
        threadId: params.threadId,
        generationRunId: params.generationRunId,
        agentRunId: params.agentRunId,
        agentTaskId: params.agentTaskId,
        workflowRunId: params.workflowRunId,
        workflowNodeExecId: params.workflowNodeExecId,
      },
    });

    const signedEnvelope = await taskAuthorizationService.createSignedTaskEnvelope({
      taskId: task.id,
      deviceId: params.deviceId,
      workspaceId: params.workspaceId,
      capability: params.capability,
      resourceScopes: params.resourceScopes,
      parameters: params.parameters,
      mcpServerName,
      mcpSchemaHash,
      executableIdentity,
    });

    const sent = deviceConnectionGateway.sendToDevice(params.deviceId, signedEnvelope);
    if (!sent) {
      await prisma.bridgeTask.update({
        where: { id: task.id },
        data: {
          status: "FAILED",
          errorMessage: "Failed to dispatch task frame. Device connection dropped.",
        },
      });
      throw new DeviceTaskError(500, "DISPATCH_FAILED", "Failed to dispatch task over device connection.");
    }

    return task;
  }

  public async getTask(taskId: string, workspaceId: string, userId: string) {
    const isMember = await workspaceService.isUserMember(workspaceId, userId);
    if (!isMember) {
      throw new DeviceTaskError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }

    const task = await prisma.bridgeTask.findUnique({
      where: { id: taskId },
      include: {
        device: {
          select: {
            id: true,
            displayName: true,
            platform: true,
            architecture: true,
          },
        },
        approval: true,
      },
    });

    if (!task || task.workspaceId !== workspaceId) {
      throw new DeviceTaskError(404, "TASK_NOT_FOUND", "Task not found in this workspace.");
    }

    return task;
  }

  public async listTasks(workspaceId: string, deviceId: string | undefined, userId: string, limit = 50) {
    const isMember = await workspaceService.isUserMember(workspaceId, userId);
    if (!isMember) {
      throw new DeviceTaskError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }

    const where: { workspaceId: string; deviceId?: string } = { workspaceId };
    if (deviceId) {
      where.deviceId = deviceId;
    }

    return prisma.bridgeTask.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(limit, 100),
      include: {
        device: {
          select: {
            id: true,
            displayName: true,
            platform: true,
          },
        },
      },
    });
  }

  public async getTaskLogs(taskId: string, workspaceId: string, userId: string) {
    const isMember = await workspaceService.isUserMember(workspaceId, userId);
    if (!isMember) {
      throw new DeviceTaskError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }

    const task = await prisma.bridgeTask.findUnique({
      where: { id: taskId },
      select: { workspaceId: true },
    });

    if (!task || task.workspaceId !== workspaceId) {
      throw new DeviceTaskError(404, "TASK_NOT_FOUND", "Task not found in this workspace.");
    }

    return prisma.bridgeTaskLog.findMany({
      where: { taskId },
      orderBy: { sequence: "asc" },
    });
  }

  /**
   * Handles atomic single-use approval or rejection of a paused workstation operation.
   * Performs immutable binding verification, conditional updateMany lock, and OutboxEvent persistence
   * inside a single PostgreSQL ACID transaction.
   */
  public async handleApprovalDecision(
    taskId: string,
    workspaceId: string,
    userId: string,
    action: "approve" | "reject",
    rejectionReason?: string
  ) {
    const role = await workspaceService.getUserRole(workspaceId, userId);
    if (!role) {
      throw new DeviceTaskError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }
    if (role !== "OWNER" && role !== "ADMIN") {
      throw new DeviceTaskError(403, "FORBIDDEN_ROLE", "Only workspace OWNER or ADMIN can approve bridge task actions.");
    }

    const txResult = await prisma.$transaction(async (tx) => {
      const task = await tx.bridgeTask.findUnique({
        where: { id: taskId },
        include: { approval: true, device: true },
      });

      if (!task || task.workspaceId !== workspaceId) {
        throw new DeviceTaskError(404, "TASK_NOT_FOUND", "Task not found in this workspace.");
      }

      const pendingApproval = task.approval;
      if (!pendingApproval) {
        throw new DeviceTaskError(400, "NO_PENDING_APPROVAL", "Task has no approval record.");
      }
      if (pendingApproval.status !== "PENDING") {
        throw new DeviceTaskError(409, "ALREADY_DECIDED", `Approval was already ${pendingApproval.status}.`);
      }
      if (pendingApproval.expiresAt <= new Date()) {
        await tx.bridgeTaskApproval.updateMany({
          where: { id: pendingApproval.id, status: "PENDING" },
          data: { status: "EXPIRED" },
        });
        await tx.bridgeTask.updateMany({
          where: { id: task.id, status: "AWAITING_APPROVAL" },
          data: { status: "EXPIRED", errorMessage: "Approval request expired.", completedAt: new Date() },
        });
        throw new DeviceTaskError(400, "APPROVAL_EXPIRED", "Approval request has expired.");
      }

      // Immutable binding checks
      if (
        pendingApproval.deviceId !== task.deviceId ||
        pendingApproval.workspaceId !== task.workspaceId ||
        pendingApproval.argumentsHash !== task.argumentsHash
      ) {
        await tx.bridgeTaskApproval.updateMany({
          where: { id: pendingApproval.id, status: "PENDING" },
          data: { status: "EXPIRED" },
        });
        throw new DeviceTaskError(409, "APPROVAL_BINDING_MISMATCH", "Task parameters or target binding changed since approval creation.");
      }

      if (pendingApproval.capability && pendingApproval.capability !== task.capability) {
        throw new DeviceTaskError(409, "APPROVAL_BINDING_MISMATCH", "Capability changed since approval request.");
      }

      // If MCP execution, verify MCP server still exists and schema hash has not changed
      if (task.capability === "mcp.invoke" && pendingApproval.mcpServerName) {
        const mcpServer = await tx.bridgeLocalMcpServer.findUnique({
          where: { deviceId_serverName: { deviceId: task.deviceId, serverName: pendingApproval.mcpServerName } },
        });
        if (!mcpServer || mcpServer.status !== "ACTIVE" || mcpServer.schemaDriftDetected) {
          throw new DeviceTaskError(409, "MCP_SCHEMA_DRIFT", "Local MCP server state or schema drifted before approval.");
        }
        if (pendingApproval.mcpSchemaHash && mcpServer.schemaHash && mcpServer.schemaHash !== pendingApproval.mcpSchemaHash) {
          throw new DeviceTaskError(409, "MCP_SCHEMA_DRIFT", "Local MCP tool schema changed after approval request.");
        }
      }

      if (task.device.status !== "ACTIVE") {
        throw new DeviceTaskError(400, "DEVICE_NOT_ACTIVE", "Device is no longer active.");
      }

      // Atomic conditional consumption (single-use guarantee under concurrent races)
      const approvalUpdate = await tx.bridgeTaskApproval.updateMany({
        where: {
          id: pendingApproval.id,
          status: "PENDING",
          argumentsHash: task.argumentsHash,
          expiresAt: { gt: new Date() },
        },
        data: {
          status: action === "approve" ? "APPROVED" : "DENIED",
          decidedByUserId: userId,
          decidedAt: new Date(),
          rejectionReason: action === "reject" ? rejectionReason || "Rejected by administrator" : null,
        },
      });

      if (approvalUpdate.count !== 1) {
        throw new DeviceTaskError(409, "ALREADY_DECIDED", "Approval has already been decided or expired.");
      }

      const taskUpdate = await tx.bridgeTask.updateMany({
        where: { id: task.id, status: "AWAITING_APPROVAL" },
        data:
          action === "approve"
            ? { status: "DISPATCHED" }
            : {
                status: "FAILED",
                errorMessage: rejectionReason || "Operation rejected by administrator",
                completedAt: new Date(),
              },
      });

      if (taskUpdate.count !== 1) {
        throw new DeviceTaskError(409, "INVALID_TASK_STATE", "Task is no longer awaiting approval.");
      }

      // Create durable transactional OutboxEvent for dispatch
      const outboxEvent = await tx.outboxEvent.create({
        data: {
          eventType: action === "approve" ? "bridge.task.resume" : "bridge.task.cancel",
          aggregateType: "bridge_task",
          aggregateId: task.id,
          payload: {
            taskId: task.id,
            deviceId: task.deviceId,
            workspaceId: task.workspaceId,
            approvalReference: pendingApproval.id,
            decidedByUserId: userId,
            action,
            rejectionReason: rejectionReason || null,
          },
          status: "PENDING",
        },
      });

      const updatedTask = await tx.bridgeTask.findUniqueOrThrow({ where: { id: task.id } });
      return {
        updatedTask,
        pendingApproval,
        outboxEventId: outboxEvent.id,
      };
    });

    // Post-commit dispatch over active WSS gateway
    if (action === "approve") {
      const envelope = await taskAuthorizationService.createSignedTaskEnvelope({
        taskId: txResult.updatedTask.id,
        deviceId: txResult.updatedTask.deviceId,
        workspaceId: txResult.updatedTask.workspaceId,
        capability: txResult.updatedTask.capability,
        resourceScopes: txResult.updatedTask.resourceScopes,
        parameters: txResult.updatedTask.parameters as Record<string, unknown>,
        approvalReference: txResult.pendingApproval.id,
        mcpServerName: txResult.pendingApproval.mcpServerName || undefined,
        mcpSchemaHash: txResult.pendingApproval.mcpSchemaHash || undefined,
        executableIdentity: txResult.pendingApproval.executableIdentity || undefined,
      });

      const sent = deviceConnectionGateway.sendToDevice(txResult.updatedTask.deviceId, envelope);
      if (sent) {
        await prisma.outboxEvent.update({
          where: { id: txResult.outboxEventId },
          data: { status: "PROCESSED", processedAt: new Date() },
        }).catch(() => {});
      }
    } else {
      const cancelFrame: DeviceTaskCancelFrame = {
        type: "device.task.cancel",
        taskId: txResult.updatedTask.id,
        reason: rejectionReason || "Rejected by administrator",
      };
      const sent = deviceConnectionGateway.sendToDevice(txResult.updatedTask.deviceId, cancelFrame);
      if (sent) {
        await prisma.outboxEvent.update({
          where: { id: txResult.outboxEventId },
          data: { status: "PROCESSED", processedAt: new Date() },
        }).catch(() => {});
      }

      if (txResult.updatedTask.agentRunId) {
        const swarmOutbox = await prisma.outboxEvent.create({
          data: {
            eventType: "swarm.resume",
            aggregateType: "AgentRun",
            aggregateId: txResult.updatedTask.agentRunId,
            payload: {
              kind: "swarm.execute",
              runId: txResult.updatedTask.agentRunId,
              workspaceId,
              userId,
            },
            status: "PENDING",
          },
        });
        await prisma.agentRun.updateMany({
          where: { id: txResult.updatedTask.agentRunId, status: "AWAITING_APPROVAL" },
          data: { status: "PENDING" },
        });
        await chatQueueManager
          .enqueueSwarmRun(
            {
              kind: "swarm.execute",
              runId: txResult.updatedTask.agentRunId,
              workspaceId,
              userId,
              outboxEventId: swarmOutbox.id,
            },
            `swarm-${txResult.updatedTask.agentRunId}-bridge-deny-${swarmOutbox.id}`
          )
          .catch(() => {});
      }

      if (txResult.updatedTask.workflowRunId) {
        const wfOutbox = await prisma.outboxEvent.create({
          data: {
            eventType: "workflow.resume",
            aggregateType: "WorkflowRun",
            aggregateId: txResult.updatedTask.workflowRunId,
            payload: {
              kind: "workflow.execute",
              runId: txResult.updatedTask.workflowRunId,
              workspaceId,
              userId,
            },
            status: "PENDING",
          },
        });
        await prisma.workflowRun.updateMany({
          where: { id: txResult.updatedTask.workflowRunId, status: "AWAITING_APPROVAL" },
          data: { status: "RUNNING" },
        });
        await chatQueueManager
          .enqueueWorkflowRun(
            {
              kind: "workflow.execute",
              runId: txResult.updatedTask.workflowRunId,
              workspaceId,
              userId,
              outboxEventId: wfOutbox.id,
            },
            `workflow-${txResult.updatedTask.workflowRunId}-bridge-deny-${wfOutbox.id}`
          )
          .catch(() => {});
      }
    }

    return txResult.updatedTask;
  }

  /**
   * Requests cancellation of an active bridge task.
   * Transitions RUNNING/DISPATCHED/ACCEPTED tasks to CANCEL_REQUESTED (not CANCELLED)
   * until the Bridge confirms termination of the process tree.
   */
  public async cancelTask(taskId: string, workspaceId: string, userId: string, reason = "Cancelled by user") {
    const isMember = await workspaceService.isUserMember(workspaceId, userId);
    if (!isMember) {
      throw new DeviceTaskError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }

    const task = await prisma.bridgeTask.findUnique({
      where: { id: taskId },
    });

    if (!task || task.workspaceId !== workspaceId) {
      throw new DeviceTaskError(404, "TASK_NOT_FOUND", "Task not found in this workspace.");
    }

    if (
      task.status === "SUCCEEDED" ||
      task.status === "FAILED" ||
      task.status === "CANCELLED" ||
      task.status === "EXPIRED" ||
      task.status === "UNKNOWN_OUTCOME"
    ) {
      return task;
    }

    // If queued and never dispatched, safe to mark CANCELLED immediately
    if (task.status === "QUEUED") {
      return prisma.bridgeTask.update({
        where: { id: taskId },
        data: { status: "CANCELLED", errorMessage: reason, completedAt: new Date() },
      });
    }

    // Otherwise mark CANCEL_REQUESTED until Bridge confirms process tree termination
    const isOnline = deviceConnectionGateway.isDeviceConnected(task.deviceId);
    if (!isOnline && (task.status === "RUNNING" || task.status === "ACCEPTED")) {
      // Cannot reach device to terminate running side-effect operation -> UNKNOWN_OUTCOME
      return prisma.bridgeTask.update({
        where: { id: taskId },
        data: {
          status: "UNKNOWN_OUTCOME",
          errorMessage: "Device disconnected before cancellation could terminate running process.",
          completedAt: new Date(),
        },
      });
    }

    const updated = await prisma.bridgeTask.update({
      where: { id: taskId },
      data: {
        status: "CANCEL_REQUESTED",
        errorMessage: reason,
      },
    });

    const cancelFrame: DeviceTaskCancelFrame = {
      type: "device.task.cancel",
      taskId: task.id,
      reason,
    };
    deviceConnectionGateway.sendToDevice(task.deviceId, cancelFrame);

    return updated;
  }
}

export const deviceTaskService = new DeviceTaskService();
