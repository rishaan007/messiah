import { prisma, Prisma } from "@messiah/db";
import {
  STARTER_WORKFLOW_TEMPLATES,
  WORKFLOW_CONSTANTS,
  type CreateWorkflowDto,
  type PublishWorkflowDto,
  type ToggleWorkflowScheduleDto,
  type TriggerWorkflowRunDto,
  type UpdateWorkflowDto,
  type WorkflowDefinitionInfo,
  type WorkflowGraphDefinition,
  type WorkflowRunDetail,
  type WorkflowRunInfo,
  type WorkflowValidationResult,
  type WorkspaceRole,
} from "@messiah/shared";
import { CronExpressionEngine, WorkflowDagValidator } from "@messiah/workflows";
import { chatQueueManager } from "../chat/chatQueue.js";
import { cancellationService } from "../chat/cancellationService.js";
import { workflowStreamPublisher } from "./workflowStreamPublisher.js";

export class WorkflowServiceError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "WorkflowServiceError";
  }
}

function slugifyWorkflow(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return base || `workflow-${Date.now()}`;
}

function mapWorkflowInfo(w: any): WorkflowDefinitionInfo {
  return {
    id: w.id,
    workspaceId: w.workspaceId,
    name: w.name,
    slug: w.slug,
    description: w.description || null,
    category: w.category,
    status: w.status,
    activeVersionNumber: w.activeVersionNumber ?? null,
    draftGraph: w.draftGraph as WorkflowGraphDefinition,
    defaultInputSchema: (w.defaultInputSchema as Record<string, unknown>) || null,
    isTemplate: Boolean(w.isTemplate),
    createdByUserId: w.createdByUserId || null,
    schedule: w.schedule
      ? {
          id: w.schedule.id,
          workflowId: w.schedule.workflowId,
          workspaceId: w.schedule.workspaceId,
          versionId: w.schedule.versionId || null,
          cronExpression: w.schedule.cronExpression,
          timezone: w.schedule.timezone,
          enabled: w.schedule.enabled,
          misfirePolicy: w.schedule.misfirePolicy,
          concurrencyPolicy: w.schedule.concurrencyPolicy,
          staticInput: (w.schedule.staticInput as Record<string, unknown>) || {},
          lastTriggeredAt: w.schedule.lastTriggeredAt
            ? w.schedule.lastTriggeredAt.toISOString()
            : null,
          nextRunAt: w.schedule.nextRunAt ? w.schedule.nextRunAt.toISOString() : null,
          consecutiveFailures: w.schedule.consecutiveFailures,
          lastError: w.schedule.lastError || null,
        }
      : null,
    eventTriggers: Array.isArray(w.eventTriggers)
      ? w.eventTriggers.map((et: any) => ({
          id: et.id,
          workflowId: et.workflowId,
          workspaceId: et.workspaceId,
          versionId: et.versionId || null,
          eventType: et.eventType,
          filterRules: (et.filterRules as Record<string, unknown>) || {},
          cooldownSeconds: et.cooldownSeconds,
          enabled: et.enabled,
          lastTriggeredAt: et.lastTriggeredAt ? et.lastTriggeredAt.toISOString() : null,
        }))
      : undefined,
    versions: Array.isArray(w.versions)
      ? w.versions.map((v: any) => ({
          id: v.id,
          workflowId: v.workflowId,
          workspaceId: v.workspaceId,
          versionNumber: v.versionNumber,
          definitionJson: v.definitionJson as WorkflowGraphDefinition,
          graphHash: v.graphHash,
          publishedByUserId: v.publishedByUserId || null,
          publishedAt: v.publishedAt.toISOString(),
          createdAt: v.createdAt.toISOString(),
        }))
      : undefined,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}

function mapRunInfo(r: any): WorkflowRunInfo {
  return {
    id: r.id,
    workflowId: r.workflowId,
    workflowName: r.workflow?.name,
    versionId: r.versionId,
    workspaceId: r.workspaceId,
    triggeredByUserId: r.triggeredByUserId || null,
    triggerType: r.triggerType,
    triggerEventId: r.triggerEventId || null,
    correlationId: r.correlationId || null,
    status: r.status,
    triggerPayload: (r.triggerPayload as Record<string, unknown>) || {},
    finalOutput: (r.finalOutput as Record<string, unknown>) || null,
    finalSummary: r.finalSummary || null,
    safeErrorCode: r.safeErrorCode || null,
    errorMessage: r.errorMessage || null,
    cancellationRequestedAt: r.cancellationRequestedAt
      ? r.cancellationRequestedAt.toISOString()
      : null,
    startedAt: r.startedAt ? r.startedAt.toISOString() : null,
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export class WorkflowService {
  private async assertMember(workspaceId: string, userId: string): Promise<WorkspaceRole> {
    const member = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    if (!member) {
      throw new WorkflowServiceError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }
    return member.role as WorkspaceRole;
  }

  public validateGraph(graph: unknown): WorkflowValidationResult {
    return WorkflowDagValidator.validate(graph);
  }

  public async listWorkflows(
    workspaceId: string,
    userId: string
  ): Promise<WorkflowDefinitionInfo[]> {
    await this.assertMember(workspaceId, userId);

    const rows = await prisma.workflowDefinition.findMany({
      where: { workspaceId, status: { not: "ARCHIVED" } },
      include: {
        schedule: true,
        eventTriggers: true,
        versions: { orderBy: { versionNumber: "desc" }, take: 3 },
      },
      orderBy: { updatedAt: "desc" },
    });

    return rows.map(mapWorkflowInfo);
  }

  public async getWorkflow(
    workflowId: string,
    workspaceId: string,
    userId: string
  ): Promise<WorkflowDefinitionInfo> {
    await this.assertMember(workspaceId, userId);

    const row = await prisma.workflowDefinition.findUnique({
      where: { id: workflowId },
      include: {
        schedule: true,
        eventTriggers: true,
        versions: { orderBy: { versionNumber: "desc" }, take: 10 },
      },
    });
    if (!row || row.workspaceId !== workspaceId) {
      throw new WorkflowServiceError(404, "WORKFLOW_NOT_FOUND", "Workflow not found.");
    }

    return mapWorkflowInfo(row);
  }

  public async createWorkflow(
    userId: string,
    dto: CreateWorkflowDto,
    options?: { autoPublish?: boolean; isTemplate?: boolean }
  ): Promise<WorkflowDefinitionInfo> {
    const role = await this.assertMember(dto.workspaceId, userId);
    if (role === "VIEWER") {
      throw new WorkflowServiceError(403, "FORBIDDEN_ROLE", "Viewer role cannot create workflows.");
    }

    const total = await prisma.workflowDefinition.count({
      where: { workspaceId: dto.workspaceId, status: { not: "ARCHIVED" } },
    });
    if (total >= WORKFLOW_CONSTANTS.MAX_WORKFLOWS_PER_WORKSPACE) {
      throw new WorkflowServiceError(
        400,
        "MAX_WORKFLOWS_REACHED",
        `Workspace reached maximum limit (${WORKFLOW_CONSTANTS.MAX_WORKFLOWS_PER_WORKSPACE}) of workflows.`
      );
    }

    const baseSlug = dto.slug || slugifyWorkflow(dto.name);
    let slug = baseSlug;
    let counter = 1;
    while (
      await prisma.workflowDefinition.findUnique({
        where: { workspaceId_slug: { workspaceId: dto.workspaceId, slug } },
      })
    ) {
      counter++;
      slug = `${baseSlug}-${counter}`;
    }

    const created = await prisma.workflowDefinition.create({
      data: {
        workspaceId: dto.workspaceId,
        name: dto.name,
        slug,
        description: dto.description || null,
        category: dto.category || "automation",
        status: "DRAFT",
        draftGraph: dto.draftGraph as unknown as Prisma.InputJsonValue,
        defaultInputSchema: (dto.defaultInputSchema || null) as any,
        isTemplate: Boolean(options?.isTemplate),
        createdByUserId: userId,
      },
      include: {
        schedule: true,
        eventTriggers: true,
        versions: true,
      },
    });

    if (options?.autoPublish) {
      const check = WorkflowDagValidator.validate(dto.draftGraph);
      if (check.valid) {
        return this.publishWorkflow(created.id, userId, {
          workspaceId: dto.workspaceId,
          activate: true,
        });
      }
    }

    return mapWorkflowInfo(created);
  }

  public async seedStarterTemplates(
    workspaceId: string,
    userId: string
  ): Promise<{ created: WorkflowDefinitionInfo[]; existingCount: number }> {
    const role = await this.assertMember(workspaceId, userId);
    if (role === "VIEWER") {
      throw new WorkflowServiceError(403, "FORBIDDEN_ROLE", "Viewer role cannot create workflows.");
    }

    const created: WorkflowDefinitionInfo[] = [];
    let existingCount = 0;

    for (const tpl of STARTER_WORKFLOW_TEMPLATES) {
      const existing = await prisma.workflowDefinition.findUnique({
        where: { workspaceId_slug: { workspaceId, slug: tpl.slug } },
      });
      if (existing) {
        existingCount++;
        continue;
      }
      const wf = await this.createWorkflow(
        userId,
        {
          workspaceId,
          name: tpl.name,
          slug: tpl.slug,
          description: tpl.description,
          category: tpl.category,
          draftGraph: tpl.graph as any,
        },
        { autoPublish: true, isTemplate: true }
      );
      created.push(wf);
    }

    return { created, existingCount };
  }

  public async updateWorkflow(
    workflowId: string,
    userId: string,
    dto: UpdateWorkflowDto
  ): Promise<WorkflowDefinitionInfo> {
    const role = await this.assertMember(dto.workspaceId, userId);
    if (role === "VIEWER") {
      throw new WorkflowServiceError(403, "FORBIDDEN_ROLE", "Viewer role cannot update workflows.");
    }

    const existing = await prisma.workflowDefinition.findUnique({
      where: { id: workflowId },
    });
    if (!existing || existing.workspaceId !== dto.workspaceId) {
      throw new WorkflowServiceError(404, "WORKFLOW_NOT_FOUND", "Workflow not found.");
    }

    if (dto.status === "ACTIVE" && existing.activeVersionNumber === null) {
      throw new WorkflowServiceError(
        400,
        "NO_PUBLISHED_VERSION",
        "Publish a validated workflow version before setting status to ACTIVE."
      );
    }

    const updated = await prisma.workflowDefinition.update({
      where: { id: workflowId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.category !== undefined ? { category: dto.category } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.draftGraph !== undefined
          ? { draftGraph: dto.draftGraph as unknown as Prisma.InputJsonValue }
          : {}),
        ...(dto.defaultInputSchema !== undefined
          ? { defaultInputSchema: dto.defaultInputSchema as any }
          : {}),
      },
      include: {
        schedule: true,
        eventTriggers: true,
        versions: { orderBy: { versionNumber: "desc" }, take: 5 },
      },
    });

    if (dto.status === "PAUSED" || dto.status === "ARCHIVED") {
      await prisma.workflowSchedule.updateMany({
        where: { workflowId },
        data: { enabled: false },
      });
      await prisma.workflowEventTrigger.updateMany({
        where: { workflowId },
        data: { enabled: false },
      });
    }

    return mapWorkflowInfo(updated);
  }

  public async deleteWorkflow(
    workflowId: string,
    workspaceId: string,
    userId: string
  ): Promise<void> {
    const role = await this.assertMember(workspaceId, userId);
    if (role !== "OWNER" && role !== "ADMIN") {
      throw new WorkflowServiceError(403, "FORBIDDEN_ROLE", "Only OWNER or ADMIN can delete workflows.");
    }
    const existing = await prisma.workflowDefinition.findUnique({ where: { id: workflowId } });
    if (!existing || existing.workspaceId !== workspaceId) {
      throw new WorkflowServiceError(404, "WORKFLOW_NOT_FOUND", "Workflow not found.");
    }
    await prisma.workflowDefinition.delete({ where: { id: workflowId } });
  }

  /**
   * Validates the draft DAG strictly, creates an immutable WorkflowVersion snapshot,
   * and synchronizes durable PostgreSQL schedules and event triggers.
   */
  public async publishWorkflow(
    workflowId: string,
    userId: string,
    dto: PublishWorkflowDto
  ): Promise<WorkflowDefinitionInfo> {
    const role = await this.assertMember(dto.workspaceId, userId);
    if (role === "VIEWER") {
      throw new WorkflowServiceError(403, "FORBIDDEN_ROLE", "Viewer role cannot publish workflows.");
    }

    const existing = await prisma.workflowDefinition.findUnique({
      where: { id: workflowId },
      include: { versions: { orderBy: { versionNumber: "desc" }, take: 1 } },
    });
    if (!existing || existing.workspaceId !== dto.workspaceId) {
      throw new WorkflowServiceError(404, "WORKFLOW_NOT_FOUND", "Workflow not found.");
    }

    const graph = existing.draftGraph as unknown as WorkflowGraphDefinition;
    const validation = WorkflowDagValidator.validate(graph);
    if (!validation.valid) {
      throw new WorkflowServiceError(
        422,
        "WORKFLOW_VALIDATION_FAILED",
        validation.issues
          .filter((i) => i.severity === "error")
          .map((i) => i.message)
          .join("; "),
        validation
      );
    }

    const nextVersionNumber = (existing.versions[0]?.versionNumber || 0) + 1;
    const graphHash = WorkflowDagValidator.computeGraphHash(graph);

    await prisma.$transaction(async (tx) => {
      const version = await tx.workflowVersion.create({
        data: {
          workflowId: existing.id,
          workspaceId: dto.workspaceId,
          versionNumber: nextVersionNumber,
          definitionJson: graph as unknown as Prisma.InputJsonValue,
          graphHash,
          publishedByUserId: userId,
        },
      });

      await tx.workflowDefinition.update({
        where: { id: existing.id },
        data: {
          activeVersionNumber: version.versionNumber,
          status: dto.activate ? "ACTIVE" : existing.status,
        },
      });

      // Synchronize schedule trigger from graph
      const schedNode = graph.nodes.find((n) => n.type === "schedule_trigger");
      if (schedNode) {
        const cfg = (schedNode.config || {}) as Record<string, unknown>;
        const cronExpression = String(cfg.cronExpression || "0 9 * * *").trim();
        const timezone = String(cfg.timezone || "UTC").trim();
        const nextRunAt = CronExpressionEngine.getNextRunAt(cronExpression, timezone, new Date());

        await tx.workflowSchedule.upsert({
          where: { workflowId: existing.id },
          create: {
            workflowId: existing.id,
            workspaceId: dto.workspaceId,
            versionId: version.id,
            cronExpression,
            timezone,
            enabled: Boolean(dto.activate),
            misfirePolicy: (String(cfg.misfirePolicy || "FIRE_ONCE") as any),
            concurrencyPolicy: (String(cfg.concurrencyPolicy || "SKIP_IF_RUNNING") as any),
            staticInput: ((cfg.staticInput as Record<string, unknown>) || {}) as Prisma.InputJsonValue,
            nextRunAt,
          },
          update: {
            versionId: version.id,
            cronExpression,
            timezone,
            enabled: Boolean(dto.activate),
            misfirePolicy: (String(cfg.misfirePolicy || "FIRE_ONCE") as any),
            concurrencyPolicy: (String(cfg.concurrencyPolicy || "SKIP_IF_RUNNING") as any),
            staticInput: ((cfg.staticInput as Record<string, unknown>) || {}) as Prisma.InputJsonValue,
            nextRunAt,
          },
        });
      } else {
        await tx.workflowSchedule.deleteMany({ where: { workflowId: existing.id } });
      }

      // Synchronize event triggers from graph
      const eventNodes = graph.nodes.filter((n) => n.type === "event_trigger");
      const activeEventTypes = new Set<string>();
      for (const en of eventNodes) {
        const cfg = (en.config || {}) as Record<string, unknown>;
        const eventType = String(cfg.eventType || "").trim();
        if (!eventType) continue;
        activeEventTypes.add(eventType);

        await tx.workflowEventTrigger.upsert({
          where: { workflowId_eventType: { workflowId: existing.id, eventType } },
          create: {
            workflowId: existing.id,
            workspaceId: dto.workspaceId,
            versionId: version.id,
            eventType,
            filterRules: ((cfg.filterRules as Record<string, unknown>) || {}) as Prisma.InputJsonValue,
            cooldownSeconds: Number(cfg.cooldownSeconds ?? 5),
            enabled: Boolean(dto.activate),
          },
          update: {
            versionId: version.id,
            filterRules: ((cfg.filterRules as Record<string, unknown>) || {}) as Prisma.InputJsonValue,
            cooldownSeconds: Number(cfg.cooldownSeconds ?? 5),
            enabled: Boolean(dto.activate),
          },
        });
      }

      await tx.workflowEventTrigger.deleteMany({
        where: {
          workflowId: existing.id,
          ...(activeEventTypes.size > 0 ? { eventType: { notIn: Array.from(activeEventTypes) } } : {}),
        },
      });
    });

    return this.getWorkflow(workflowId, dto.workspaceId, userId);
  }

  public async toggleSchedule(
    workflowId: string,
    userId: string,
    dto: ToggleWorkflowScheduleDto
  ): Promise<WorkflowDefinitionInfo> {
    const role = await this.assertMember(dto.workspaceId, userId);
    if (role === "VIEWER") {
      throw new WorkflowServiceError(403, "FORBIDDEN_ROLE", "Viewer role cannot toggle schedules.");
    }
    const sched = await prisma.workflowSchedule.findUnique({ where: { workflowId } });
    if (!sched || sched.workspaceId !== dto.workspaceId) {
      throw new WorkflowServiceError(404, "SCHEDULE_NOT_FOUND", "Workflow does not have an active schedule.");
    }

    const nextRunAt = dto.enabled
      ? CronExpressionEngine.getNextRunAt(sched.cronExpression, sched.timezone, new Date())
      : sched.nextRunAt;

    await prisma.workflowSchedule.update({
      where: { id: sched.id },
      data: { enabled: dto.enabled, nextRunAt },
    });

    if (dto.enabled) {
      await prisma.workflowDefinition.update({
        where: { id: workflowId },
        data: { status: "ACTIVE" },
      });
    }

    return this.getWorkflow(workflowId, dto.workspaceId, userId);
  }

  public async triggerManualRun(
    workflowId: string,
    userId: string,
    dto: TriggerWorkflowRunDto
  ): Promise<WorkflowRunInfo> {
    const role = await this.assertMember(dto.workspaceId, userId);
    if (role === "VIEWER") {
      throw new WorkflowServiceError(403, "FORBIDDEN_ROLE", "Viewer role cannot trigger workflow runs.");
    }

    const workflow = await prisma.workflowDefinition.findUnique({
      where: { id: workflowId },
      include: {
        versions: { orderBy: { versionNumber: "desc" } },
      },
    });

    if (!workflow || workflow.workspaceId !== dto.workspaceId) {
      throw new WorkflowServiceError(404, "WORKFLOW_NOT_FOUND", "Workflow not found.");
    }

    let version = dto.versionNumber
      ? workflow.versions.find((v) => v.versionNumber === dto.versionNumber)
      : workflow.versions.find((v) => v.versionNumber === workflow.activeVersionNumber) ||
        workflow.versions[0];

    if (!version) {
      // Auto-publish valid draft cleanly for instant manual execution
      const published = await this.publishWorkflow(workflowId, userId, {
        workspaceId: dto.workspaceId,
        activate: true,
      });
      version = (
        await prisma.workflowVersion.findMany({
          where: { workflowId },
          orderBy: { versionNumber: "desc" },
          take: 1,
        })
      )[0];
      void published;
    }

    if (!version) {
      throw new WorkflowServiceError(400, "NO_PUBLISHED_VERSION", "Workflow must be published before running.");
    }

    const graph = version.definitionJson as unknown as WorkflowGraphDefinition;
    const manualNode = graph.nodes.find((n) => n.type === "manual_trigger");
    const defaultPayload =
      (manualNode?.config?.defaultPayload as Record<string, unknown> | undefined) || {};
    const mergedPayload = { ...defaultPayload, ...(dto.triggerPayload || {}) };

    const created = await prisma.$transaction(async (tx) => {
      const run = await tx.workflowRun.create({
        data: {
          workflowId: workflow.id,
          versionId: version.id,
          workspaceId: dto.workspaceId,
          triggeredByUserId: userId,
          triggerType: "MANUAL",
          correlationId: dto.correlationId || null,
          status: "PENDING",
          triggerPayload: mergedPayload as Prisma.InputJsonValue,
        },
        include: { workflow: { select: { name: true } } },
      });

      await tx.workflowNodeExecution.createMany({
        data: graph.nodes.map((n) => ({
          runId: run.id,
          workflowId: workflow.id,
          workspaceId: dto.workspaceId,
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
            workspaceId: dto.workspaceId,
            userId,
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
          workspaceId: dto.workspaceId,
          userId,
          outboxEventId: created.outboxId,
        },
        `workflow-${created.run.id}`
      )
      .catch(() => {});

    return mapRunInfo(created.run);
  }

  public async listRuns(params: {
    workspaceId: string;
    userId: string;
    workflowId?: string;
    limit?: number;
  }): Promise<WorkflowRunInfo[]> {
    await this.assertMember(params.workspaceId, params.userId);
    const runs = await prisma.workflowRun.findMany({
      where: {
        workspaceId: params.workspaceId,
        ...(params.workflowId ? { workflowId: params.workflowId } : {}),
      },
      include: { workflow: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: Math.min(params.limit || 40, 100),
    });
    return runs.map(mapRunInfo);
  }

  public async getRunDetail(
    runId: string,
    workspaceId: string,
    userId: string
  ): Promise<WorkflowRunDetail> {
    await this.assertMember(workspaceId, userId);

    const run = await prisma.workflowRun.findUnique({
      where: { id: runId },
      include: {
        workflow: { select: { name: true } },
        version: true,
        nodeExecutions: { orderBy: { createdAt: "asc" } },
        approvals: { orderBy: { createdAt: "desc" } },
        events: { orderBy: { sequence: "asc" } },
      },
    });
    if (!run || run.workspaceId !== workspaceId) {
      throw new WorkflowServiceError(404, "WORKFLOW_RUN_NOT_FOUND", "Workflow run not found.");
    }

    const pendingToolApprovals = await prisma.toolApproval.findMany({
      where: {
        workspaceId,
        status: "PENDING",
        toolCall: { workflowRunId: run.id },
      },
      include: {
        toolCall: {
          include: { connection: { select: { name: true, endpointUrl: true } } },
        },
      },
    });

    const bridgeTasks = await prisma.bridgeTask.findMany({
      where: { workflowRunId: run.id },
      include: { approval: true },
      orderBy: { createdAt: "desc" },
    });

    return {
      ...mapRunInfo(run),
      version: {
        id: run.version.id,
        workflowId: run.version.workflowId,
        workspaceId: run.version.workspaceId,
        versionNumber: run.version.versionNumber,
        definitionJson: run.version.definitionJson as unknown as WorkflowGraphDefinition,
        graphHash: run.version.graphHash,
        publishedByUserId: run.version.publishedByUserId,
        publishedAt: run.version.publishedAt.toISOString(),
        createdAt: run.version.createdAt.toISOString(),
      },
      nodeExecutions: run.nodeExecutions.map((ne) => ({
        id: ne.id,
        runId: ne.runId,
        workflowId: ne.workflowId,
        workspaceId: ne.workspaceId,
        nodeId: ne.nodeId,
        nodeType: ne.nodeType,
        title: ne.title,
        status: ne.status,
        attemptCount: ne.attemptCount,
        inputData: (ne.inputData as Record<string, unknown>) || null,
        outputData: (ne.outputData as Record<string, unknown>) || null,
        errorCode: ne.errorCode || null,
        errorMessage: ne.errorMessage || null,
        durationMs: ne.durationMs ?? null,
        agentRunId: ne.agentRunId || null,
        toolCallId: ne.toolCallId || null,
        bridgeTaskId: ne.bridgeTaskId || null,
        startedAt: ne.startedAt ? ne.startedAt.toISOString() : null,
        completedAt: ne.completedAt ? ne.completedAt.toISOString() : null,
      })),
      approvals: run.approvals.map((a) => ({
        id: a.id,
        runId: a.runId,
        nodeExecutionId: a.nodeExecutionId,
        workflowId: a.workflowId,
        workspaceId: a.workspaceId,
        nodeId: a.nodeId,
        requestedByUserId: a.requestedByUserId || null,
        decidedByUserId: a.decidedByUserId || null,
        status: a.status,
        title: a.title,
        summary: a.summary,
        contextPreview: (a.contextPreview as Record<string, unknown>) || {},
        expiresAt: a.expiresAt.toISOString(),
        decidedAt: a.decidedAt ? a.decidedAt.toISOString() : null,
        rejectionReason: a.rejectionReason || null,
        createdAt: a.createdAt.toISOString(),
      })),
      events: run.events.map((ev) => ({
        id: ev.id,
        runId: ev.runId,
        workspaceId: ev.workspaceId,
        sequence: ev.sequence,
        eventType: ev.eventType,
        nodeId: ev.nodeId || null,
        payload: (ev.payload as Record<string, unknown>) || {},
        createdAt: ev.createdAt.toISOString(),
      })),
      pendingToolApprovals: pendingToolApprovals.map((pa) => ({
        id: pa.id,
        toolCallId: pa.toolCallId,
        workspaceId: pa.workspaceId,
        requestedByUserId: pa.requestedByUserId,
        decidedByUserId: pa.decidedByUserId,
        status: pa.status,
        expiresAt: pa.expiresAt.toISOString(),
        decidedAt: pa.decidedAt ? pa.decidedAt.toISOString() : null,
        rejectionReason: pa.rejectionReason || null,
        createdAt: pa.createdAt.toISOString(),
        updatedAt: pa.updatedAt.toISOString(),
        toolCall: {
          id: pa.toolCall.id,
          generationRunId: pa.toolCall.generationRunId || undefined,
          threadId: pa.toolCall.threadId || undefined,
          workspaceId: pa.toolCall.workspaceId,
          toolDefinitionId: pa.toolCall.toolDefinitionId,
          connectionId: pa.toolCall.connectionId,
          providerCallId: pa.toolCall.providerCallId,
          providerToolAlias: pa.toolCall.providerToolAlias,
          toolName: pa.toolCall.toolName,
          status: pa.toolCall.status,
          argumentsPreview: pa.toolCall.argumentsPreview as Record<string, unknown>,
          isError: pa.toolCall.isError,
          errorMessage: pa.toolCall.errorMessage,
          durationMs: pa.toolCall.durationMs,
          completedAt: pa.toolCall.completedAt?.toISOString() || null,
          createdAt: pa.toolCall.createdAt.toISOString(),
          connection: {
            name: pa.toolCall.connection.name,
            endpointUrl: pa.toolCall.connection.endpointUrl,
          },
        },
      })) as any,
      bridgeTasks: bridgeTasks as any,
    };
  }

  public async decideApproval(params: {
    approvalId: string;
    workspaceId: string;
    userId: string;
    decision: "APPROVED" | "DENIED";
    reason?: string;
  }): Promise<WorkflowRunInfo> {
    const role = await this.assertMember(params.workspaceId, params.userId);
    if (role !== "OWNER" && role !== "ADMIN") {
      throw new WorkflowServiceError(
        403,
        "FORBIDDEN_ROLE",
        "Only workspace OWNER or ADMIN roles can approve or reject workflow gates."
      );
    }

    const txRes = await prisma.$transaction(async (tx) => {
      const approval = await tx.workflowApproval.findUnique({
        where: { id: params.approvalId },
      });
      if (!approval || approval.workspaceId !== params.workspaceId) {
        throw new WorkflowServiceError(404, "APPROVAL_NOT_FOUND", "Workflow approval request not found.");
      }
      if (approval.status !== "PENDING") {
        throw new WorkflowServiceError(
          400,
          "ALREADY_DECIDED",
          `Workflow approval is already ${approval.status}.`
        );
      }
      if (Date.now() > approval.expiresAt.getTime()) {
        await tx.workflowApproval.update({
          where: { id: approval.id },
          data: { status: "EXPIRED" },
        });
        throw new WorkflowServiceError(400, "APPROVAL_EXPIRED", "Workflow approval has expired.");
      }

      const claimed = await tx.workflowApproval.updateMany({
        where: { id: approval.id, status: "PENDING" },
        data: {
          status: params.decision,
          decidedByUserId: params.userId,
          decidedAt: new Date(),
          ...(params.decision === "DENIED" && params.reason ? { rejectionReason: params.reason } : {}),
        },
      });
      if (claimed.count === 0) {
        throw new WorkflowServiceError(400, "ALREADY_DECIDED", "Approval already consumed.");
      }

      await tx.workflowRun.updateMany({
        where: { id: approval.runId, status: "AWAITING_APPROVAL" },
        data: { status: "RUNNING" },
      });

      const outbox = await tx.outboxEvent.create({
        data: {
          eventType: "workflow.resume",
          aggregateType: "WorkflowRun",
          aggregateId: approval.runId,
          payload: {
            kind: "workflow.execute",
            runId: approval.runId,
            workspaceId: params.workspaceId,
            userId: params.userId,
          },
          status: "PENDING",
        },
      });

      const run = await tx.workflowRun.findUniqueOrThrow({
        where: { id: approval.runId },
        include: { workflow: { select: { name: true } } },
      });

      return { run, outboxId: outbox.id, approval };
    });

    await workflowStreamPublisher.publish({
      type: "workflow.approval.resolved",
      runId: txRes.run.id,
      workflowId: txRes.run.workflowId,
      workspaceId: params.workspaceId,
      nodeId: txRes.approval.nodeId,
      sequence: 0,
      timestamp: new Date().toISOString(),
      payload: {
        approvalId: params.approvalId,
        decision: params.decision,
        decidedByUserId: params.userId,
      },
    });

    import("../notifications/index.js")
      .then(({ notificationStreamPublisher }) =>
        notificationStreamPublisher.publish({
          type: "approval.resolved",
          workspaceId: params.workspaceId,
          payload: {
            kind: "WORKFLOW_GATE",
            resourceId: params.approvalId,
            decision: params.decision,
            runId: txRes.run.id,
          },
          timestamp: new Date().toISOString(),
        })
      )
      .catch(() => {});

    await chatQueueManager
      .enqueueWorkflowRun(
        {
          kind: "workflow.execute",
          runId: txRes.run.id,
          workspaceId: params.workspaceId,
          userId: params.userId,
          outboxEventId: txRes.outboxId,
        },
        `workflow-${txRes.run.id}-resume-${txRes.outboxId}`
      )
      .catch(() => {});

    return mapRunInfo(txRes.run);
  }

  public async cancelRun(
    runId: string,
    workspaceId: string,
    userId: string
  ): Promise<WorkflowRunInfo> {
    const role = await this.assertMember(workspaceId, userId);
    if (role === "VIEWER") {
      throw new WorkflowServiceError(403, "FORBIDDEN_ROLE", "Viewer role cannot cancel workflows.");
    }

    const existing = await prisma.workflowRun.findUnique({ where: { id: runId } });
    if (!existing || existing.workspaceId !== workspaceId) {
      throw new WorkflowServiceError(404, "WORKFLOW_RUN_NOT_FOUND", "Workflow run not found.");
    }

    if (
      existing.status === "COMPLETED" ||
      existing.status === "PARTIAL_COMPLETED" ||
      existing.status === "FAILED" ||
      existing.status === "CANCELLED"
    ) {
      return mapRunInfo(existing);
    }

    const now = new Date();
    const updated = await prisma.workflowRun.update({
      where: { id: runId },
      data: {
        cancellationRequestedAt: now,
        ...(existing.status === "PENDING" || existing.status === "AWAITING_APPROVAL"
          ? {
              status: "CANCELLED",
              safeErrorCode: "USER_CANCELLED",
              completedAt: now,
            }
          : {}),
      },
      include: { workflow: { select: { name: true } } },
    });

    if (existing.status === "PENDING" || existing.status === "AWAITING_APPROVAL") {
      await prisma.workflowNodeExecution.updateMany({
        where: { runId, status: { in: ["PENDING", "QUEUED", "AWAITING_APPROVAL"] } },
        data: { status: "CANCELLED", completedAt: now },
      });
      await workflowStreamPublisher.publish({
        type: "workflow.run.cancelled",
        runId: updated.id,
        workflowId: updated.workflowId,
        workspaceId,
        sequence: 0,
        timestamp: now.toISOString(),
        payload: { status: "CANCELLED" },
      });
    }

    await cancellationService.requestCancellation(runId).catch(() => {});
    return mapRunInfo(updated);
  }
}

export const workflowService = new WorkflowService();
