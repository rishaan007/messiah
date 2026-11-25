import crypto from "node:crypto";
import { prisma } from "@messiah/db";
import { TASK_CONSTANTS, type DeviceTaskCancelFrame } from "@messiah/shared";
import { workspaceService } from "../workspaceService.js";
import { devicePresenceService } from "./devicePresenceService.js";
import { deviceConnectionGateway } from "./deviceConnectionGateway.js";
import { taskAuthorizationService } from "./taskAuthorizationService.js";

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
   * Creates a new bridge task, generates a cryptographic server authorization signature,
   * and dispatches it over WebSocket to the paired workstation.
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

    // Check capability whitelist if reported
    if (device.capabilities && device.capabilities.length > 0) {
      if (!device.capabilities.includes(params.capability)) {
        throw new DeviceTaskError(
          400,
          "CAPABILITY_NOT_SUPPORTED",
          `Device does not support requested capability: ${params.capability}`
        );
      }
    }

    // Check policy restrictions
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

    const serializedParams = JSON.stringify(params.parameters);
    const argumentsHash = crypto.createHash("sha256").update(serializedParams).digest("hex");
    const expiresAt = new Date(Date.now() + TASK_CONSTANTS.DEFAULT_TIMEOUT_MS);

    // Create BridgeTask record
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
      },
    });

    // Create signed task envelope
    const signedEnvelope = taskAuthorizationService.createSignedTaskEnvelope({
      taskId: task.id,
      deviceId: params.deviceId,
      workspaceId: params.workspaceId,
      capability: params.capability,
      resourceScopes: params.resourceScopes,
      parameters: params.parameters,
    });

    // Dispatch via WebSocket gateway
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

  /**
   * Retrieves single bridge task with approvals and execution details.
   */
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

  /**
   * Lists tasks in a workspace, optionally filtered by device.
   */
  public async listTasks(workspaceId: string, deviceId: string | undefined, userId: string, limit = 50) {
    const isMember = await workspaceService.isUserMember(workspaceId, userId);
    if (!isMember) {
      throw new DeviceTaskError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }

    const where: { workspaceId: string; deviceId?: string } = { workspaceId };
    if (deviceId) {
      where.deviceId = deviceId;
    }

    const tasks = await prisma.bridgeTask.findMany({
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

    return tasks;
  }

  /**
   * Retrieves execution stream logs for a task.
   */
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

    const logs = await prisma.bridgeTaskLog.findMany({
      where: { taskId },
      orderBy: { sequence: "asc" },
    });

    return logs;
  }

  /**
   * Handles human approval or rejection of a paused bridge task operation.
   * Requires OWNER or ADMIN role.
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

    const task = await prisma.bridgeTask.findUnique({
      where: { id: taskId },
      include: {
        approval: true,
      },
    });

    if (!task || task.workspaceId !== workspaceId) {
      throw new DeviceTaskError(404, "TASK_NOT_FOUND", "Task not found in this workspace.");
    }

    const pendingApproval = task.approval;
    if (!pendingApproval || pendingApproval.status !== "PENDING") {
      throw new DeviceTaskError(400, "NO_PENDING_APPROVAL", "Task has no pending approval requests.");
    }

    if (action === "approve") {
      // Transition approval to APPROVED
      await prisma.bridgeTaskApproval.update({
        where: { id: pendingApproval.id },
        data: {
          status: "APPROVED",
          decidedByUserId: userId,
          decidedAt: new Date(),
        },
      });

      // Update task to DISPATCHED
      const updatedTask = await prisma.bridgeTask.update({
        where: { id: task.id },
        data: { status: "DISPATCHED" },
      });

      // Generate signed task envelope with approval reference
      const envelope = taskAuthorizationService.createSignedTaskEnvelope({
        taskId: task.id,
        deviceId: task.deviceId,
        workspaceId: task.workspaceId,
        capability: task.capability,
        resourceScopes: task.resourceScopes,
        parameters: task.parameters as Record<string, unknown>,
        approvalReference: pendingApproval.id,
      });

      deviceConnectionGateway.sendToDevice(task.deviceId, envelope);
      return updatedTask;
    } else {
      // Rejection
      await prisma.bridgeTaskApproval.update({
        where: { id: pendingApproval.id },
        data: {
          status: "DENIED",
          decidedByUserId: userId,
          decidedAt: new Date(),
          rejectionReason: rejectionReason || "Rejected by administrator",
        },
      });

      const updatedTask = await prisma.bridgeTask.update({
        where: { id: task.id },
        data: {
          status: "FAILED",
          errorMessage: rejectionReason || "Operation rejected by administrator",
          completedAt: new Date(),
        },
      });

      const cancelFrame: DeviceTaskCancelFrame = {
        type: "device.task.cancel",
        taskId: task.id,
        reason: rejectionReason || "Rejected by administrator",
      };
      deviceConnectionGateway.sendToDevice(task.deviceId, cancelFrame);

      return updatedTask;
    }
  }

  /**
   * Cancels a running or pending bridge task.
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
      task.status === "EXPIRED"
    ) {
      return task;
    }

    const updated = await prisma.bridgeTask.update({
      where: { id: taskId },
      data: {
        status: "CANCELLED",
        errorMessage: reason,
        completedAt: new Date(),
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
