import { prisma, type AgentRun, type AgentTask } from "@messiah/db";
import type {
  AgentArtifactInfo,
  AgentCommunicationInfo,
  AgentExecutionInfo,
  AgentRunEventInfo,
  AgentRunInfo,
  AgentRunStatus,
  AgentTaskInfo,
  AgentTaskStatus,
  StartSwarmRunDto,
  SwarmExecutionPlan,
  SwarmRunDetail,
} from "@messiah/shared";
import { workspaceService } from "../workspaceService.js";
import { logAuditEvent } from "../auditService.js";
import { chatQueueManager } from "../chat/chatQueue.js";
import { cancellationService } from "../chat/cancellationService.js";

export class SwarmServiceError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "SwarmServiceError";
  }
}

export function formatAgentTask(
  t: AgentTask & {
    assignedAgent?: {
      id: string;
      name: string;
      roleTitle: string;
      category: string;
      avatarAccent: string | null;
      modelId: string | null;
    } | null;
  }
): AgentTaskInfo {
  return {
    id: t.id,
    runId: t.runId,
    workspaceId: t.workspaceId,
    taskKey: t.taskKey,
    title: t.title,
    instructions: t.instructions,
    assignedAgentId: t.assignedAgentId,
    assignedVersionId: t.assignedVersionId,
    assignedAgent: t.assignedAgent || null,
    dependsOnKeys: t.dependsOnKeys,
    inputTaskKeys: t.inputTaskKeys,
    delegationDepth: t.delegationDepth,
    fingerprint: t.fingerprint,
    status: t.status as AgentTaskStatus,
    priority: t.priority,
    maxIterations: t.maxIterations,
    targetBridgeDeviceId: t.targetBridgeDeviceId,
    outputSummary: t.outputSummary,
    outputData: (t.outputData as Record<string, unknown> | null) || null,
    errorCode: t.errorCode,
    errorMessage: t.errorMessage,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    attemptCount: t.attemptCount,
    startedAt: t.startedAt?.toISOString() ?? null,
    completedAt: t.completedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export function formatAgentRun(
  run: AgentRun & {
    supervisorAgent?: {
      id: string;
      name: string;
      roleTitle: string;
      category: string;
      avatarAccent: string | null;
      modelId: string | null;
    } | null;
  }
): AgentRunInfo {
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    createdByUserId: run.createdByUserId,
    threadId: run.threadId,
    assistantMessageId: run.assistantMessageId,
    supervisorAgentId: run.supervisorAgentId,
    supervisorVersionId: run.supervisorVersionId,
    supervisorAgent: run.supervisorAgent || null,
    workerAgentIds: run.workerAgentIds,
    objective: run.objective,
    status: run.status as AgentRunStatus,
    requirePlanApproval: run.requirePlanApproval,
    planApprovedAt: run.planApprovedAt?.toISOString() ?? null,
    planJson: (run.planJson as SwarmExecutionPlan | null) || null,
    maxTotalTokens: run.maxTotalTokens,
    maxCostUsd: run.maxCostUsd,
    maxDurationMs: run.maxDurationMs,
    maxConcurrency: run.maxConcurrency,
    maxDelegationDepth: run.maxDelegationDepth,
    maxReplanRounds: run.maxReplanRounds,
    replanCount: run.replanCount,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    estimatedCostUsd: run.estimatedCostUsd,
    finalSummary: run.finalSummary,
    safeErrorCode: run.safeErrorCode,
    errorMessage: run.errorMessage,
    cancellationRequestedAt: run.cancellationRequestedAt?.toISOString() ?? null,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

export class SwarmService {
  public async startSwarmRun(userId: string, input: StartSwarmRunDto): Promise<AgentRunInfo> {
    const role = await workspaceService.getUserRole(input.workspaceId, userId);
    if (!role) {
      throw new SwarmServiceError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }
    if (role === "VIEWER") {
      throw new SwarmServiceError(403, "FORBIDDEN_ROLE", "Viewers cannot launch multi-agent swarm runs.");
    }

    // Validate Supervisor agent
    const supervisor = await prisma.agentDefinition.findUnique({
      where: { id: input.supervisorAgentId },
      include: {
        providerConnection: { select: { id: true, status: true } },
        versions: { orderBy: { versionNumber: "desc" }, take: 1 },
      },
    });
    if (!supervisor || supervisor.workspaceId !== input.workspaceId || supervisor.status !== "ACTIVE") {
      throw new SwarmServiceError(404, "SUPERVISOR_NOT_FOUND", "Selected supervisor agent is missing or inactive.");
    }
    if (!supervisor.canSupervise) {
      throw new SwarmServiceError(
        400,
        "AGENT_NOT_SUPERVISOR",
        `Agent '${supervisor.name}' is not configured as a Supervisor agent.`
      );
    }
    if (!supervisor.providerConnection || supervisor.providerConnection.status !== "ACTIVE" || !supervisor.modelId) {
      throw new SwarmServiceError(
        400,
        "SUPERVISOR_NOT_CONFIGURED",
        `Supervisor '${supervisor.name}' requires an active provider connection and model ID.`
      );
    }

    // Validate Worker agents
    const uniqueWorkerIds = Array.from(new Set(input.workerAgentIds));
    const workers = await prisma.agentDefinition.findMany({
      where: {
        workspaceId: input.workspaceId,
        id: { in: uniqueWorkerIds },
        status: "ACTIVE",
      },
      include: {
        providerConnection: { select: { id: true, status: true } },
      },
    });
    if (workers.length !== uniqueWorkerIds.length) {
      throw new SwarmServiceError(
        400,
        "INVALID_WORKERS",
        "One or more selected worker agents are missing, inactive, or outside this workspace."
      );
    }
    for (const w of workers) {
      if (!w.providerConnection || w.providerConnection.status !== "ACTIVE" || !w.modelId) {
        throw new SwarmServiceError(
          400,
          "WORKER_NOT_CONFIGURED",
          `Worker agent '${w.name}' requires an active provider connection and model ID.`
        );
      }
    }

    // Validate optional Thread ownership
    let assistantMessageId: string | null = null;
    if (input.threadId) {
      const thread = await prisma.thread.findUnique({
        where: { id: input.threadId },
        select: { id: true, workspaceId: true },
      });
      if (!thread || thread.workspaceId !== input.workspaceId) {
        throw new SwarmServiceError(404, "THREAD_NOT_FOUND", "Referenced chat thread not found in this workspace.");
      }

      // Append user objective + placeholder assistant message in chat thread cleanly
      const lastMsg = await prisma.message.findFirst({
        where: { threadId: input.threadId },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      });
      const baseSeq = lastMsg?.sequence || 0;

      const createdMessages = await prisma.$transaction(async (tx) => {
        await tx.message.create({
          data: {
            threadId: input.threadId!,
            sequence: baseSeq + 1,
            role: "USER",
            content: `[Swarm Objective] ${input.objective}`,
            status: "COMPLETED",
            completedAt: new Date(),
          },
        });
        const assistant = await tx.message.create({
          data: {
            threadId: input.threadId!,
            sequence: baseSeq + 2,
            role: "ASSISTANT",
            content: "Orchestrating multi-agent swarm...",
            status: "PENDING",
          },
        });
        await tx.thread.update({
          where: { id: input.threadId! },
          data: { lastMessageAt: new Date() },
        });
        return assistant;
      });
      assistantMessageId = createdMessages.id;
    }

    if (input.targetBridgeDeviceId) {
      const dev = await prisma.bridgeDevice.findUnique({
        where: { id: input.targetBridgeDeviceId },
        select: { workspaceId: true, status: true },
      });
      if (!dev || dev.workspaceId !== input.workspaceId) {
        throw new SwarmServiceError(404, "DEVICE_NOT_FOUND", "Target bridge device not found in this workspace.");
      }
    }

    // Persist AgentRun + durable OutboxEvent atomically
    const { run, outboxEvent } = await prisma.$transaction(async (tx) => {
      const createdRun = await tx.agentRun.create({
        data: {
          workspaceId: input.workspaceId,
          createdByUserId: userId,
          threadId: input.threadId || null,
          assistantMessageId,
          supervisorAgentId: supervisor.id,
          supervisorVersionId: supervisor.versions[0]?.id || null,
          workerAgentIds: uniqueWorkerIds,
          objective: input.objective,
          status: "PENDING",
          requirePlanApproval: input.requirePlanApproval,
          maxTotalTokens: input.maxTotalTokens,
          maxCostUsd: input.maxCostUsd,
          maxDurationMs: input.maxDurationMs,
          maxConcurrency: input.maxConcurrency,
          maxDelegationDepth: input.maxDelegationDepth,
          maxReplanRounds: input.maxReplanRounds,
        },
        include: {
          supervisorAgent: {
            select: {
              id: true,
              name: true,
              roleTitle: true,
              category: true,
              avatarAccent: true,
              modelId: true,
            },
          },
        },
      });

      const outbox = await tx.outboxEvent.create({
        data: {
          eventType: "swarm.dispatch",
          aggregateType: "AgentRun",
          aggregateId: createdRun.id,
          payload: {
            kind: "swarm.execute",
            runId: createdRun.id,
            workspaceId: input.workspaceId,
            userId,
          },
          status: "PENDING",
        },
      });

      return { run: createdRun, outboxEvent: outbox };
    });

    // Immediate enqueue backed by Outbox sweeper
    chatQueueManager
      .enqueueSwarmRun(
        {
          kind: "swarm.execute",
          runId: run.id,
          workspaceId: input.workspaceId,
          userId,
          outboxEventId: outboxEvent.id,
        },
        `swarm-${run.id}-${outboxEvent.id}`
      )
      .catch((err) => {
        console.warn(`[SwarmService] Fast-path enqueue deferred to outbox sweeper for ${run.id}:`, err);
      });

    await logAuditEvent({
      actorId: userId,
      workspaceId: input.workspaceId,
      action: "swarm_run_started",
      resourceType: "agent_run",
      resourceId: run.id,
      details: {
        supervisorAgentId: supervisor.id,
        workerCount: uniqueWorkerIds.length,
        requirePlanApproval: input.requirePlanApproval,
      },
    });

    return formatAgentRun(run);
  }

  public async listSwarmRuns(workspaceId: string, userId: string, limit = 25): Promise<AgentRunInfo[]> {
    const isMember = await workspaceService.isUserMember(workspaceId, userId);
    if (!isMember) {
      throw new SwarmServiceError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }

    const runs = await prisma.agentRun.findMany({
      where: { workspaceId },
      include: {
        supervisorAgent: {
          select: {
            id: true,
            name: true,
            roleTitle: true,
            category: true,
            avatarAccent: true,
            modelId: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: Math.min(limit, 100),
    });

    return runs.map(formatAgentRun);
  }

  public async getSwarmRunDetail(runId: string, workspaceId: string, userId: string): Promise<SwarmRunDetail> {
    const isMember = await workspaceService.isUserMember(workspaceId, userId);
    if (!isMember) {
      throw new SwarmServiceError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }

    const run = await prisma.agentRun.findUnique({
      where: { id: runId },
      include: {
        supervisorAgent: {
          select: {
            id: true,
            name: true,
            roleTitle: true,
            category: true,
            avatarAccent: true,
            modelId: true,
          },
        },
        tasks: {
          include: {
            assignedAgent: {
              select: {
                id: true,
                name: true,
                roleTitle: true,
                category: true,
                avatarAccent: true,
                modelId: true,
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
        executions: {
          orderBy: { startedAt: "asc" },
        },
        communications: {
          orderBy: { createdAt: "asc" },
        },
        artifacts: {
          orderBy: { createdAt: "asc" },
        },
        events: {
          orderBy: { sequence: "asc" },
          take: 500,
        },
        toolCalls: {
          include: { approval: true },
          orderBy: { createdAt: "desc" },
        },
        bridgeTasks: {
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!run || run.workspaceId !== workspaceId) {
      throw new SwarmServiceError(404, "SWARM_RUN_NOT_FOUND", "Swarm run not found in this workspace.");
    }

    const pendingApprovals = run.toolCalls
      .filter((tc) => tc.approval && tc.approval.status === "PENDING")
      .map((tc) => ({
        id: tc.approval!.id,
        toolCallId: tc.id,
        workspaceId: tc.workspaceId,
        requestedByUserId: tc.approval!.requestedByUserId,
        decidedByUserId: tc.approval!.decidedByUserId,
        status: tc.approval!.status,
        argumentsHash: tc.approval!.argumentsHash,
        schemaHash: tc.approval!.schemaHash,
        expiresAt: tc.approval!.expiresAt.toISOString(),
        decidedAt: tc.approval!.decidedAt?.toISOString() ?? null,
        rejectionReason: tc.approval!.rejectionReason,
        createdAt: tc.approval!.createdAt.toISOString(),
        updatedAt: tc.approval!.updatedAt.toISOString(),
        toolCall: {
          id: tc.id,
          generationRunId: tc.generationRunId || run.id,
          threadId: tc.threadId || run.threadId || "",
          workspaceId: tc.workspaceId,
          toolDefinitionId: tc.toolDefinitionId,
          providerCallId: tc.providerCallId,
          providerToolAlias: tc.providerToolAlias,
          connectionId: tc.connectionId,
          toolName: tc.toolName,
          schemaHash: tc.schemaHash,
          argumentsHash: tc.argumentsHash,
          argumentsPreview: (tc.argumentsPreview as Record<string, unknown>) || {},
          status: tc.status,
          isError: tc.isError,
          errorMessage: tc.errorMessage,
          durationMs: tc.durationMs,
          completedAt: tc.completedAt?.toISOString() ?? null,
          createdAt: tc.createdAt.toISOString(),
          updatedAt: tc.updatedAt.toISOString(),
        },
      }));

    return {
      ...formatAgentRun(run),
      tasks: run.tasks.map(formatAgentTask),
      executions: run.executions.map((e): AgentExecutionInfo => ({
        id: e.id,
        runId: e.runId,
        taskId: e.taskId,
        workspaceId: e.workspaceId,
        agentId: e.agentId,
        versionId: e.versionId,
        phase: e.phase,
        status: e.status,
        providerConnectionId: e.providerConnectionId,
        modelId: e.modelId,
        iterationsUsed: e.iterationsUsed,
        toolCallIds: e.toolCallIds,
        bridgeTaskIds: e.bridgeTaskIds,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        durationMs: e.durationMs,
        resultSummary: e.resultSummary,
        errorMessage: e.errorMessage,
        startedAt: e.startedAt.toISOString(),
        completedAt: e.completedAt?.toISOString() ?? null,
      })),
      communications: run.communications.map((c): AgentCommunicationInfo => ({
        id: c.id,
        runId: c.runId,
        taskId: c.taskId,
        workspaceId: c.workspaceId,
        fromAgentId: c.fromAgentId,
        toAgentId: c.toAgentId,
        messageType: c.messageType,
        summary: c.summary,
        payloadDigest: c.payloadDigest,
        createdAt: c.createdAt.toISOString(),
      })),
      artifacts: run.artifacts.map((a): AgentArtifactInfo => ({
        id: a.id,
        runId: a.runId,
        taskId: a.taskId,
        workspaceId: a.workspaceId,
        agentId: a.agentId,
        artifactType: a.artifactType,
        title: a.title,
        content: a.content,
        metadata: (a.metadata as Record<string, unknown>) || {},
        createdAt: a.createdAt.toISOString(),
      })),
      events: run.events.map((ev): AgentRunEventInfo => ({
        id: ev.id,
        runId: ev.runId,
        workspaceId: ev.workspaceId,
        sequence: ev.sequence,
        eventType: ev.eventType,
        taskId: ev.taskId,
        agentId: ev.agentId,
        payload: (ev.payload as Record<string, unknown>) || {},
        createdAt: ev.createdAt.toISOString(),
      })),
      pendingToolApprovals: pendingApprovals,
      bridgeTasks: run.bridgeTasks.map((bt) => ({
        id: bt.id,
        workspaceId: bt.workspaceId,
        deviceId: bt.deviceId,
        userId: bt.userId,
        threadId: bt.threadId,
        generationRunId: bt.generationRunId,
        capability: bt.capability,
        resourceScopes: bt.resourceScopes,
        parameters: (bt.parameters as Record<string, unknown>) || {},
        argumentsHash: bt.argumentsHash,
        status: bt.status,
        result: (bt.result as Record<string, unknown> | null) || null,
        errorMessage: bt.errorMessage,
        exitCode: bt.exitCode,
        durationMs: bt.durationMs,
        issuedAt: bt.issuedAt.toISOString(),
        expiresAt: bt.expiresAt.toISOString(),
        startedAt: bt.startedAt?.toISOString() ?? null,
        completedAt: bt.completedAt?.toISOString() ?? null,
        createdAt: bt.createdAt.toISOString(),
        updatedAt: bt.updatedAt.toISOString(),
      })),
    };
  }

  public async approveOrRejectPlan(
    runId: string,
    workspaceId: string,
    userId: string,
    action: "approve" | "reject",
    rejectionReason?: string
  ): Promise<AgentRunInfo> {
    const role = await workspaceService.getUserRole(workspaceId, userId);
    if (!role) {
      throw new SwarmServiceError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }
    if (role !== "OWNER" && role !== "ADMIN") {
      throw new SwarmServiceError(403, "FORBIDDEN_ROLE", "Only workspace OWNER or ADMIN can approve swarm execution plans.");
    }

    const txResult = await prisma.$transaction(async (tx) => {
      const existing = await tx.agentRun.findUnique({ where: { id: runId } });
      if (!existing || existing.workspaceId !== workspaceId) {
        throw new SwarmServiceError(404, "SWARM_RUN_NOT_FOUND", "Swarm run not found in this workspace.");
      }
      if (existing.status !== "AWAITING_PLAN_APPROVAL") {
        throw new SwarmServiceError(409, "INVALID_RUN_STATE", `Run is in state '${existing.status}', not AWAITING_PLAN_APPROVAL.`);
      }

      if (action === "reject") {
        const cancelled = await tx.agentRun.update({
          where: { id: runId },
          data: {
            status: "CANCELLED",
            safeErrorCode: "PLAN_REJECTED",
            errorMessage: rejectionReason || "Execution plan rejected by administrator.",
            completedAt: new Date(),
          },
          include: {
            supervisorAgent: {
              select: {
                id: true,
                name: true,
                roleTitle: true,
                category: true,
                avatarAccent: true,
                modelId: true,
              },
            },
          },
        });
        await tx.agentTask.updateMany({
          where: { runId },
          data: { status: "CANCELLED", completedAt: new Date() },
        });
        return { run: cancelled, outboxEventId: null };
      }

      const updated = await tx.agentRun.update({
        where: { id: runId },
        data: {
          planApprovedAt: new Date(),
        },
        include: {
          supervisorAgent: {
            select: {
              id: true,
              name: true,
              roleTitle: true,
              category: true,
              avatarAccent: true,
              modelId: true,
            },
          },
        },
      });

      const outbox = await tx.outboxEvent.create({
        data: {
          eventType: "swarm.resume",
          aggregateType: "AgentRun",
          aggregateId: runId,
          payload: {
            kind: "swarm.execute",
            runId,
            workspaceId,
            userId,
          },
          status: "PENDING",
        },
      });

      return { run: updated, outboxEventId: outbox.id };
    });

    if (action === "approve" && txResult.outboxEventId) {
      await chatQueueManager
        .enqueueSwarmRun(
          {
            kind: "swarm.execute",
            runId,
            workspaceId,
            userId,
            outboxEventId: txResult.outboxEventId,
          },
          `swarm-${runId}-plan-${txResult.outboxEventId}`
        )
        .catch(() => {});
    }

    await logAuditEvent({
      actorId: userId,
      workspaceId,
      action: action === "approve" ? "swarm_plan_approved" : "swarm_plan_rejected",
      resourceType: "agent_run",
      resourceId: runId,
      details: { rejectionReason: rejectionReason || null },
    });

    return formatAgentRun(txResult.run);
  }

  public async cancelSwarmRun(runId: string, workspaceId: string, userId: string): Promise<AgentRunInfo> {
    const role = await workspaceService.getUserRole(workspaceId, userId);
    if (!role) {
      throw new SwarmServiceError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }
    if (role === "VIEWER") {
      throw new SwarmServiceError(403, "FORBIDDEN_ROLE", "Viewers cannot cancel swarm runs.");
    }

    const existing = await prisma.agentRun.findUnique({
      where: { id: runId },
      include: {
        supervisorAgent: {
          select: {
            id: true,
            name: true,
            roleTitle: true,
            category: true,
            avatarAccent: true,
            modelId: true,
          },
        },
      },
    });
    if (!existing || existing.workspaceId !== workspaceId) {
      throw new SwarmServiceError(404, "SWARM_RUN_NOT_FOUND", "Swarm run not found in this workspace.");
    }
    if (
      existing.status === "COMPLETED" ||
      existing.status === "PARTIAL_COMPLETED" ||
      existing.status === "FAILED" ||
      existing.status === "CANCELLED"
    ) {
      return formatAgentRun(existing);
    }

    await cancellationService.requestCancellation(runId);

    const updated = await prisma.$transaction(async (tx) => {
      await tx.agentTask.updateMany({
        where: { runId, status: { in: ["PENDING", "QUEUED", "AWAITING_APPROVAL"] } },
        data: { status: "CANCELLED", completedAt: new Date() },
      });

      return tx.agentRun.update({
        where: { id: runId },
        data: {
          cancellationRequestedAt: new Date(),
          status: "CANCELLED",
          safeErrorCode: "USER_CANCELLED",
          completedAt: new Date(),
        },
        include: {
          supervisorAgent: {
            select: {
              id: true,
              name: true,
              roleTitle: true,
              category: true,
              avatarAccent: true,
              modelId: true,
            },
          },
        },
      });
    });

    await logAuditEvent({
      actorId: userId,
      workspaceId,
      action: "swarm_run_cancelled",
      resourceType: "agent_run",
      resourceId: runId,
    });

    return formatAgentRun(updated);
  }
}

export const swarmService = new SwarmService();
