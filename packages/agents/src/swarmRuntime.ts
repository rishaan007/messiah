import {
  prisma,
  type AgentConfigurationVersion,
  type AgentDefinition,
  type AgentTask,
} from "@messiah/db";
import {
  McpConnectionManager,
  ToolSchemaValidator,
  toolResultSanitizer,
  generateToolAlias,
  translateToProviderTool,
  computeArgumentsHash,
} from "@messiah/mcp";
import {
  defaultProviderRegistry,
  type ProviderChatMessage,
  type ProviderToolDefinition,
} from "@messiah/providers";
import type {
  SupportedProviderId,
  SwarmExecutionPlan,
  SwarmStreamEvent,
  SwarmStreamEventType,
} from "@messiah/shared";
import { SwarmDagError, SwarmDagValidator } from "./dagValidator.js";
import { SwarmContextBuilder, type ScopedUpstreamResult } from "./swarmContextBuilder.js";
import { SwarmPlanner, SwarmPlanError, type AgentProfileDescriptor } from "./swarmPlanner.js";

export interface SwarmJobPayload {
  kind: "swarm.execute";
  runId: string;
  outboxEventId?: string;
  workspaceId: string;
  userId: string;
}

export interface SwarmCredentialDecryptInput {
  ciphertext: string;
  initializationVector: string;
  authenticationTag: string;
  keyVersion: string;
  providerConnectionId: string;
  workspaceId: string;
  provider: string;
}

export interface SwarmBridgeDispatchParams {
  workspaceId: string;
  userId: string;
  deviceId: string;
  capability: string;
  resourceScopes: string[];
  parameters: Record<string, unknown>;
  agentRunId: string;
  agentTaskId: string;
  threadId?: string;
}

export interface SwarmBridgeDispatchResult {
  bridgeTaskId: string;
  status: string;
  result?: unknown;
  errorMessage?: string | null;
}

export interface SwarmRuntimeDependencies {
  decryptProviderSecret: (input: SwarmCredentialDecryptInput) => string;
  decryptMcpSecret?: (
    encryptedValue: string,
    context: { workspaceId: string; connectionId: string; keyVersion: string }
  ) => string;
  publishEvent: (event: SwarmStreamEvent) => Promise<void>;
  publishThreadMessageUpdate?: (params: {
    threadId: string;
    assistantMessageId: string;
    runId: string;
    status: "COMPLETED" | "FAILED" | "CANCELLED";
    content: string;
  }) => Promise<void>;
  dispatchBridgeTask?: (params: SwarmBridgeDispatchParams) => Promise<SwarmBridgeDispatchResult>;
  isCancellationRequested?: (runId: string) => Promise<boolean>;
}

const MODEL_PRICING_PER_1K_TOKENS: Record<string, { input: number; output: number }> = {
  openai: { input: 0.0025, output: 0.01 },
  anthropic: { input: 0.003, output: 0.015 },
  gemini: { input: 0.00125, output: 0.005 },
};

export function estimateCostUsd(provider: string, inputTokens: number, outputTokens: number): number {
  const rate = MODEL_PRICING_PER_1K_TOKENS[provider] || { input: 0.003, output: 0.012 };
  const raw = (inputTokens / 1000) * rate.input + (outputTokens / 1000) * rate.output;
  return Math.round(raw * 1_000_000) / 1_000_000;
}

export function sanitizeArgumentsPreview(args: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  const SENSITIVE_KEY_PATTERN = /(password|secret|token|api_key|credential|private_key|auth)/i;
  for (const [key, value] of Object.entries(args)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      sanitized[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      sanitized[key] = sanitizeArgumentsPreview(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

interface ResolvedMcpToolBinding {
  toolDefinitionId: string;
  connectionId: string;
  connectionName: string;
  endpointUrl: string;
  transportType: string;
  originalToolName: string;
  providerToolAlias: string;
  schemaHash: string;
  inputSchema: Record<string, unknown>;
  requiresApproval: boolean;
  permissionMode: string;
}

interface ResolvedBridgeToolBinding {
  alias: string;
  capability: string;
  deviceId: string;
  allowedRoots: string[];
}

/**
 * Durable BullMQ Swarm Execution Engine.
 * Drives Supervisor Planning -> Concurrent DAG Worker Execution -> HITL/Bridge Gating -> Final Synthesis.
 */
export class SwarmExecutionRuntime {
  private mcpConnectionManager = new McpConnectionManager(
    process.env.NODE_ENV === "test" ? { allowLocalhost: true, allowHttp: true } : {}
  );
  private schemaValidator = new ToolSchemaValidator();
  private eventEmitChains = new Map<string, Promise<void>>();

  constructor(private readonly deps: SwarmRuntimeDependencies) {}

  private async emitRunEvent(params: {
    runId: string;
    workspaceId: string;
    threadId?: string | null;
    type: SwarmStreamEventType;
    taskId?: string | null;
    agentId?: string | null;
    payload: Record<string, unknown>;
  }): Promise<void> {
    const prev = this.eventEmitChains.get(params.runId) || Promise.resolve();
    const next = prev.then(async () => {
      const timestamp = new Date();
      let allocatedSeq = 1;

      for (let attempt = 0; attempt < 5; attempt++) {
        const maxRow = await prisma.agentRunEvent.findFirst({
          where: { runId: params.runId },
          orderBy: { sequence: "desc" },
          select: { sequence: true },
        });
        allocatedSeq = (maxRow?.sequence || 0) + 1;
        try {
          await prisma.agentRunEvent.create({
            data: {
              runId: params.runId,
              workspaceId: params.workspaceId,
              sequence: allocatedSeq,
              eventType: params.type,
              taskId: params.taskId || null,
              agentId: params.agentId || null,
              payload: params.payload as any,
            },
          });
          break;
        } catch (err: any) {
          if (err?.code === "P2002" && attempt < 4) {
            continue;
          }
          break;
        }
      }

      await this.deps.publishEvent({
        type: params.type,
        runId: params.runId,
        workspaceId: params.workspaceId,
        threadId: params.threadId,
        taskId: params.taskId || null,
        agentId: params.agentId || null,
        sequence: allocatedSeq,
        timestamp: timestamp.toISOString(),
        payload: params.payload,
      });
    });

    this.eventEmitChains.set(params.runId, next.catch(() => {}));
    await next;
  }

  private async resolveAgentDescriptor(
    agent: AgentDefinition & {
      providerConnection?: {
        id: string;
        provider: string;
        status: string;
        credential: {
          ciphertext: string;
          initializationVector: string;
          authenticationTag: string;
          keyVersion: string;
        } | null;
      } | null;
    },
    version?: AgentConfigurationVersion | null
  ): Promise<{ descriptor: AgentProfileDescriptor; apiKey: string | null }> {
    const connId = version?.providerConnectionId ?? agent.providerConnectionId;
    let conn = agent.providerConnection;
    if (connId && (!conn || conn.id !== connId)) {
      conn = await prisma.providerConnection.findUnique({
        where: { id: connId },
        include: { credential: true },
      });
    }

    let apiKey: string | null = null;
    if (conn && conn.status === "ACTIVE" && conn.credential) {
      apiKey = this.deps.decryptProviderSecret({
        ciphertext: conn.credential.ciphertext,
        initializationVector: conn.credential.initializationVector,
        authenticationTag: conn.credential.authenticationTag,
        keyVersion: conn.credential.keyVersion,
        providerConnectionId: conn.id,
        workspaceId: agent.workspaceId,
        provider: conn.provider,
      });
    }

    return {
      descriptor: {
        id: agent.id,
        name: version?.name || agent.name,
        roleTitle: version?.roleTitle || agent.roleTitle,
        category: agent.category,
        canSupervise: version?.canSupervise ?? agent.canSupervise,
        systemPrompt: version?.systemPrompt || agent.systemPrompt,
        providerConnectionId: conn?.id || null,
        provider: (conn?.provider as SupportedProviderId) || null,
        modelId: version?.modelId || agent.modelId,
        temperature: version?.temperature ?? agent.temperature,
        maxOutputTokens: version?.maxOutputTokens ?? agent.maxOutputTokens,
        allowedMcpToolIds: version?.allowedMcpToolIds || agent.allowedMcpToolIds || [],
        allowedBridgeCapabilities:
          version?.allowedBridgeCapabilities || agent.allowedBridgeCapabilities || [],
        preferredBridgeDeviceId: version?.preferredBridgeDeviceId ?? agent.preferredBridgeDeviceId,
      },
      apiKey,
    };
  }

  private async resolveScopedToolsForWorker(
    workspaceId: string,
    descriptor: AgentProfileDescriptor,
    explicitTargetDeviceId?: string | null
  ): Promise<{
    definitions: ProviderToolDefinition[];
    mcpBindings: Map<string, ResolvedMcpToolBinding>;
    bridgeBindings: Map<string, ResolvedBridgeToolBinding>;
  }> {
    const definitions: ProviderToolDefinition[] = [];
    const mcpBindings = new Map<string, ResolvedMcpToolBinding>();
    const bridgeBindings = new Map<string, ResolvedBridgeToolBinding>();

    // 1. Intersect agent.allowedMcpToolIds with live workspace CONNECTED servers & non-DISABLED permissions
    if (descriptor.allowedMcpToolIds.length > 0) {
      const tools = await prisma.mcpToolDefinition.findMany({
        where: {
          id: { in: descriptor.allowedMcpToolIds },
          isAvailable: true,
          connection: {
            workspaceId,
            status: "CONNECTED",
          },
        },
        include: {
          connection: true,
          permission: true,
        },
      });

      for (const tool of tools) {
        const permissionMode = tool.permission?.permissionMode || "REQUIRE_APPROVAL";
        if (permissionMode === "DISABLED") continue;

        const alias = generateToolAlias(tool.connection.name, tool.toolName, tool.connection.id);
        const inputSchema = (tool.inputSchema || {}) as Record<string, unknown>;
        const requiresApproval =
          permissionMode === "REQUIRE_APPROVAL" || Boolean(tool.permission?.requiresApproval);

        definitions.push(translateToProviderTool(alias, tool.description || undefined, inputSchema));
        mcpBindings.set(alias, {
          toolDefinitionId: tool.id,
          connectionId: tool.connection.id,
          connectionName: tool.connection.name,
          endpointUrl: tool.connection.endpointUrl,
          transportType: tool.connection.transportType,
          originalToolName: tool.toolName,
          providerToolAlias: alias,
          schemaHash: tool.schemaHash,
          inputSchema,
          requiresApproval,
          permissionMode,
        });
      }
    }

    // 2. Intersect agent.allowedBridgeCapabilities with target device capabilities & policy
    const deviceId = explicitTargetDeviceId || descriptor.preferredBridgeDeviceId;
    if (deviceId && descriptor.allowedBridgeCapabilities.length > 0) {
      const device = await prisma.bridgeDevice.findUnique({
        where: { id: deviceId },
      });

      if (device && device.workspaceId === workspaceId && device.status === "ACTIVE") {
        const policy = (device.devicePolicy as Record<string, unknown> | null) || {};
        const terminalDisabled = policy.terminalExecutionEnabled === false;

        for (const cap of descriptor.allowedBridgeCapabilities) {
          if (device.capabilities.length > 0 && !device.capabilities.includes(cap)) continue;
          if ((cap.startsWith("process.") || cap.startsWith("agent.")) && terminalDisabled) continue;

          const alias = `local_bridge__${cap.replace(/[^a-zA-Z0-9_]/g, "_")}`;
          definitions.push(
            translateToProviderTool(alias, `Execute Local Bridge capability '${cap}' on workstation '${device.displayName}'.`, {
              type: "object",
              properties: {
                resourceScopes: {
                  type: "array",
                  items: { type: "string" },
                  description: "Approved directory root paths within workstation allowedRoots.",
                },
                parameters: {
                  type: "object",
                  description: `Capability parameters for ${cap}.`,
                },
              },
              required: ["parameters"],
            })
          );
          bridgeBindings.set(alias, {
            alias,
            capability: cap,
            deviceId: device.id,
            allowedRoots: device.allowedRoots || [],
          });
        }
      }
    }

    return { definitions, mcpBindings, bridgeBindings };
  }

  private async checkCancelled(runId: string): Promise<boolean> {
    if (this.deps.isCancellationRequested && (await this.deps.isCancellationRequested(runId))) {
      return true;
    }
    const row = await prisma.agentRun.findUnique({
      where: { id: runId },
      select: { status: true, cancellationRequestedAt: true },
    });
    return Boolean(!row || row.cancellationRequestedAt || row.status === "CANCELLED");
  }

  private async checkBudgetExceeded(runId: string): Promise<{ exceeded: boolean; reason?: string }> {
    const run = await prisma.agentRun.findUnique({
      where: { id: runId },
      select: {
        inputTokens: true,
        outputTokens: true,
        maxTotalTokens: true,
        estimatedCostUsd: true,
        maxCostUsd: true,
        startedAt: true,
        maxDurationMs: true,
      },
    });
    if (!run) return { exceeded: true, reason: "RUN_MISSING" };

    const totalTokens = run.inputTokens + run.outputTokens;
    if (totalTokens > run.maxTotalTokens) {
      return {
        exceeded: true,
        reason: `TOKEN_BUDGET_EXCEEDED (${totalTokens} > ${run.maxTotalTokens})`,
      };
    }
    if (run.estimatedCostUsd > run.maxCostUsd) {
      return {
        exceeded: true,
        reason: `COST_BUDGET_EXCEEDED ($${run.estimatedCostUsd.toFixed(4)} > $${run.maxCostUsd.toFixed(2)})`,
      };
    }
    if (run.startedAt && Date.now() - run.startedAt.getTime() > run.maxDurationMs) {
      return {
        exceeded: true,
        reason: `DURATION_BUDGET_EXCEEDED (${run.maxDurationMs}ms)`,
      };
    }
    return { exceeded: false };
  }

  private async recordUsage(
    runId: string,
    provider: string,
    inputDelta: number,
    outputDelta: number
  ): Promise<void> {
    if (inputDelta <= 0 && outputDelta <= 0) return;
    const costDelta = estimateCostUsd(provider, inputDelta, outputDelta);
    const updated = await prisma.agentRun.update({
      where: { id: runId },
      data: {
        inputTokens: { increment: inputDelta },
        outputTokens: { increment: outputDelta },
        estimatedCostUsd: { increment: costDelta },
      },
      select: {
        workspaceId: true,
        threadId: true,
        inputTokens: true,
        outputTokens: true,
        estimatedCostUsd: true,
        maxTotalTokens: true,
        maxCostUsd: true,
      },
    });

    await this.deps.publishEvent({
      type: "swarm.budget.updated",
      runId,
      workspaceId: updated.workspaceId,
      threadId: updated.threadId,
      sequence: 0,
      timestamp: new Date().toISOString(),
      payload: {
        inputTokens: updated.inputTokens,
        outputTokens: updated.outputTokens,
        estimatedCostUsd: updated.estimatedCostUsd,
        maxTotalTokens: updated.maxTotalTokens,
        maxCostUsd: updated.maxCostUsd,
      },
    });
  }

  /**
   * Executes one full BullMQ cycle of an AgentRun (Plan -> Schedule/Resume Concurrent Tasks -> Synthesize).
   */
  public async processJob(payload: SwarmJobPayload): Promise<void> {
    const { runId } = payload;

    const run = await prisma.agentRun.findUnique({
      where: { id: runId },
      include: {
        supervisorAgent: { include: { providerConnection: { include: { credential: true } } } },
        supervisorVersion: true,
        tasks: {
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!run) return;
    if (
      run.status === "COMPLETED" ||
      run.status === "PARTIAL_COMPLETED" ||
      run.status === "FAILED" ||
      run.status === "CANCELLED"
    ) {
      return;
    }

    if (run.cancellationRequestedAt || (await this.checkCancelled(runId))) {
      await this.finalizeCancelled(runId, run.workspaceId, run.threadId, run.assistantMessageId);
      return;
    }

    const abortController = new AbortController();

    try {
      // Load all worker definitions + pinned versions for this run
      const workersRaw = await prisma.agentDefinition.findMany({
        where: {
          workspaceId: run.workspaceId,
          id: { in: run.workerAgentIds },
          status: "ACTIVE",
        },
        include: {
          providerConnection: { include: { credential: true } },
          versions: { orderBy: { versionNumber: "desc" }, take: 1 },
        },
      });

      const supervisorResolved = await this.resolveAgentDescriptor(
        run.supervisorAgent,
        run.supervisorVersion
      );
      if (!supervisorResolved.apiKey) {
        throw new SwarmPlanError(
          "SUPERVISOR_CREDENTIAL_UNAVAILABLE",
          "Supervisor agent provider credential is missing or inactive."
        );
      }

      const workerMap = new Map<
        string,
        {
          descriptor: AgentProfileDescriptor;
          apiKey: string | null;
          versionId: string | null;
        }
      >();

      for (const w of workersRaw) {
        const resolved = await this.resolveAgentDescriptor(w, w.versions[0] || null);
        workerMap.set(w.id, {
          ...resolved,
          versionId: w.versions[0]?.id || null,
        });
      }

      // Phase 1: Planning (if PENDING and no tasks generated yet)
      let currentRunStatus = run.status;
      if (currentRunStatus === "PENDING" && run.tasks.length === 0) {
        const claimed = await prisma.agentRun.updateMany({
          where: { id: runId, status: "PENDING" },
          data: { status: "PLANNING", startedAt: new Date() },
        });
        if (claimed.count === 0) return;

        await this.emitRunEvent({
          runId,
          workspaceId: run.workspaceId,
          threadId: run.threadId,
          type: "swarm.run.started",
          agentId: run.supervisorAgentId,
          payload: {
            objective: run.objective,
            supervisorAgentId: run.supervisorAgentId,
            workerAgentIds: run.workerAgentIds,
          },
        });

        const execRecord = await prisma.agentExecution.create({
          data: {
            runId,
            workspaceId: run.workspaceId,
            agentId: run.supervisorAgentId,
            versionId: run.supervisorVersionId,
            phase: "PLANNING",
            status: "RUNNING",
            providerConnectionId: supervisorResolved.descriptor.providerConnectionId,
            modelId: supervisorResolved.descriptor.modelId,
          },
        });

        const planStart = Date.now();
        const workersForPlanner = Array.from(workerMap.values()).map((w) => w.descriptor);
        if (workersForPlanner.length === 0) {
          throw new SwarmPlanError("NO_ACTIVE_WORKERS", "No active worker agents are available for this swarm.");
        }

        const { plan, usage } = await SwarmPlanner.generatePlan({
          supervisor: supervisorResolved.descriptor,
          supervisorApiKey: supervisorResolved.apiKey,
          workers: workersForPlanner,
          objective: run.objective,
          maxTasks: Math.min(24, workersForPlanner.length * 4),
          abortSignal: abortController.signal,
        });

        await this.recordUsage(
          runId,
          supervisorResolved.descriptor.provider || "openai",
          usage.inputTokens,
          usage.outputTokens
        );

        await prisma.agentExecution.update({
          where: { id: execRecord.id },
          data: {
            status: "SUCCEEDED",
            iterationsUsed: 1,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            durationMs: Date.now() - planStart,
            resultSummary: plan.goalSummary,
            completedAt: new Date(),
          },
        });

        const storedPlan: SwarmExecutionPlan = SwarmDagValidator.toStoredPlanJson(plan);

        // Persist DAG task rows atomically
        await prisma.$transaction(async (tx) => {
          for (const taskSpec of plan.tasks) {
            const assignedWorker = workerMap.get(taskSpec.assignedAgentId);
            await tx.agentTask.create({
              data: {
                runId,
                workspaceId: run.workspaceId,
                taskKey: taskSpec.taskKey,
                title: taskSpec.title,
                instructions: taskSpec.instructions,
                assignedAgentId: taskSpec.assignedAgentId,
                assignedVersionId: assignedWorker?.versionId || null,
                dependsOnKeys: taskSpec.dependsOnKeys,
                inputTaskKeys: taskSpec.inputTaskKeys,
                delegationDepth: 1,
                fingerprint: taskSpec.fingerprint,
                priority: taskSpec.priority ?? 0,
                maxIterations: Math.min(taskSpec.maxIterations ?? 4, 8),
                targetBridgeDeviceId:
                  taskSpec.targetBridgeDeviceId ||
                  assignedWorker?.descriptor.preferredBridgeDeviceId ||
                  null,
                status: "PENDING",
              },
            });
          }

          await tx.agentRun.update({
            where: { id: runId },
            data: {
              planJson: storedPlan as any,
              status: run.requirePlanApproval ? "AWAITING_PLAN_APPROVAL" : "RUNNING",
            },
          });
        });

        await this.emitRunEvent({
          runId,
          workspaceId: run.workspaceId,
          threadId: run.threadId,
          type: "swarm.run.planned",
          agentId: run.supervisorAgentId,
          payload: {
            plan: storedPlan,
            waves: plan.waves,
          },
        });

        if (run.requirePlanApproval) {
          await this.emitRunEvent({
            runId,
            workspaceId: run.workspaceId,
            threadId: run.threadId,
            type: "swarm.run.awaiting_plan_approval",
            agentId: run.supervisorAgentId,
            payload: { plan: storedPlan },
          });
          return;
        }
        currentRunStatus = "RUNNING";
      } else if (run.status === "AWAITING_PLAN_APPROVAL") {
        // Not approved yet
        if (!run.planApprovedAt) return;
        await prisma.agentRun.update({
          where: { id: runId },
          data: { status: "RUNNING" },
        });
        currentRunStatus = "RUNNING";
      } else if (run.status === "AWAITING_APPROVAL" || run.status === "PENDING") {
        // Resumption after HITL / Bridge approval
        await this.processResumedApprovals(runId, run.workspaceId, run.threadId);
        await prisma.agentRun.updateMany({
          where: { id: runId, status: { in: ["AWAITING_APPROVAL", "PENDING"] } },
          data: { status: "RUNNING" },
        });
        currentRunStatus = "RUNNING";
      }

      if (currentRunStatus !== "RUNNING") return;

      // Phase 2: Concurrent DAG Scheduling Loop
      let pausedForApproval = false;
      while (true) {
        if (await this.checkCancelled(runId)) {
          await this.finalizeCancelled(runId, run.workspaceId, run.threadId, run.assistantMessageId);
          return;
        }

        const budgetCheck = await this.checkBudgetExceeded(runId);
        if (budgetCheck.exceeded) {
          await this.finalizeFailed(
            runId,
            run.workspaceId,
            run.threadId,
            run.assistantMessageId,
            "BUDGET_EXCEEDED",
            budgetCheck.reason || "Swarm execution budget exceeded."
          );
          return;
        }

        const allTasks = await prisma.agentTask.findMany({
          where: { runId },
          orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
        });

        const byKey = new Map<string, AgentTask>(allTasks.map((t) => [t.taskKey, t]));

        // Skip any pending tasks whose upstream dependency failed/cancelled/skipped
        let markedSkipped = false;
        for (const t of allTasks) {
          if (t.status !== "PENDING") continue;
          const failedDep = t.dependsOnKeys.find((depKey) => {
            const dep = byKey.get(depKey);
            return (
              dep &&
              (dep.status === "FAILED" ||
                dep.status === "CANCELLED" ||
                dep.status === "SKIPPED" ||
                dep.status === "UNKNOWN_OUTCOME")
            );
          });
          if (failedDep) {
            await prisma.agentTask.update({
              where: { id: t.id },
              data: {
                status: "SKIPPED",
                errorCode: "DEPENDENCY_FAILED",
                errorMessage: `Upstream dependency '${failedDep}' did not complete cleanly.`,
                completedAt: new Date(),
              },
            });
            markedSkipped = true;
          }
        }
        if (markedSkipped) continue;

        const runningCount = allTasks.filter((t) => t.status === "RUNNING" || t.status === "QUEUED").length;
        const awaitingApprovalCount = allTasks.filter((t) => t.status === "AWAITING_APPROVAL").length;
        const pendingTasks = allTasks.filter((t) => t.status === "PENDING");

        if (pendingTasks.length === 0 && runningCount === 0) {
          if (awaitingApprovalCount > 0) {
            await prisma.agentRun.updateMany({
              where: { id: runId, status: "RUNNING" },
              data: { status: "AWAITING_APPROVAL" },
            });
            pausedForApproval = true;
          }
          break;
        }

        // Identify tasks with ALL dependencies COMPLETED
        const readyTasks = pendingTasks.filter((t) =>
          t.dependsOnKeys.every((depKey) => byKey.get(depKey)?.status === "COMPLETED")
        );

        if (readyTasks.length === 0) {
          if (awaitingApprovalCount > 0 && runningCount === 0) {
            await prisma.agentRun.updateMany({
              where: { id: runId, status: "RUNNING" },
              data: { status: "AWAITING_APPROVAL" },
            });
            pausedForApproval = true;
            break;
          }
          // Wait briefly if tasks are still executing (normal single-job concurrent pool handles via Promise.all below)
          break;
        }

        const availableSlots = Math.max(1, run.maxConcurrency - runningCount);
        const batch = readyTasks.slice(0, availableSlots);

        await Promise.all(
          batch.map((task) =>
            this.executeWorkerTask({
              run,
              task,
              byKey,
              workerMap,
              abortSignal: abortController.signal,
            })
          )
        );
      }

      if (pausedForApproval) {
        return;
      }

      if (await this.checkCancelled(runId)) {
        await this.finalizeCancelled(runId, run.workspaceId, run.threadId, run.assistantMessageId);
        return;
      }

      // Phase 3: Final Synthesis
      const finalTasks = await prisma.agentTask.findMany({
        where: { runId },
        include: { assignedAgent: true },
        orderBy: { createdAt: "asc" },
      });

      const completedCount = finalTasks.filter((t) => t.status === "COMPLETED").length;
      const failedCount = finalTasks.filter(
        (t) => t.status === "FAILED" || t.status === "SKIPPED" || t.status === "UNKNOWN_OUTCOME"
      ).length;

      if (completedCount === 0 && failedCount > 0) {
        const failureMessages = finalTasks
          .map((t) => `[${t.taskKey}] ${t.errorMessage || t.status}`)
          .join("; ");
        await this.finalizeFailed(
          runId,
          run.workspaceId,
          run.threadId,
          run.assistantMessageId,
          "ALL_TASKS_FAILED",
          `All swarm tasks failed: ${failureMessages}`
        );
        return;
      }

      await prisma.agentRun.update({
        where: { id: runId },
        data: { status: "SYNTHESIZING" },
      });

      const synthExec = await prisma.agentExecution.create({
        data: {
          runId,
          workspaceId: run.workspaceId,
          agentId: run.supervisorAgentId,
          versionId: run.supervisorVersionId,
          phase: "SYNTHESIS",
          status: "RUNNING",
          providerConnectionId: supervisorResolved.descriptor.providerConnectionId,
          modelId: supervisorResolved.descriptor.modelId,
        },
      });

      const taskResultsForSynthesis: ScopedUpstreamResult[] = finalTasks.map((t) => ({
        taskKey: t.taskKey,
        agentName: t.assignedAgent.name,
        roleTitle: t.assignedAgent.roleTitle,
        status: t.status,
        outputSummary:
          t.status === "COMPLETED"
            ? t.outputSummary || "Completed with no text output."
            : `Task did not complete (status=${t.status}): ${t.errorMessage || "unknown reason"}`,
      }));

      const synthStart = Date.now();
      const planGoalSummary =
        ((run.planJson as Record<string, unknown> | null)?.goalSummary as string) || run.objective;

      const { summary, usage } = await SwarmPlanner.synthesizeOutcome({
        supervisor: supervisorResolved.descriptor,
        supervisorApiKey: supervisorResolved.apiKey,
        objective: run.objective,
        goalSummary: planGoalSummary,
        taskResults: taskResultsForSynthesis,
        abortSignal: abortController.signal,
      });

      await this.recordUsage(
        runId,
        supervisorResolved.descriptor.provider || "openai",
        usage.inputTokens,
        usage.outputTokens
      );

      await prisma.agentExecution.update({
        where: { id: synthExec.id },
        data: {
          status: "SUCCEEDED",
          iterationsUsed: 1,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          durationMs: Date.now() - synthStart,
          resultSummary: summary.slice(0, 1000),
          completedAt: new Date(),
        },
      });

      const artifact = await prisma.agentArtifact.create({
        data: {
          runId,
          workspaceId: run.workspaceId,
          agentId: run.supervisorAgentId,
          artifactType: "REPORT",
          title: "Swarm Final Synthesis",
          content: summary,
          metadata: {
            completedCount,
            failedCount,
          },
        },
      });

      await this.emitRunEvent({
        runId,
        workspaceId: run.workspaceId,
        threadId: run.threadId,
        type: "swarm.artifact.created",
        agentId: run.supervisorAgentId,
        payload: {
          artifactId: artifact.id,
          title: artifact.title,
          artifactType: artifact.artifactType,
        },
      });

      const finalStatus = failedCount > 0 ? "PARTIAL_COMPLETED" : "COMPLETED";
      const completedAt = new Date();
      const updatedRun = await prisma.agentRun.update({
        where: { id: runId },
        data: {
          status: finalStatus,
          finalSummary: summary,
          completedAt,
        },
      });

      if (run.threadId && run.assistantMessageId && this.deps.publishThreadMessageUpdate) {
        await this.deps.publishThreadMessageUpdate({
          threadId: run.threadId,
          assistantMessageId: run.assistantMessageId,
          runId,
          status: "COMPLETED",
          content: summary,
        });
      }

      await this.emitRunEvent({
        runId,
        workspaceId: run.workspaceId,
        threadId: run.threadId,
        type: finalStatus === "PARTIAL_COMPLETED" ? "swarm.run.partial_completed" : "swarm.run.completed",
        agentId: run.supervisorAgentId,
        payload: {
          status: finalStatus,
          finalSummary: summary,
          inputTokens: updatedRun.inputTokens,
          outputTokens: updatedRun.outputTokens,
          estimatedCostUsd: updatedRun.estimatedCostUsd,
        },
      });
    } catch (err: unknown) {
      const code =
        err instanceof SwarmDagError || err instanceof SwarmPlanError
          ? err.code
          : err instanceof Error
          ? err.name
          : "SWARM_EXECUTION_ERROR";
      const message = err instanceof Error ? err.message : "Swarm execution failed.";

      await this.finalizeFailed(
        runId,
        run.workspaceId,
        run.threadId,
        run.assistantMessageId,
        code,
        SwarmContextBuilder.sanitizeInterAgentText(message, 2000)
      );
    }
  }

  private async invokeMcpTool(params: {
    workspaceId: string;
    connectionId: string;
    connectionName: string;
    endpointUrl: string;
    transportType: string;
    originalToolName: string;
    args: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<{ rawResult: unknown; isError: boolean }> {
    const conn = await prisma.mcpServerConnection.findUnique({
      where: { id: params.connectionId },
      include: { credential: true },
    });
    if (!conn) {
      throw new Error("MCP server connection not found.");
    }

    let bearerToken: string | undefined;
    if (conn.credential?.encryptedAccessToken && this.deps.decryptMcpSecret) {
      try {
        bearerToken = this.deps.decryptMcpSecret(conn.credential.encryptedAccessToken, {
          workspaceId: params.workspaceId,
          connectionId: params.connectionId,
          keyVersion: conn.credential.encryptionKeyVersion || "v2",
        });
      } catch {}
    }

    let session = this.mcpConnectionManager.getSession(params.workspaceId, params.connectionId);
    if (!session) {
      session = await this.mcpConnectionManager.connect({
        connectionId: params.connectionId,
        workspaceId: params.workspaceId,
        name: params.connectionName,
        endpointUrl: params.endpointUrl,
        transportType: params.transportType as "STREAMABLE_HTTP" | "SSE",
        authType: conn.credential?.authType || "NONE",
        bearerToken,
      });
    }

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), params.timeoutMs || 30_000);
    try {
      const res = await session.client.callTool(
        {
          name: params.originalToolName,
          arguments: params.args,
        },
        { signal: abortController.signal }
      );
      return {
        rawResult: res,
        isError: Boolean(res.isError),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async processResumedApprovals(
    runId: string,
    workspaceId: string,
    threadId?: string | null
  ): Promise<void> {
    // 1. Execute any newly APPROVED MCP ToolCalls attached to this AgentRun
    const pendingToolCalls = await prisma.toolCall.findMany({
      where: {
        agentRunId: runId,
        status: { in: ["APPROVED", "DENIED"] },
        completedAt: null,
      },
      include: {
        connection: true,
        toolDefinition: true,
      },
    });

    for (const tc of pendingToolCalls) {
      if (tc.status === "DENIED") {
        await prisma.toolCall.update({
          where: { id: tc.id },
          data: { completedAt: new Date() },
        });
        if (tc.agentTaskId) {
          await prisma.agentTask.update({
            where: { id: tc.agentTaskId },
            data: {
              status: "FAILED",
              errorCode: "APPROVAL_DENIED",
              errorMessage: tc.errorMessage || "Human denied required tool execution.",
              completedAt: new Date(),
            },
          });
        }
        continue;
      }

      const started = Date.now();
      try {
        const res = await this.invokeMcpTool({
          workspaceId,
          connectionId: tc.connectionId,
          connectionName: tc.connection.name,
          endpointUrl: tc.connection.endpointUrl,
          transportType: tc.connection.transportType,
          originalToolName: tc.toolName,
          args: (tc.argumentsPreview as Record<string, unknown>) || {},
        });
        const sanitized = toolResultSanitizer.sanitize(res.rawResult);
        await prisma.toolCall.update({
          where: { id: tc.id },
          data: {
            status: res.isError ? "FAILED" : "SUCCEEDED",
            result: sanitized as any,
            isError: res.isError,
            durationMs: Date.now() - started,
            completedAt: new Date(),
          },
        });

        await this.emitRunEvent({
          runId,
          workspaceId,
          threadId,
          taskId: tc.agentTaskId,
          type: "swarm.agent.tool_result",
          payload: {
            toolCallId: tc.id,
            toolName: tc.toolName,
            status: res.isError ? "FAILED" : "SUCCEEDED",
            text: sanitized.content.slice(0, 2000),
          },
        });

        if (tc.agentTaskId) {
          await prisma.agentTask.update({
            where: { id: tc.agentTaskId },
            data: {
              status: "PENDING",
              outputData: {
                lastApprovedToolResult: {
                  toolName: tc.toolName,
                  text: sanitized.content,
                  isError: res.isError,
                },
              } as any,
            },
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "MCP tool failed during resumed execution";
        const isUnknownOutcome = /ECONNRESET|ETIMEDOUT|UND_ERR_SOCKET|504/i.test(msg);
        await prisma.toolCall.update({
          where: { id: tc.id },
          data: {
            status: isUnknownOutcome ? "UNKNOWN_OUTCOME" : "FAILED",
            isError: true,
            errorMessage: msg,
            durationMs: Date.now() - started,
            completedAt: new Date(),
          },
        });
        if (tc.agentTaskId) {
          await prisma.agentTask.update({
            where: { id: tc.agentTaskId },
            data: {
              status: isUnknownOutcome ? "UNKNOWN_OUTCOME" : "FAILED",
              errorCode: isUnknownOutcome ? "UNKNOWN_OUTCOME" : "TOOL_EXECUTION_FAILED",
              errorMessage: msg,
              completedAt: new Date(),
            },
          });
        }
      }
    }

    // 2. Sync any BridgeTasks linked to this AgentRun
    const tasksAwaiting = await prisma.agentTask.findMany({
      where: { runId, status: "AWAITING_APPROVAL" },
      include: { bridgeTasks: true },
    });

    for (const task of tasksAwaiting) {
      if (task.bridgeTasks.length === 0) continue;
      const latestBridge = task.bridgeTasks[task.bridgeTasks.length - 1]!;
      if (latestBridge.status === "SUCCEEDED") {
        await prisma.agentTask.update({
          where: { id: task.id },
          data: {
            status: "PENDING",
            outputData: {
              lastApprovedBridgeResult: latestBridge.result,
            } as any,
          },
        });
      } else if (
        latestBridge.status === "FAILED" ||
        latestBridge.status === "EXPIRED" ||
        latestBridge.status === "CANCELLED" ||
        latestBridge.status === "UNKNOWN_OUTCOME"
      ) {
        await prisma.agentTask.update({
          where: { id: task.id },
          data: {
            status: latestBridge.status === "UNKNOWN_OUTCOME" ? "UNKNOWN_OUTCOME" : "FAILED",
            errorCode: latestBridge.status,
            errorMessage: latestBridge.errorMessage || `Bridge task terminated with ${latestBridge.status}.`,
            completedAt: new Date(),
          },
        });
      }
    }
  }

  private async executeWorkerTask(params: {
    run: any;
    task: AgentTask;
    byKey: Map<string, AgentTask>;
    workerMap: Map<string, { descriptor: AgentProfileDescriptor; apiKey: string | null; versionId: string | null }>;
    abortSignal: AbortSignal;
  }): Promise<void> {
    const { run, task, byKey, workerMap, abortSignal } = params;
    const worker = workerMap.get(task.assignedAgentId);

    const claim = await prisma.agentTask.updateMany({
      where: { id: task.id, status: "PENDING" },
      data: {
        status: "RUNNING",
        attemptCount: { increment: 1 },
        startedAt: task.startedAt || new Date(),
      },
    });
    if (claim.count === 0) return;

    await this.emitRunEvent({
      runId: run.id,
      workspaceId: run.workspaceId,
      threadId: run.threadId,
      taskId: task.id,
      agentId: task.assignedAgentId,
      type: "swarm.task.queued",
      payload: { taskKey: task.taskKey, title: task.title },
    });

    if (!worker || !worker.apiKey || !worker.descriptor.provider || !worker.descriptor.modelId) {
      await prisma.agentTask.update({
        where: { id: task.id },
        data: {
          status: "FAILED",
          errorCode: "WORKER_UNCONFIGURED",
          errorMessage: "Assigned worker agent is missing active provider credentials or model ID.",
          completedAt: new Date(),
        },
      });
      await this.emitRunEvent({
        runId: run.id,
        workspaceId: run.workspaceId,
        threadId: run.threadId,
        taskId: task.id,
        agentId: task.assignedAgentId,
        type: "swarm.agent.failed",
        payload: { taskKey: task.taskKey, code: "WORKER_UNCONFIGURED" },
      });
      return;
    }

    const execStart = Date.now();
    const execution = await prisma.agentExecution.create({
      data: {
        runId: run.id,
        taskId: task.id,
        workspaceId: run.workspaceId,
        agentId: worker.descriptor.id,
        versionId: worker.versionId,
        phase: "TASK_EXECUTION",
        status: "RUNNING",
        providerConnectionId: worker.descriptor.providerConnectionId,
        modelId: worker.descriptor.modelId,
      },
    });

    // Record scoped supervisor -> worker delegation message
    const delegationSummary = SwarmContextBuilder.sanitizeInterAgentText(
      `Task [${task.taskKey}] ${task.title}: ${task.instructions}`,
      2000
    );
    await prisma.agentCommunication.create({
      data: {
        runId: run.id,
        taskId: task.id,
        workspaceId: run.workspaceId,
        fromAgentId: run.supervisorAgentId,
        toAgentId: worker.descriptor.id,
        messageType: "DELEGATION",
        summary: delegationSummary,
        payloadDigest: SwarmContextBuilder.computeDigest(delegationSummary),
      },
    });

    await this.emitRunEvent({
      runId: run.id,
      workspaceId: run.workspaceId,
      threadId: run.threadId,
      taskId: task.id,
      agentId: worker.descriptor.id,
      type: "swarm.agent.started",
      payload: {
        taskKey: task.taskKey,
        title: task.title,
        agentName: worker.descriptor.name,
        modelId: worker.descriptor.modelId,
      },
    });

    try {
      const upstreamResults: ScopedUpstreamResult[] = [];
      for (const depKey of task.inputTaskKeys) {
        const depTask = byKey.get(depKey);
        if (!depTask) continue;
        const depAgent = workerMap.get(depTask.assignedAgentId)?.descriptor;
        upstreamResults.push({
          taskKey: depTask.taskKey,
          agentName: depAgent?.name || "Upstream Agent",
          roleTitle: depAgent?.roleTitle || "Worker",
          status: depTask.status,
          outputSummary: depTask.outputSummary || "",
        });
      }

      const { definitions, mcpBindings, bridgeBindings } = await this.resolveScopedToolsForWorker(
        run.workspaceId,
        worker.descriptor,
        task.targetBridgeDeviceId
      );

      const toolDescriptions = definitions.map((d) => `${d.name}: ${d.description || ""}`);
      const messages: ProviderChatMessage[] = SwarmContextBuilder.buildWorkerMessages({
        agentName: worker.descriptor.name,
        roleTitle: worker.descriptor.roleTitle,
        systemPrompt: worker.descriptor.systemPrompt,
        objective: run.objective,
        taskKey: task.taskKey,
        taskTitle: task.title,
        taskInstructions: task.instructions,
        upstreamResults,
        availableToolDescriptions: toolDescriptions,
      });

      const priorData = task.outputData as Record<string, unknown> | null;
      if (priorData?.lastApprovedToolResult) {
        messages.push({
          role: "user",
          content: `Resuming after human approval. Approved tool outcome:\n${JSON.stringify(
            priorData.lastApprovedToolResult
          )}\nComplete the task now.`,
        });
      } else if (priorData?.lastApprovedBridgeResult) {
        messages.push({
          role: "user",
          content: `Resuming after human approval. Approved Local Bridge execution result:\n${JSON.stringify(
            priorData.lastApprovedBridgeResult
          )}\nComplete the task now.`,
        });
      }

      const adapter = defaultProviderRegistry.getAdapter(worker.descriptor.provider);
      let taskInputTokens = 0;
      let taskOutputTokens = 0;
      let finalAnswer = "";
      let iterations = 0;
      const toolCallIds: string[] = [];
      const bridgeTaskIds: string[] = [];

      for (let round = 0; round < task.maxIterations; round++) {
        if (abortSignal.aborted || (await this.checkCancelled(run.id))) {
          throw new Error("SWARM_CANCELLED");
        }

        const budget = await this.checkBudgetExceeded(run.id);
        if (budget.exceeded) {
          throw new Error(budget.reason || "BUDGET_EXCEEDED");
        }

        iterations++;
        let roundText = "";
        let roundIn = 0;
        let roundOut = 0;
        const proposedCallsMap = new Map<
          string,
          { callId: string; toolAlias: string; argumentsVal: Record<string, unknown> | string }
        >();
        let lastEmittedLen = 0;

        for await (const chunk of adapter.streamResponse(
          {
            credentials: { apiKey: worker.apiKey },
            model: worker.descriptor.modelId,
            messages,
            temperature: worker.descriptor.temperature,
            maxTokens: worker.descriptor.maxOutputTokens,
            tools: definitions.length > 0 ? definitions : undefined,
          },
          abortSignal
        )) {
          if (chunk.type === "text_delta" && chunk.text) {
            roundText += chunk.text;
            if (roundText.length - lastEmittedLen >= 160) {
              lastEmittedLen = roundText.length;
              await this.emitRunEvent({
                runId: run.id,
                workspaceId: run.workspaceId,
                threadId: run.threadId,
                taskId: task.id,
                agentId: worker.descriptor.id,
                type: "swarm.agent.message",
                payload: {
                  taskKey: task.taskKey,
                  delta: chunk.text,
                  preview: SwarmContextBuilder.sanitizeInterAgentText(roundText, 600),
                },
              });
            }
          } else if ((chunk.type === "tool_call" || chunk.type === "tool_call_done") && chunk.callId) {
            proposedCallsMap.set(chunk.callId, {
              callId: chunk.callId,
              toolAlias: chunk.toolName,
              argumentsVal: chunk.arguments,
            });
          } else if (chunk.type === "usage") {
            roundIn = chunk.inputTokens || roundIn;
            roundOut = chunk.outputTokens || roundOut;
          }
        }

        const proposedCalls = Array.from(proposedCallsMap.values());
        taskInputTokens += roundIn;
        taskOutputTokens += roundOut;
        await this.recordUsage(run.id, worker.descriptor.provider, roundIn, roundOut);

        if (proposedCalls.length === 0) {
          finalAnswer = roundText;
          break;
        }

        // Execute proposed tool calls strictly within agent's authorized scope
        messages.push({
          role: "assistant",
          content: roundText,
          toolCalls: proposedCalls.map((c) => ({
            providerCallId: c.callId,
            toolName: c.toolAlias,
            arguments: c.argumentsVal,
          })),
        });

        const toolResultMessages: ProviderChatMessage[] = [];
        let pausedForHumanApproval = false;

        for (const call of proposedCalls) {
          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs =
              typeof call.argumentsVal === "string"
                ? call.argumentsVal
                  ? JSON.parse(call.argumentsVal)
                  : {}
                : (call.argumentsVal as Record<string, unknown>) || {};
          } catch {
            parsedArgs = {};
          }

          const bridgeBinding = bridgeBindings.get(call.toolAlias);
          if (bridgeBinding) {
            if (!this.deps.dispatchBridgeTask) {
              toolResultMessages.push({
                role: "tool",
                toolCallId: call.callId,
                toolName: call.toolAlias,
                content: "ERROR: Local Bridge dispatch is not enabled in this runtime.",
              });
              continue;
            }

            await this.emitRunEvent({
              runId: run.id,
              workspaceId: run.workspaceId,
              threadId: run.threadId,
              taskId: task.id,
              agentId: worker.descriptor.id,
              type: "swarm.agent.tool_call",
              payload: {
                taskKey: task.taskKey,
                toolType: "bridge",
                capability: bridgeBinding.capability,
                deviceId: bridgeBinding.deviceId,
              },
            });

            const bridgeRes = await this.deps.dispatchBridgeTask({
              workspaceId: run.workspaceId,
              userId: run.createdByUserId || "",
              deviceId: bridgeBinding.deviceId,
              capability: bridgeBinding.capability,
              resourceScopes: Array.isArray(parsedArgs.resourceScopes)
                ? (parsedArgs.resourceScopes as string[])
                : bridgeBinding.allowedRoots.slice(0, 1),
              parameters:
                typeof parsedArgs.parameters === "object" && parsedArgs.parameters
                  ? (parsedArgs.parameters as Record<string, unknown>)
                  : parsedArgs,
              agentRunId: run.id,
              agentTaskId: task.id,
              threadId: run.threadId || undefined,
            });

            bridgeTaskIds.push(bridgeRes.bridgeTaskId);
            if (bridgeRes.status === "AWAITING_APPROVAL") {
              pausedForHumanApproval = true;
              await prisma.agentTask.update({
                where: { id: task.id },
                data: {
                  status: "AWAITING_APPROVAL",
                  inputTokens: { increment: taskInputTokens },
                  outputTokens: { increment: taskOutputTokens },
                },
              });
              await prisma.agentExecution.update({
                where: { id: execution.id },
                data: {
                  status: "AWAITING_APPROVAL",
                  iterationsUsed: iterations,
                  bridgeTaskIds,
                  inputTokens: taskInputTokens,
                  outputTokens: taskOutputTokens,
                },
              });
              await this.emitRunEvent({
                runId: run.id,
                workspaceId: run.workspaceId,
                threadId: run.threadId,
                taskId: task.id,
                agentId: worker.descriptor.id,
                type: "swarm.agent.approval_requested",
                payload: {
                  kind: "bridge_task",
                  bridgeTaskId: bridgeRes.bridgeTaskId,
                  capability: bridgeBinding.capability,
                  taskKey: task.taskKey,
                },
              });
              break;
            }

            toolResultMessages.push({
              role: "tool",
              toolCallId: call.callId,
              toolName: call.toolAlias,
              content: SwarmContextBuilder.sanitizeInterAgentText(
                JSON.stringify(bridgeRes.result || { status: bridgeRes.status, error: bridgeRes.errorMessage }),
                6000
              ),
            });
            continue;
          }

          const mcpBinding = mcpBindings.get(call.toolAlias);
          if (!mcpBinding) {
            toolResultMessages.push({
              role: "tool",
              toolCallId: call.callId,
              toolName: call.toolAlias,
              content: `ERROR: Tool '${call.toolAlias}' is not authorized for this agent.`,
            });
            continue;
          }

          const val = this.schemaValidator.validateArguments(mcpBinding.inputSchema, parsedArgs);
          if (!val.valid) {
            toolResultMessages.push({
              role: "tool",
              toolCallId: call.callId,
              toolName: call.toolAlias,
              content: `VALIDATION_ERROR: ${(val.errors || []).join("; ")}`,
            });
            continue;
          }

          const argsHash = computeArgumentsHash(parsedArgs);
          const argsPreview = sanitizeArgumentsPreview(parsedArgs);

          await this.emitRunEvent({
            runId: run.id,
            workspaceId: run.workspaceId,
            threadId: run.threadId,
            taskId: task.id,
            agentId: worker.descriptor.id,
            type: "swarm.agent.tool_call",
            payload: {
              taskKey: task.taskKey,
              toolType: "mcp",
              toolName: mcpBinding.originalToolName,
              connectionName: mcpBinding.connectionName,
              argumentsPreview: argsPreview,
            },
          });

          if (mcpBinding.requiresApproval) {
            // Create durable ToolCall + ToolApproval linked to this AgentRun + AgentTask
            const tc = await prisma.toolCall.create({
              data: {
                agentRunId: run.id,
                agentTaskId: task.id,
                workspaceId: run.workspaceId,
                toolDefinitionId: mcpBinding.toolDefinitionId,
                connectionId: mcpBinding.connectionId,
                providerCallId: call.callId,
                providerToolAlias: call.toolAlias,
                toolName: mcpBinding.originalToolName,
                schemaHash: mcpBinding.schemaHash,
                argumentsHash: argsHash,
                argumentsPreview: argsPreview as any,
                status: "AWAITING_APPROVAL",
              },
            });

            const approval = await prisma.toolApproval.create({
              data: {
                toolCallId: tc.id,
                workspaceId: run.workspaceId,
                requestedByUserId: run.createdByUserId || null,
                status: "PENDING",
                argumentsHash: argsHash,
                schemaHash: mcpBinding.schemaHash,
                expiresAt: new Date(Date.now() + 5 * 60 * 1000),
              },
            });

            toolCallIds.push(tc.id);
            pausedForHumanApproval = true;

            await prisma.agentTask.update({
              where: { id: task.id },
              data: {
                status: "AWAITING_APPROVAL",
                inputTokens: { increment: taskInputTokens },
                outputTokens: { increment: taskOutputTokens },
              },
            });
            await prisma.agentExecution.update({
              where: { id: execution.id },
              data: {
                status: "AWAITING_APPROVAL",
                iterationsUsed: iterations,
                toolCallIds,
                inputTokens: taskInputTokens,
                outputTokens: taskOutputTokens,
              },
            });

            await this.emitRunEvent({
              runId: run.id,
              workspaceId: run.workspaceId,
              threadId: run.threadId,
              taskId: task.id,
              agentId: worker.descriptor.id,
              type: "swarm.agent.approval_requested",
              payload: {
                kind: "mcp_tool",
                approvalId: approval.id,
                toolCallId: tc.id,
                toolName: mcpBinding.originalToolName,
                argumentsPreview: argsPreview,
                taskKey: task.taskKey,
              },
            });
            break;
          }

          // Safe read-only / explicitly authorized MCP execution
          const toolStart = Date.now();
          const tc = await prisma.toolCall.create({
            data: {
              agentRunId: run.id,
              agentTaskId: task.id,
              workspaceId: run.workspaceId,
              toolDefinitionId: mcpBinding.toolDefinitionId,
              connectionId: mcpBinding.connectionId,
              providerCallId: call.callId,
              providerToolAlias: call.toolAlias,
              toolName: mcpBinding.originalToolName,
              schemaHash: mcpBinding.schemaHash,
              argumentsHash: argsHash,
              argumentsPreview: argsPreview as any,
              status: "EXECUTING",
            },
          });
          toolCallIds.push(tc.id);

          try {
            const res = await this.invokeMcpTool({
              workspaceId: run.workspaceId,
              connectionId: mcpBinding.connectionId,
              connectionName: mcpBinding.connectionName,
              endpointUrl: mcpBinding.endpointUrl,
              transportType: mcpBinding.transportType,
              originalToolName: mcpBinding.originalToolName,
              args: parsedArgs,
            });
            const sanitized = toolResultSanitizer.sanitize(res.rawResult);
            await prisma.toolCall.update({
              where: { id: tc.id },
              data: {
                status: res.isError ? "FAILED" : "SUCCEEDED",
                result: sanitized as any,
                isError: res.isError,
                durationMs: Date.now() - toolStart,
                completedAt: new Date(),
              },
            });

            await this.emitRunEvent({
              runId: run.id,
              workspaceId: run.workspaceId,
              threadId: run.threadId,
              taskId: task.id,
              agentId: worker.descriptor.id,
              type: "swarm.agent.tool_result",
              payload: {
                toolCallId: tc.id,
                toolName: mcpBinding.originalToolName,
                status: res.isError ? "FAILED" : "SUCCEEDED",
                text: sanitized.content.slice(0, 1200),
              },
            });

            toolResultMessages.push({
              role: "tool",
              toolCallId: call.callId,
              toolName: call.toolAlias,
              content: sanitized.content,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : "MCP invocation failed";
            const isUnknown = /ECONNRESET|ETIMEDOUT|UND_ERR_SOCKET|504/i.test(msg);
            await prisma.toolCall.update({
              where: { id: tc.id },
              data: {
                status: isUnknown ? "UNKNOWN_OUTCOME" : "FAILED",
                isError: true,
                errorMessage: msg,
                durationMs: Date.now() - toolStart,
                completedAt: new Date(),
              },
            });
            toolResultMessages.push({
              role: "tool",
              toolCallId: call.callId,
              toolName: call.toolAlias,
              content: `ERROR (${isUnknown ? "UNKNOWN_OUTCOME" : "FAILED"}): ${msg}`,
            });
          }
        }

        if (pausedForHumanApproval) {
          return;
        }

        messages.push(...toolResultMessages);
      }

      const cleanOutput = SwarmContextBuilder.sanitizeInterAgentText(
        finalAnswer || "Task finished.",
        12000
      );

      await prisma.agentTask.update({
        where: { id: task.id },
        data: {
          status: "COMPLETED",
          outputSummary: cleanOutput,
          inputTokens: { increment: taskInputTokens },
          outputTokens: { increment: taskOutputTokens },
          completedAt: new Date(),
        },
      });

      await prisma.agentExecution.update({
        where: { id: execution.id },
        data: {
          status: "SUCCEEDED",
          iterationsUsed: iterations,
          toolCallIds,
          bridgeTaskIds,
          inputTokens: taskInputTokens,
          outputTokens: taskOutputTokens,
          durationMs: Date.now() - execStart,
          resultSummary: cleanOutput.slice(0, 1000),
          completedAt: new Date(),
        },
      });

      await prisma.agentCommunication.create({
        data: {
          runId: run.id,
          taskId: task.id,
          workspaceId: run.workspaceId,
          fromAgentId: worker.descriptor.id,
          toAgentId: run.supervisorAgentId,
          messageType: "RESULT",
          summary: cleanOutput.slice(0, 4000),
          payloadDigest: SwarmContextBuilder.computeDigest(cleanOutput),
        },
      });

      await this.emitRunEvent({
        runId: run.id,
        workspaceId: run.workspaceId,
        threadId: run.threadId,
        taskId: task.id,
        agentId: worker.descriptor.id,
        type: "swarm.agent.completed",
        payload: {
          taskKey: task.taskKey,
          title: task.title,
          outputPreview: cleanOutput.slice(0, 500),
          inputTokens: taskInputTokens,
          outputTokens: taskOutputTokens,
        },
      });
    } catch (err: unknown) {
      const msg = SwarmContextBuilder.sanitizeInterAgentText(
        err instanceof Error ? err.message : "Worker task failed.",
        2000
      );
      const isCancelled = msg === "SWARM_CANCELLED";

      await prisma.agentTask.update({
        where: { id: task.id },
        data: {
          status: isCancelled ? "CANCELLED" : "FAILED",
          errorCode: isCancelled ? "CANCELLED" : "WORKER_EXECUTION_FAILED",
          errorMessage: msg,
          completedAt: new Date(),
        },
      });

      await prisma.agentExecution.update({
        where: { id: execution.id },
        data: {
          status: isCancelled ? "CANCELLED" : "FAILED",
          durationMs: Date.now() - execStart,
          errorMessage: msg,
          completedAt: new Date(),
        },
      });

      await prisma.agentCommunication.create({
        data: {
          runId: run.id,
          taskId: task.id,
          workspaceId: run.workspaceId,
          fromAgentId: worker.descriptor.id,
          toAgentId: run.supervisorAgentId,
          messageType: "FAILURE",
          summary: msg,
          payloadDigest: SwarmContextBuilder.computeDigest(msg),
        },
      });

      await this.emitRunEvent({
        runId: run.id,
        workspaceId: run.workspaceId,
        threadId: run.threadId,
        taskId: task.id,
        agentId: worker.descriptor.id,
        type: "swarm.agent.failed",
        payload: {
          taskKey: task.taskKey,
          errorMessage: msg,
        },
      });
    }
  }

  private async finalizeCancelled(
    runId: string,
    workspaceId: string,
    threadId?: string | null,
    assistantMessageId?: string | null
  ): Promise<void> {
    const now = new Date();
    await prisma.$transaction([
      prisma.agentTask.updateMany({
        where: { runId, status: { in: ["PENDING", "QUEUED", "RUNNING", "AWAITING_APPROVAL"] } },
        data: { status: "CANCELLED", completedAt: now },
      }),
      prisma.agentRun.updateMany({
        where: { id: runId, status: { notIn: ["COMPLETED", "FAILED", "CANCELLED"] } },
        data: { status: "CANCELLED", safeErrorCode: "USER_CANCELLED", completedAt: now },
      }),
    ]).catch(() => {});

    if (threadId && assistantMessageId && this.deps.publishThreadMessageUpdate) {
      await this.deps.publishThreadMessageUpdate({
        threadId,
        assistantMessageId,
        runId,
        status: "CANCELLED",
        content: "Swarm run cancelled by user.",
      });
    }

    await this.emitRunEvent({
      runId,
      workspaceId,
      threadId,
      type: "swarm.run.cancelled",
      payload: { status: "CANCELLED" },
    });
  }

  private async finalizeFailed(
    runId: string,
    workspaceId: string,
    threadId: string | null | undefined,
    assistantMessageId: string | null | undefined,
    safeErrorCode: string,
    errorMessage: string
  ): Promise<void> {
    const now = new Date();
    await prisma.$transaction([
      prisma.agentTask.updateMany({
        where: { runId, status: { in: ["PENDING", "QUEUED", "RUNNING"] } },
        data: { status: "CANCELLED", completedAt: now },
      }),
      prisma.agentRun.updateMany({
        where: { id: runId, status: { notIn: ["COMPLETED", "PARTIAL_COMPLETED", "FAILED", "CANCELLED"] } },
        data: {
          status: "FAILED",
          safeErrorCode,
          errorMessage,
          completedAt: now,
        },
      }),
    ]).catch(() => {});

    if (threadId && assistantMessageId && this.deps.publishThreadMessageUpdate) {
      await this.deps.publishThreadMessageUpdate({
        threadId,
        assistantMessageId,
        runId,
        status: "FAILED",
        content: `Swarm execution failed (${safeErrorCode}): ${errorMessage}`,
      });
    }

    await this.emitRunEvent({
      runId,
      workspaceId,
      threadId,
      type: "swarm.run.failed",
      payload: { status: "FAILED", safeErrorCode, errorMessage },
    });
  }
}
