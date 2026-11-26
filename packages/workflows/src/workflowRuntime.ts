import {
  prisma,
  type WorkflowNodeExecution,
  type WorkflowRun,
} from "@messiah/db";
import {
  WORKFLOW_CONSTANTS,
  type MemoryScope,
  type SupportedProviderId,
  type WorkflowGraphDefinition,
  type WorkflowNodeSpec,
  type WorkflowStreamEvent,
  type WorkflowStreamEventType,
} from "@messiah/shared";
import {
  defaultProviderRegistry,
  type ProviderChatMessage,
} from "@messiah/providers";
import { MemoryService } from "@messiah/memory";
import {
  McpConnectionManager,
  ToolSchemaValidator,
  toolResultSanitizer,
  computeArgumentsHash,
} from "@messiah/mcp";
import { SwarmDagValidator, SwarmPlanner } from "@messiah/agents";
import { SafeExpressionEvaluator, SafeTransformEngine, renderSafeTemplate, renderTemplateValue } from "./safeEvaluator.js";

export interface WorkflowJobPayload {
  kind: "workflow.execute";
  runId: string;
  outboxEventId?: string;
  workspaceId: string;
  userId?: string | null;
}

export interface WorkflowCredentialDecryptInput {
  ciphertext: string;
  initializationVector: string;
  authenticationTag: string;
  keyVersion: string;
  providerConnectionId: string;
  workspaceId: string;
  provider: string;
}

export interface WorkflowBridgeDispatchParams {
  workspaceId: string;
  userId: string;
  deviceId: string;
  capability: string;
  resourceScopes: string[];
  parameters: Record<string, unknown>;
  workflowRunId: string;
  workflowNodeExecId: string;
}

export interface WorkflowBridgeDispatchResult {
  bridgeTaskId: string;
  status: string;
  result?: unknown;
  errorMessage?: string | null;
}

export interface WorkflowRuntimeDependencies {
  decryptProviderSecret: (input: WorkflowCredentialDecryptInput) => string;
  decryptMcpSecret?: (
    encryptedValue: string,
    context: { workspaceId: string; connectionId: string; keyVersion: string }
  ) => string;
  publishEvent: (event: WorkflowStreamEvent) => Promise<void>;
  dispatchBridgeTask?: (
    params: WorkflowBridgeDispatchParams
  ) => Promise<WorkflowBridgeDispatchResult>;
  isCancellationRequested?: (runId: string) => Promise<boolean>;
  onWorkflowTerminal?: (params: {
    runId: string;
    workflowId: string;
    workspaceId: string;
    status: string;
    summary: string;
    recursionDepth: number;
    correlationId?: string | null;
    triggeredByUserId?: string | null;
  }) => Promise<void>;
}

const SIDE_EFFECT_FREE_NODES = new Set([
  "manual_trigger",
  "schedule_trigger",
  "event_trigger",
  "condition",
  "transform",
  "merge",
  "completion",
]);

function isNodeTerminal(status: string): boolean {
  return (
    status === "COMPLETED" ||
    status === "FAILED" ||
    status === "SKIPPED" ||
    status === "CANCELLED" ||
    status === "UNKNOWN_OUTCOME"
  );
}

function isRunTerminal(status: string): boolean {
  return (
    status === "COMPLETED" ||
    status === "PARTIAL_COMPLETED" ||
    status === "FAILED" ||
    status === "CANCELLED"
  );
}

export class WorkflowExecutionRuntime {
  private mcpConnectionManager = new McpConnectionManager(
    process.env.NODE_ENV === "test" ? { allowLocalhost: true, allowHttp: true } : {}
  );
  private schemaValidator = new ToolSchemaValidator();
  private memoryService: MemoryService;
  private eventChains = new Map<string, Promise<void>>();

  constructor(private readonly deps: WorkflowRuntimeDependencies) {
    this.memoryService = new MemoryService({
      decryptProviderSecret: this.deps.decryptProviderSecret,
    });
  }

  private async emitRunEvent(params: {
    runId: string;
    workflowId: string;
    workspaceId: string;
    type: WorkflowStreamEventType;
    nodeId?: string | null;
    payload: Record<string, unknown>;
  }): Promise<void> {
    const prev = this.eventChains.get(params.runId) || Promise.resolve();
    const next = prev.then(async () => {
      let seq = 1;
      for (let attempt = 0; attempt < 5; attempt++) {
        const last = await prisma.workflowRunEvent.findFirst({
          where: { runId: params.runId },
          orderBy: { sequence: "desc" },
          select: { sequence: true },
        });
        seq = (last?.sequence || 0) + 1;
        try {
          await prisma.workflowRunEvent.create({
            data: {
              runId: params.runId,
              workspaceId: params.workspaceId,
              sequence: seq,
              eventType: params.type,
              nodeId: params.nodeId || null,
              payload: params.payload as any,
            },
          });
          break;
        } catch (err: any) {
          if (err?.code === "P2002" && attempt < 4) continue;
          break;
        }
      }

      await this.deps
        .publishEvent({
          type: params.type,
          runId: params.runId,
          workflowId: params.workflowId,
          workspaceId: params.workspaceId,
          nodeId: params.nodeId || null,
          sequence: seq,
          timestamp: new Date().toISOString(),
          payload: params.payload,
        })
        .catch(() => {});
    });

    this.eventChains.set(params.runId, next.catch(() => {}));
    await next;
  }

  private async checkCancelled(runId: string): Promise<boolean> {
    if (this.deps.isCancellationRequested) {
      if (await this.deps.isCancellationRequested(runId)) return true;
    }
    const row = await prisma.workflowRun.findUnique({
      where: { id: runId },
      select: { cancellationRequestedAt: true, status: true },
    });
    return Boolean(row?.cancellationRequestedAt || row?.status === "CANCELLED");
  }

  public async processJob(payload: WorkflowJobPayload): Promise<void> {
    const { runId } = payload;

    const run = await prisma.workflowRun.findUnique({
      where: { id: runId },
      include: {
        version: true,
        workflow: true,
        nodeExecutions: true,
        approvals: true,
      },
    });

    if (!run || isRunTerminal(run.status)) {
      return;
    }

    if (run.cancellationRequestedAt || (await this.checkCancelled(runId))) {
      await this.finalizeRun(run, "CANCELLED", "Workflow run cancelled by user.", "USER_CANCELLED");
      return;
    }

    const graph = run.version.definitionJson as unknown as WorkflowGraphDefinition;
    const nodeById = new Map<string, WorkflowNodeSpec>();
    for (const node of graph.nodes) {
      nodeById.set(node.id, node);
    }

    const incomingEdges = new Map<string, typeof graph.edges>();
    for (const n of graph.nodes) {
      incomingEdges.set(n.id, []);
    }
    for (const edge of graph.edges) {
      incomingEdges.get(edge.target)?.push(edge);
    }

    if (run.status === "PENDING") {
      await prisma.workflowRun.update({
        where: { id: run.id },
        data: { status: "RUNNING", startedAt: run.startedAt || new Date() },
      });

      await this.emitRunEvent({
        runId: run.id,
        workflowId: run.workflowId,
        workspaceId: run.workspaceId,
        type: "workflow.run.started",
        payload: {
          workflowName: run.workflow.name,
          versionNumber: run.version.versionNumber,
          triggerType: run.triggerType,
        },
      });
    } else if (run.status === "AWAITING_APPROVAL") {
      await prisma.workflowRun.update({
        where: { id: run.id },
        data: { status: "RUNNING" },
      });
    }

    // Ensure execution records exist for every node in version graph
    const existingSet = new Set(run.nodeExecutions.map((ne) => ne.nodeId));
    for (const n of graph.nodes) {
      if (!existingSet.has(n.id)) {
        await prisma.workflowNodeExecution.create({
          data: {
            runId: run.id,
            workflowId: run.workflowId,
            workspaceId: run.workspaceId,
            nodeId: n.id,
            nodeType: n.type,
            title: n.title,
            status: "PENDING",
          },
        });
      }
    }

    // Reconcile any nodes waiting on human approval, MCP approval, or Bridge execution
    await this.reconcileWaitingNodes(run, nodeById);

    // Execute ready nodes wave-by-wave cleanly
    while (true) {
      if (await this.checkCancelled(run.id)) {
        await this.finalizeRun(run, "CANCELLED", "Workflow run cancelled during execution.", "USER_CANCELLED");
        return;
      }

      const currentExecs = await prisma.workflowNodeExecution.findMany({
        where: { runId: run.id },
        orderBy: { createdAt: "asc" },
      });
      const execByNodeId = new Map<string, WorkflowNodeExecution>();
      for (const ex of currentExecs) {
        execByNodeId.set(ex.nodeId, ex);
      }

      const pendingNodes = currentExecs.filter((e) => e.status === "PENDING");
      const awaitingNodes = currentExecs.filter((e) => e.status === "AWAITING_APPROVAL");
      const runningNodes = currentExecs.filter((e) => e.status === "RUNNING");

      if (pendingNodes.length === 0 && awaitingNodes.length === 0 && runningNodes.length === 0) {
        break;
      }

      if (awaitingNodes.length > 0 && pendingNodes.length === 0 && runningNodes.length === 0) {
        await prisma.workflowRun.update({
          where: { id: run.id },
          data: { status: "AWAITING_APPROVAL" },
        });
        await this.emitRunEvent({
          runId: run.id,
          workflowId: run.workflowId,
          workspaceId: run.workspaceId,
          type: "workflow.run.awaiting_approval",
          payload: {
            waitingNodes: awaitingNodes.map((n) => ({ nodeId: n.nodeId, title: n.title })),
          },
        });
        return;
      }

      // Skip any nodes invalidated by failed upstream dependencies or condition-excluded branches
      let skippedAny = false;
      for (const exec of pendingNodes) {
        const parents = incomingEdges.get(exec.nodeId) || [];
        if (parents.length === 0) continue;

        const nodeSpec = nodeById.get(exec.nodeId);
        const isAnyMerge =
          nodeSpec?.type === "merge" &&
          String((nodeSpec.config || {}).joinMode || "ALL") === "ANY";

        let allParentsTerminal = true;
        let activeParentCompleted = false;
        let requiredParentFailed = false;
        let eligibleParentsCount = 0;

        for (const edge of parents) {
          const parentExec = execByNodeId.get(edge.source);
          if (!parentExec || !isNodeTerminal(parentExec.status)) {
            allParentsTerminal = false;
            continue;
          }

          // Check conditional branch exclusion
          const parentSpec = nodeById.get(edge.source);
          if (parentSpec?.type === "condition" && parentExec.status === "COMPLETED") {
            const matchedBranch = String(
              (parentExec.outputData as Record<string, unknown> | null)?.branch || "false"
            );
            const expectedHandle = edge.sourceHandle || "true";
            if (expectedHandle !== matchedBranch) {
              continue; // Edge pruned by condition branch decision
            }
          }

          if (parentExec.status === "SKIPPED") {
            continue;
          }

          eligibleParentsCount++;
          if (parentExec.status === "COMPLETED") {
            activeParentCompleted = true;
          } else {
            requiredParentFailed = true;
          }
        }

        if (!allParentsTerminal) continue;

        const shouldSkip = isAnyMerge
          ? !activeParentCompleted
          : requiredParentFailed || eligibleParentsCount === 0;

        if (shouldSkip) {
          await prisma.workflowNodeExecution.update({
            where: { id: exec.id },
            data: {
              status: "SKIPPED",
              completedAt: new Date(),
              outputData: { skippedReason: requiredParentFailed ? "UPSTREAM_FAILED" : "BRANCH_NOT_SELECTED" } as any,
            },
          });
          await this.emitRunEvent({
            runId: run.id,
            workflowId: run.workflowId,
            workspaceId: run.workspaceId,
            type: "workflow.node.skipped",
            nodeId: exec.nodeId,
            payload: { reason: requiredParentFailed ? "UPSTREAM_FAILED" : "BRANCH_NOT_SELECTED" },
          });
          skippedAny = true;
        }
      }

      if (skippedAny) {
        continue;
      }

      // Compute ready PENDING nodes whose incoming parents are all terminal & satisfied
      const readyNodes = pendingNodes.filter((exec) => {
        const parents = incomingEdges.get(exec.nodeId) || [];
        if (parents.length === 0) return true;

        const nodeSpec = nodeById.get(exec.nodeId);
        const isAnyMerge =
          nodeSpec?.type === "merge" &&
          String((nodeSpec.config || {}).joinMode || "ALL") === "ANY";

        let hasCompleted = false;
        for (const edge of parents) {
          const pExec = execByNodeId.get(edge.source);
          if (!pExec || !isNodeTerminal(pExec.status)) {
            return false;
          }
          if (pExec.status === "COMPLETED") {
            const parentSpec = nodeById.get(edge.source);
            if (parentSpec?.type === "condition") {
              const branch = String((pExec.outputData as Record<string, unknown> | null)?.branch || "false");
              if ((edge.sourceHandle || "true") === branch) {
                hasCompleted = true;
              }
            } else {
              hasCompleted = true;
            }
          }
        }

        return isAnyMerge ? hasCompleted : hasCompleted;
      });

      if (readyNodes.length === 0) {
        if (awaitingNodes.length > 0) {
          await prisma.workflowRun.update({
            where: { id: run.id },
            data: { status: "AWAITING_APPROVAL" },
          });
          await this.emitRunEvent({
            runId: run.id,
            workflowId: run.workflowId,
            workspaceId: run.workspaceId,
            type: "workflow.run.awaiting_approval",
            payload: {
              waitingNodes: awaitingNodes.map((n) => ({ nodeId: n.nodeId, title: n.title })),
            },
          });
          return;
        }
        break;
      }

      // Build immutable context snapshot for this wave
      const stepContext: Record<string, unknown> = {};
      for (const ex of currentExecs) {
        stepContext[ex.nodeId] = {
          status: ex.status,
          output: ex.outputData || {},
          error: ex.errorMessage || null,
        };
      }

      const evalContext: Record<string, unknown> = {
        trigger: {
          type: run.triggerType,
          payload: (run.triggerPayload as Record<string, unknown>) || {},
          triggeredAt: (run.startedAt || run.createdAt).toISOString(),
        },
        workflow: {
          id: run.workflowId,
          runId: run.id,
          name: run.workflow.name,
        },
        steps: stepContext,
      };

      const batch = readyNodes.slice(0, WORKFLOW_CONSTANTS.MAX_CONCURRENT_NODES);
      await Promise.all(
        batch.map(async (exec) => {
          const nodeSpec = nodeById.get(exec.nodeId);
          if (!nodeSpec) {
            await prisma.workflowNodeExecution.update({
              where: { id: exec.id },
              data: {
                status: "FAILED",
                errorCode: "MISSING_NODE_SPEC",
                errorMessage: `Node '${exec.nodeId}' not found in version snapshot.`,
                completedAt: new Date(),
              },
            });
            return;
          }
          await this.executeNodeWithRetry(run, exec, nodeSpec, evalContext);
        })
      );
    }

    // Recompute final status & aggregate output cleanly
    const finalExecs = await prisma.workflowNodeExecution.findMany({
      where: { runId: run.id },
      orderBy: { createdAt: "asc" },
    });

    const stillWaiting = finalExecs.some((e) => e.status === "AWAITING_APPROVAL");
    if (stillWaiting) {
      await prisma.workflowRun.update({
        where: { id: run.id },
        data: { status: "AWAITING_APPROVAL" },
      });
      return;
    }

    const failedCount = finalExecs.filter(
      (e) => e.status === "FAILED" || e.status === "UNKNOWN_OUTCOME"
    ).length;
    const completedCount = finalExecs.filter((e) => e.status === "COMPLETED").length;

    const completionExec = [...finalExecs]
      .reverse()
      .find((e) => e.nodeType === "completion" && e.status === "COMPLETED");
    const storeExec = [...finalExecs]
      .reverse()
      .find((e) => e.nodeType === "store_result" && e.status === "COMPLETED");
    const lastCompleted = [...finalExecs]
      .reverse()
      .find((e) => e.status === "COMPLETED" && !e.nodeType.endsWith("_trigger"));

    const finalOutput: Record<string, unknown> = {
      completedNodes: completedCount,
      failedNodes: failedCount,
      steps: Object.fromEntries(
        finalExecs.map((e) => [
          e.nodeId,
          { status: e.status, output: e.outputData || null, error: e.errorMessage || null },
        ])
      ),
    };

    const summaryText = String(
      (completionExec?.outputData as Record<string, unknown> | null)?.summary ||
        (storeExec?.outputData as Record<string, unknown> | null)?.summary ||
        (lastCompleted?.outputData as Record<string, unknown> | null)?.summary ||
        (lastCompleted?.outputData as Record<string, unknown> | null)?.result ||
        (failedCount > 0
          ? `Workflow finished with ${failedCount} failed node(s).`
          : `Workflow completed (${completedCount} node(s)).`)
    );

    if (failedCount > 0 && completedCount === 0) {
      await this.finalizeRun(
        run,
        "FAILED",
        summaryText,
        "WORKFLOW_EXECUTION_FAILED",
        finalOutput
      );
    } else if (failedCount > 0) {
      const anyCompletion = Boolean(completionExec);
      await this.finalizeRun(
        run,
        anyCompletion ? "PARTIAL_COMPLETED" : "FAILED",
        summaryText,
        anyCompletion ? null : "DOWNSTREAM_NODE_FAILED",
        finalOutput
      );
    } else {
      await this.finalizeRun(run, "COMPLETED", summaryText, null, finalOutput);
    }
  }

  private async reconcileWaitingNodes(
    run: WorkflowRun & { approvals: Array<any> },
    nodeById: Map<string, WorkflowNodeSpec>
  ): Promise<void> {
    const waiting = await prisma.workflowNodeExecution.findMany({
      where: { runId: run.id, status: "AWAITING_APPROVAL" },
    });

    for (const exec of waiting) {
      if (exec.nodeType === "approval_gate") {
        const approval = await prisma.workflowApproval.findUnique({
          where: { nodeExecutionId: exec.id },
        });
        if (!approval) continue;

        if (approval.status === "APPROVED") {
          const out = {
            approved: true,
            approvalId: approval.id,
            decidedByUserId: approval.decidedByUserId,
            decidedAt: approval.decidedAt?.toISOString() || new Date().toISOString(),
          };
          await prisma.workflowNodeExecution.update({
            where: { id: exec.id },
            data: {
              status: "COMPLETED",
              outputData: out as any,
              completedAt: new Date(),
              durationMs: exec.startedAt ? Date.now() - exec.startedAt.getTime() : 0,
            },
          });
          await this.emitRunEvent({
            runId: run.id,
            workflowId: run.workflowId,
            workspaceId: run.workspaceId,
            type: "workflow.node.completed",
            nodeId: exec.nodeId,
            payload: out,
          });
        } else if (approval.status === "DENIED" || approval.status === "EXPIRED") {
          const msg =
            approval.rejectionReason ||
            `Approval gate ${approval.status.toLowerCase()}.`;
          await prisma.workflowNodeExecution.update({
            where: { id: exec.id },
            data: {
              status: "FAILED",
              errorCode: approval.status === "EXPIRED" ? "APPROVAL_EXPIRED" : "APPROVAL_DENIED",
              errorMessage: msg,
              completedAt: new Date(),
            },
          });
          await this.emitRunEvent({
            runId: run.id,
            workflowId: run.workflowId,
            workspaceId: run.workspaceId,
            type: "workflow.node.failed",
            nodeId: exec.nodeId,
            payload: { errorCode: "APPROVAL_DENIED", message: msg },
          });
        }
      } else if (exec.nodeType === "mcp_tool" && exec.toolCallId) {
        const tc = await prisma.toolCall.findUnique({
          where: { id: exec.toolCallId },
          include: { connection: true },
        });
        if (!tc) continue;

        if (tc.status === "APPROVED" && tc.completedAt === null) {
          const start = Date.now();
          try {
            const rawRes = await this.invokeMcpTool({
              workspaceId: run.workspaceId,
              connectionId: tc.connectionId,
              connectionName: tc.connection.name,
              endpointUrl: tc.connection.endpointUrl,
              transportType: tc.connection.transportType,
              originalToolName: tc.toolName,
              args: (tc.argumentsPreview as Record<string, unknown>) || {},
            });
            const sanitized = toolResultSanitizer.sanitize(rawRes.rawResult);
            await prisma.toolCall.update({
              where: { id: tc.id },
              data: {
                status: rawRes.isError ? "FAILED" : "SUCCEEDED",
                result: sanitized as any,
                isError: rawRes.isError,
                durationMs: Date.now() - start,
                completedAt: new Date(),
              },
            });

            if (rawRes.isError) {
              await prisma.workflowNodeExecution.update({
                where: { id: exec.id },
                data: {
                  status: "FAILED",
                  errorCode: "MCP_TOOL_ERROR",
                  errorMessage: sanitized.content.slice(0, 1000),
                  completedAt: new Date(),
                },
              });
            } else {
              await prisma.workflowNodeExecution.update({
                where: { id: exec.id },
                data: {
                  status: "COMPLETED",
                  outputData: {
                    toolCallId: tc.id,
                    toolName: tc.toolName,
                    result: sanitized.content,
                  } as any,
                  durationMs: Date.now() - start,
                  completedAt: new Date(),
                },
              });
              await this.emitRunEvent({
                runId: run.id,
                workflowId: run.workflowId,
                workspaceId: run.workspaceId,
                type: "workflow.node.completed",
                nodeId: exec.nodeId,
                payload: { toolCallId: tc.id, toolName: tc.toolName },
              });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Resumed MCP call failed";
            await prisma.workflowNodeExecution.update({
              where: { id: exec.id },
              data: {
                status: "FAILED",
                errorCode: "MCP_EXECUTION_FAILED",
                errorMessage: msg,
                completedAt: new Date(),
              },
            });
          }
        } else if (tc.status === "DENIED" || tc.status === "EXPIRED") {
          await prisma.workflowNodeExecution.update({
            where: { id: exec.id },
            data: {
              status: "FAILED",
              errorCode: "MCP_APPROVAL_DENIED",
              errorMessage: tc.errorMessage || `MCP tool call ${tc.status.toLowerCase()}.`,
              completedAt: new Date(),
            },
          });
        }
      } else if (exec.nodeType === "bridge_capability" && exec.bridgeTaskId) {
        const bt = await prisma.bridgeTask.findUnique({ where: { id: exec.bridgeTaskId } });
        if (!bt) continue;
        if (bt.status === "SUCCEEDED") {
          await prisma.workflowNodeExecution.update({
            where: { id: exec.id },
            data: {
              status: "COMPLETED",
              outputData: {
                bridgeTaskId: bt.id,
                capability: bt.capability,
                result: bt.result || {},
              } as any,
              durationMs: bt.durationMs || 0,
              completedAt: new Date(),
            },
          });
          await this.emitRunEvent({
            runId: run.id,
            workflowId: run.workflowId,
            workspaceId: run.workspaceId,
            type: "workflow.node.completed",
            nodeId: exec.nodeId,
            payload: { bridgeTaskId: bt.id, capability: bt.capability },
          });
        } else if (
          bt.status === "FAILED" ||
          bt.status === "CANCELLED" ||
          bt.status === "EXPIRED" ||
          bt.status === "UNKNOWN_OUTCOME"
        ) {
          await prisma.workflowNodeExecution.update({
            where: { id: exec.id },
            data: {
              status: bt.status === "UNKNOWN_OUTCOME" ? "UNKNOWN_OUTCOME" : "FAILED",
              errorCode: bt.status === "UNKNOWN_OUTCOME" ? "UNKNOWN_OUTCOME" : "BRIDGE_TASK_FAILED",
              errorMessage: bt.errorMessage || `Bridge task terminated with ${bt.status}`,
              completedAt: new Date(),
            },
          });
        }
      } else if (exec.nodeType === "run_swarm" && exec.agentRunId) {
        const ar = await prisma.agentRun.findUnique({ where: { id: exec.agentRunId } });
        if (!ar) continue;
        if (ar.status === "COMPLETED" || ar.status === "PARTIAL_COMPLETED") {
          await prisma.workflowNodeExecution.update({
            where: { id: exec.id },
            data: {
              status: "COMPLETED",
              outputData: {
                agentRunId: ar.id,
                status: ar.status,
                summary: ar.finalSummary || "",
                inputTokens: ar.inputTokens,
                outputTokens: ar.outputTokens,
              } as any,
              completedAt: new Date(),
            },
          });
        } else if (ar.status === "FAILED" || ar.status === "CANCELLED") {
          await prisma.workflowNodeExecution.update({
            where: { id: exec.id },
            data: {
              status: "FAILED",
              errorCode: ar.safeErrorCode || "SWARM_FAILED",
              errorMessage: ar.errorMessage || `Swarm run ended with ${ar.status}`,
              completedAt: new Date(),
            },
          });
        }
      }

      // If node was somehow manually touched in DB cleanly
      void nodeById;
    }
  }

  private async executeNodeWithRetry(
    run: WorkflowRun,
    exec: WorkflowNodeExecution,
    nodeSpec: WorkflowNodeSpec,
    context: Record<string, unknown>
  ): Promise<void> {
    const requestedAttempts = nodeSpec.retryPolicy?.maxAttempts ?? 1;
    const isSafeToRetry =
      SIDE_EFFECT_FREE_NODES.has(nodeSpec.type) ||
      Boolean(nodeSpec.retryPolicy?.sideEffectSafe);
    const maxAttempts = isSafeToRetry ? Math.min(requestedAttempts, WORKFLOW_CONSTANTS.MAX_NODE_RETRIES) : 1;

    await this.emitRunEvent({
      runId: run.id,
      workflowId: run.workflowId,
      workspaceId: run.workspaceId,
      type: "workflow.node.started",
      nodeId: nodeSpec.id,
      payload: { title: nodeSpec.title, nodeType: nodeSpec.type },
    });

    const startTime = Date.now();
    await prisma.workflowNodeExecution.update({
      where: { id: exec.id },
      data: { status: "RUNNING", startedAt: exec.startedAt || new Date() },
    });

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await prisma.workflowNodeExecution.update({
          where: { id: exec.id },
          data: { attemptCount: attempt },
        });

        const outcome = await this.executeSingleNode(run, exec, nodeSpec, context);
        if (outcome.awaitingApproval) {
          await this.emitRunEvent({
            runId: run.id,
            workflowId: run.workflowId,
            workspaceId: run.workspaceId,
            type: "workflow.node.awaiting_approval",
            nodeId: nodeSpec.id,
            payload: outcome.output || {},
          });
          return;
        }

        const durationMs = Date.now() - startTime;
        await prisma.workflowNodeExecution.update({
          where: { id: exec.id },
          data: {
            status: "COMPLETED",
            outputData: (outcome.output || {}) as any,
            durationMs,
            completedAt: new Date(),
          },
        });

        await this.emitRunEvent({
          runId: run.id,
          workflowId: run.workflowId,
          workspaceId: run.workspaceId,
          type: "workflow.node.completed",
          nodeId: nodeSpec.id,
          payload: {
            durationMs,
            outputPreview: outcome.output || {},
          },
        });
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Node execution failed";
        const isUnknown = /UNKNOWN_OUTCOME|ECONNRESET|ETIMEDOUT/i.test(msg);

        if (attempt < maxAttempts && !isUnknown) {
          const backoffMs = Math.min(nodeSpec.retryPolicy?.backoffMs ?? 500, 5000);
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }

        const durationMs = Date.now() - startTime;
        await prisma.workflowNodeExecution.update({
          where: { id: exec.id },
          data: {
            status: isUnknown ? "UNKNOWN_OUTCOME" : "FAILED",
            errorCode: isUnknown ? "UNKNOWN_OUTCOME" : "NODE_EXECUTION_ERROR",
            errorMessage: msg,
            durationMs,
            completedAt: new Date(),
          },
        });

        await this.emitRunEvent({
          runId: run.id,
          workflowId: run.workflowId,
          workspaceId: run.workspaceId,
          type: "workflow.node.failed",
          nodeId: nodeSpec.id,
          payload: { errorCode: isUnknown ? "UNKNOWN_OUTCOME" : "NODE_EXECUTION_ERROR", message: msg },
        });
        return;
      }
    }
  }

  private async executeSingleNode(
    run: WorkflowRun,
    exec: WorkflowNodeExecution,
    node: WorkflowNodeSpec,
    context: Record<string, unknown>
  ): Promise<{ awaitingApproval?: boolean; output?: Record<string, unknown> }> {
    const cfg = (node.config || {}) as Record<string, unknown>;

    switch (node.type) {
      case "manual_trigger":
      case "schedule_trigger":
      case "event_trigger": {
        return {
          output: {
            triggerType: run.triggerType,
            payload: (run.triggerPayload as Record<string, unknown>) || {},
            triggeredAt: (run.startedAt || run.createdAt).toISOString(),
          },
        };
      }

      case "condition": {
        const expr = String(cfg.expression || "true");
        const matched = SafeExpressionEvaluator.evaluate(expr, context);
        return {
          output: {
            expression: expr,
            matched,
            branch: matched ? "true" : "false",
          },
        };
      }

      case "transform": {
        return {
          output: SafeTransformEngine.runTransform(cfg, context),
        };
      }

      case "merge": {
        const steps = (context.steps || {}) as Record<string, { status: string; output: unknown }>;
        const completedOutputs: Record<string, unknown> = {};
        for (const [stepId, st] of Object.entries(steps)) {
          if (st.status === "COMPLETED") {
            completedOutputs[stepId] = st.output;
          }
        }
        return {
          output: {
            joinMode: String(cfg.joinMode || "ALL"),
            merged: completedOutputs,
            completedCount: Object.keys(completedOutputs).length,
          },
        };
      }

      case "approval_gate": {
        const title = renderSafeTemplate(
          String(cfg.title || node.title || "Workflow Approval Gate"),
          context
        ).slice(0, 160);
        const summary = renderSafeTemplate(
          String(cfg.summaryTemplate || "Human confirmation required before workflow continues."),
          context
        );
        const expiresAt = new Date(Date.now() + WORKFLOW_CONSTANTS.DEFAULT_APPROVAL_TTL_MS);

        await prisma.workflowApproval.create({
          data: {
            runId: run.id,
            nodeExecutionId: exec.id,
            workflowId: run.workflowId,
            workspaceId: run.workspaceId,
            nodeId: node.id,
            requestedByUserId: run.triggeredByUserId || null,
            status: "PENDING",
            title,
            summary,
            contextPreview: { steps: (context.steps as Record<string, unknown>) || {} } as any,
            expiresAt,
          },
        });

        await prisma.workflowNodeExecution.update({
          where: { id: exec.id },
          data: {
            status: "AWAITING_APPROVAL",
            inputData: { title, summary } as any,
          },
        });

        return {
          awaitingApproval: true,
          output: { waitingFor: "workflow_approval", title, summary },
        };
      }

      case "run_agent": {
        return await this.executeAgentNode(run, node, cfg, context);
      }

      case "run_swarm": {
        return await this.executeSwarmNode(run, exec, cfg, context);
      }

      case "mcp_tool": {
        return await this.executeMcpToolNode(run, exec, cfg, context);
      }

      case "bridge_capability": {
        return await this.executeBridgeNode(run, exec, cfg, context);
      }

      case "store_result": {
        const renderedOutput = renderSafeTemplate(
          String(cfg.outputTemplate || ""),
          context
        ).trim();
        const saveToMemory = Boolean(cfg.saveToMemory);
        let memoryId: string | null = null;

        if (saveToMemory && renderedOutput.length >= 3) {
          const scope = (String(cfg.memoryScope || "WORKSPACE").toUpperCase() as MemoryScope) || "WORKSPACE";
          const title =
            renderSafeTemplate(String(cfg.memoryTitleTemplate || node.title), context).slice(0, 190) ||
            node.title;
          const tags = Array.isArray(cfg.memoryTags) ? cfg.memoryTags.map(String) : ["workflow"];
          const importance = typeof cfg.importance === "number" ? cfg.importance : 0.7;

          const created = await this.memoryService.createMemory(
            run.triggeredByUserId || null,
            {
              workspaceId: run.workspaceId,
              scope: scope === "PERSONAL" && !run.triggeredByUserId ? "WORKSPACE" : scope,
              agentId: scope === "AGENT" && cfg.agentId ? String(cfg.agentId) : undefined,
              sourceType: "WORKFLOW_OUTPUT",
              sourceWorkflowRunId: run.id,
              title,
              content: renderedOutput,
              tags,
              importance,
              isPinned: Boolean(cfg.pinMemory),
              embedImmediately: true,
              metadata: {
                workflowId: run.workflowId,
                workflowRunId: run.id,
                nodeId: node.id,
              },
            },
            {
              bypassMembershipCheck: true,
              upsertByTitle: Boolean(cfg.upsertByTitle ?? true),
              redactInsteadOfReject: true,
            }
          );
          memoryId = created.id;
        }

        return {
          output: {
            summary: renderedOutput,
            memoryId,
            savedToMemory: Boolean(memoryId),
          },
        };
      }

      case "completion": {
        const summary = renderSafeTemplate(
          String(cfg.summaryTemplate || "Workflow completed cleanly."),
          context
        );
        return { output: { summary } };
      }

      default:
        throw new Error(`Unsupported workflow node type '${node.type}'.`);
    }
  }

  private async executeAgentNode(
    run: WorkflowRun,
    node: WorkflowNodeSpec,
    cfg: Record<string, unknown>,
    context: Record<string, unknown>
  ): Promise<{ output: Record<string, unknown> }> {
    const roleHint = cfg.agentRoleHint ? String(cfg.agentRoleHint) : undefined;
    const requestedAgentId = cfg.agentId ? String(cfg.agentId) : undefined;

    const agent = requestedAgentId
      ? await prisma.agentDefinition.findFirst({
          where: { id: requestedAgentId, workspaceId: run.workspaceId, status: "ACTIVE" },
          include: { providerConnection: { include: { credential: true } } },
        })
      : await prisma.agentDefinition.findFirst({
          where: {
            workspaceId: run.workspaceId,
            status: "ACTIVE",
            ...(roleHint ? { category: roleHint } : {}),
          },
          include: { providerConnection: { include: { credential: true } } },
          orderBy: { createdAt: "asc" },
        });

    if (!agent) {
      throw new Error(
        `No active agent found in workspace for workflow node '${node.title}'.`
      );
    }

    let conn = agent.providerConnection;
    if (!conn || conn.status !== "ACTIVE" || !conn.credential) {
      conn = await prisma.providerConnection.findFirst({
        where: { workspaceId: run.workspaceId, status: "ACTIVE" },
        include: { credential: true },
        orderBy: { createdAt: "desc" },
      });
    }

    if (!conn || !conn.credential) {
      throw new Error("No active AI provider connection configured in workspace for agent node.");
    }

    const apiKey = this.deps.decryptProviderSecret({
      ciphertext: conn.credential.ciphertext,
      initializationVector: conn.credential.initializationVector,
      authenticationTag: conn.credential.authenticationTag,
      keyVersion: conn.credential.keyVersion,
      providerConnectionId: conn.id,
      workspaceId: run.workspaceId,
      provider: conn.provider,
    });

    const promptText = renderSafeTemplate(
      String(cfg.promptTemplate || "Analyze upstream workflow context and report concise results: {{steps}}"),
      context
    );

    let memoryBlock = "";
    if (cfg.useMemoryRetrieval !== false) {
      try {
        const configuredScopes = Array.isArray(cfg.memoryScopes)
          ? (cfg.memoryScopes as MemoryScope[])
          : (["WORKSPACE", "AGENT"] as MemoryScope[]);
        const allowedScopes = configuredScopes.filter(
          (s) => s !== "PERSONAL" || Boolean(run.triggeredByUserId)
        );
        const memBundle = await this.memoryService.buildPromptMemoryBlock({
          workspaceId: run.workspaceId,
          userId: run.triggeredByUserId || "00000000-0000-0000-0000-000000000000",
          query: promptText,
          scopes: allowedScopes.length > 0 ? allowedScopes : ["WORKSPACE"],
          agentIds: [agent.id],
          channel: "workflow",
        });
        memoryBlock = memBundle.contextBlock;
      } catch {
        memoryBlock = "";
      }
    }

    const systemContent = [
      agent.systemPrompt,
      memoryBlock ? `\n${memoryBlock}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const modelId =
      agent.modelId ||
      (conn.provider === "openai"
        ? "gpt-4o-mini"
        : conn.provider === "anthropic"
        ? "claude-sonnet-4-20250514"
        : "gemini-2.0-flash");

    const adapter = defaultProviderRegistry.getAdapter(conn.provider as SupportedProviderId);
    const messages: ProviderChatMessage[] = [
      { role: "system", content: systemContent },
      { role: "user", content: promptText },
    ];

    let outputText = "";
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const chunk of adapter.streamResponse({
      credentials: { apiKey },
      model: modelId,
      messages,
      temperature: agent.temperature,
      maxTokens: agent.maxOutputTokens,
    })) {
      if (chunk.type === "text_delta" && chunk.text) {
        outputText += chunk.text;
      } else if (chunk.type === "usage") {
        inputTokens = chunk.inputTokens || inputTokens;
        outputTokens = chunk.outputTokens || outputTokens;
      }
    }

    return {
      output: {
        agentId: agent.id,
        agentName: agent.name,
        modelId,
        summary: outputText.trim(),
        inputTokens,
        outputTokens,
      },
    };
  }

  private async executeSwarmNode(
    run: WorkflowRun,
    exec: WorkflowNodeExecution,
    cfg: Record<string, unknown>,
    context: Record<string, unknown>
  ): Promise<{ awaitingApproval?: boolean; output: Record<string, unknown> }> {
    const wfMeta = (context.workflow as Record<string, unknown> | undefined) || {};
    const objective = renderSafeTemplate(
      String(cfg.objectiveTemplate || wfMeta.name || "Workflow Swarm Execution"),
      context
    );

    const activeAgents = await prisma.agentDefinition.findMany({
      where: { workspaceId: run.workspaceId, status: "ACTIVE" },
      include: { providerConnection: { include: { credential: true } } },
      orderBy: { createdAt: "asc" },
    });

    const supervisor =
      (cfg.supervisorAgentId
        ? activeAgents.find((a) => a.id === String(cfg.supervisorAgentId))
        : activeAgents.find((a) => a.canSupervise)) || activeAgents[0];

    if (!supervisor) {
      throw new Error("No active supervisor agent found in workspace to execute Swarm node.");
    }

    const requestedWorkerIds = Array.isArray(cfg.workerAgentIds)
      ? cfg.workerAgentIds.map(String)
      : [];
    const workers =
      requestedWorkerIds.length > 0
        ? activeAgents.filter((a) => requestedWorkerIds.includes(a.id))
        : activeAgents.filter((a) => a.id !== supervisor.id).slice(0, 3);

    const effectiveWorkers = workers.length > 0 ? workers : [supervisor];

    // Create AgentRun pinned cleanly to this workflow execution
    const agentRun = await prisma.agentRun.create({
      data: {
        workspaceId: run.workspaceId,
        createdByUserId: run.triggeredByUserId || null,
        supervisorAgentId: supervisor.id,
        workerAgentIds: effectiveWorkers.map((w) => w.id),
        objective,
        status: "PENDING",
        requirePlanApproval: Boolean(cfg.requirePlanApproval),
        maxTotalTokens: Number(cfg.maxTotalTokens || 80000),
        maxCostUsd: Number(cfg.maxCostUsd || 1.5),
        maxConcurrency: Number(cfg.maxConcurrency || 3),
      },
    });

    await prisma.workflowNodeExecution.update({
      where: { id: exec.id },
      data: { agentRunId: agentRun.id },
    });

    // Execute Swarm inline inside workflow node runtime using SwarmPlanner + Supervisor
    const fallbackConn = await prisma.providerConnection.findFirst({
      where: { workspaceId: run.workspaceId, status: "ACTIVE" },
      include: { credential: true },
      orderBy: { createdAt: "desc" },
    });
    const supConn = supervisor.providerConnection?.credential
      ? supervisor.providerConnection
      : fallbackConn;
    if (!supConn?.credential) {
      throw new Error("Supervisor provider credentials unavailable for workflow Swarm node.");
    }

    const apiKey = this.deps.decryptProviderSecret({
      ciphertext: supConn.credential.ciphertext,
      initializationVector: supConn.credential.initializationVector,
      authenticationTag: supConn.credential.authenticationTag,
      keyVersion: supConn.credential.keyVersion,
      providerConnectionId: supConn.id,
      workspaceId: run.workspaceId,
      provider: supConn.provider,
    });

    const descriptors = effectiveWorkers.map((w) => ({
      id: w.id,
      name: w.name,
      roleTitle: w.roleTitle,
      category: w.category,
      description: w.description || undefined,
      systemPrompt: w.systemPrompt,
      provider: (w.providerConnection?.provider || supConn.provider) as SupportedProviderId,
      providerConnectionId: w.providerConnectionId || supConn.id,
      modelId: w.modelId || "gpt-4o-mini",
      temperature: w.temperature,
      maxOutputTokens: w.maxOutputTokens,
      canSupervise: w.canSupervise,
      allowedMcpToolIds: w.allowedMcpToolIds,
      allowedBridgeCapabilities: w.allowedBridgeCapabilities,
      preferredBridgeDeviceId: w.preferredBridgeDeviceId,
    }));

    const supervisorDesc = {
      id: supervisor.id,
      name: supervisor.name,
      roleTitle: supervisor.roleTitle,
      category: supervisor.category,
      description: supervisor.description || undefined,
      systemPrompt: supervisor.systemPrompt,
      provider: supConn.provider as SupportedProviderId,
      providerConnectionId: supConn.id,
      modelId: supervisor.modelId || "gpt-4o-mini",
      temperature: supervisor.temperature,
      maxOutputTokens: supervisor.maxOutputTokens,
      canSupervise: supervisor.canSupervise,
      allowedMcpToolIds: supervisor.allowedMcpToolIds,
      allowedBridgeCapabilities: supervisor.allowedBridgeCapabilities,
      preferredBridgeDeviceId: supervisor.preferredBridgeDeviceId,
    };

    const { plan } = await SwarmPlanner.generatePlan({
      supervisor: supervisorDesc,
      supervisorApiKey: apiKey,
      workers: descriptors,
      objective,
      maxTasks: 12,
    });

    const validatedPlan = SwarmDagValidator.validateAndNormalize(plan, {
      allowedAgentIds: new Set(descriptors.map((d) => d.id)),
    });

    await prisma.agentRun.update({
      where: { id: agentRun.id },
      data: {
        status: "RUNNING",
        startedAt: new Date(),
        planJson: {
          goalSummary: validatedPlan.goalSummary,
          tasks: validatedPlan.tasks,
        } as any,
      },
    });

    const taskSummaries = await Promise.all(
      validatedPlan.tasks.map(async (t) => {
        const assigned = descriptors.find((d) => d.id === t.assignedAgentId) || descriptors[0];
        if (!assigned) {
          throw new Error(`No worker descriptor resolved for task ${t.taskKey}`);
        }
        const adapter = defaultProviderRegistry.getAdapter(assigned.provider);
        let text = "";
        for await (const chunk of adapter.streamResponse({
          credentials: { apiKey },
          model: assigned.modelId,
          messages: [
            { role: "system", content: assigned.systemPrompt },
            { role: "user", content: `${t.title}\n\n${t.instructions}` },
          ],
          temperature: assigned.temperature,
          maxTokens: assigned.maxOutputTokens,
        })) {
          if (chunk.type === "text_delta" && chunk.text) text += chunk.text;
        }
        return {
          taskKey: t.taskKey,
          agentName: assigned.name,
          roleTitle: assigned.roleTitle,
          status: "COMPLETED",
          outputSummary: text.trim(),
        };
      })
    );

    const synth = await SwarmPlanner.synthesizeOutcome({
      supervisor: supervisorDesc,
      supervisorApiKey: apiKey,
      objective,
      goalSummary: validatedPlan.goalSummary,
      taskResults: taskSummaries,
    });

    await prisma.agentRun.update({
      where: { id: agentRun.id },
      data: {
        status: "COMPLETED",
        finalSummary: synth.summary,
        completedAt: new Date(),
      },
    });

    return {
      output: {
        agentRunId: agentRun.id,
        goalSummary: validatedPlan.goalSummary,
        taskCount: taskSummaries.length,
        summary: synth.summary,
      },
    };
  }

  private async executeMcpToolNode(
    run: WorkflowRun,
    exec: WorkflowNodeExecution,
    cfg: Record<string, unknown>,
    context: Record<string, unknown>
  ): Promise<{ awaitingApproval?: boolean; output?: Record<string, unknown> }> {
    const toolDef = cfg.toolDefinitionId
      ? await prisma.mcpToolDefinition.findUnique({
          where: { id: String(cfg.toolDefinitionId) },
          include: { connection: true, permission: true },
        })
      : await prisma.mcpToolDefinition.findFirst({
          where: {
            toolName: String(cfg.toolName || ""),
            isAvailable: true,
            connection: { workspaceId: run.workspaceId, status: "CONNECTED" },
          },
          include: { connection: true, permission: true },
        });

    if (!toolDef || toolDef.connection.workspaceId !== run.workspaceId) {
      throw new Error(`Target MCP tool '${cfg.toolName || cfg.toolDefinitionId}' not found in workspace.`);
    }

    const mode = toolDef.permission?.permissionMode || "REQUIRE_APPROVAL";
    if (mode === "DISABLED") {
      throw new Error(`MCP tool '${toolDef.toolName}' is DISABLED by workspace security policy.`);
    }

    const renderedArgs = renderTemplateValue(
      (cfg.arguments as Record<string, unknown>) || {},
      context
    ) as Record<string, unknown>;

    const val = this.schemaValidator.validateArguments(
      (toolDef.inputSchema as Record<string, unknown>) || {},
      renderedArgs
    );
    if (!val.valid) {
      throw new Error(`Invalid arguments for MCP tool '${toolDef.toolName}': ${(val.errors || []).join("; ")}`);
    }

    const argsHash = computeArgumentsHash(renderedArgs);
    const requiresApproval =
      mode === "REQUIRE_APPROVAL" || Boolean(toolDef.permission?.requiresApproval);

    if (requiresApproval && cfg.bypassPolicy !== true) {
      const tc = await prisma.toolCall.create({
        data: {
          workflowRunId: run.id,
          workflowNodeExecId: exec.id,
          workspaceId: run.workspaceId,
          toolDefinitionId: toolDef.id,
          connectionId: toolDef.connectionId,
          providerCallId: `wf_${run.id}_${exec.nodeId}`,
          providerToolAlias: toolDef.toolName,
          toolName: toolDef.toolName,
          schemaHash: toolDef.schemaHash,
          argumentsHash: argsHash,
          argumentsPreview: renderedArgs as any,
          status: "AWAITING_APPROVAL",
        },
      });

      const approval = await prisma.toolApproval.create({
        data: {
          toolCallId: tc.id,
          workspaceId: run.workspaceId,
          requestedByUserId: run.triggeredByUserId || null,
          status: "PENDING",
          argumentsHash: argsHash,
          schemaHash: toolDef.schemaHash,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        },
      });

      await prisma.workflowNodeExecution.update({
        where: { id: exec.id },
        data: { status: "AWAITING_APPROVAL", toolCallId: tc.id },
      });

      return {
        awaitingApproval: true,
        output: {
          waitingFor: "mcp_tool_approval",
          approvalId: approval.id,
          toolCallId: tc.id,
          toolName: toolDef.toolName,
        },
      };
    }

    const start = Date.now();
    const res = await this.invokeMcpTool({
      workspaceId: run.workspaceId,
      connectionId: toolDef.connectionId,
      connectionName: toolDef.connection.name,
      endpointUrl: toolDef.connection.endpointUrl,
      transportType: toolDef.connection.transportType,
      originalToolName: toolDef.toolName,
      args: renderedArgs,
    });
    const sanitized = toolResultSanitizer.sanitize(res.rawResult);

    const tc = await prisma.toolCall.create({
      data: {
        workflowRunId: run.id,
        workflowNodeExecId: exec.id,
        workspaceId: run.workspaceId,
        toolDefinitionId: toolDef.id,
        connectionId: toolDef.connectionId,
        providerCallId: `wf_${run.id}_${exec.nodeId}`,
        providerToolAlias: toolDef.toolName,
        toolName: toolDef.toolName,
        schemaHash: toolDef.schemaHash,
        argumentsHash: argsHash,
        argumentsPreview: renderedArgs as any,
        status: res.isError ? "FAILED" : "SUCCEEDED",
        result: sanitized as any,
        isError: res.isError,
        durationMs: Date.now() - start,
        completedAt: new Date(),
      },
    });

    await prisma.workflowNodeExecution.update({
      where: { id: exec.id },
      data: { toolCallId: tc.id },
    });

    if (res.isError) {
      throw new Error(`MCP tool '${toolDef.toolName}' returned error: ${sanitized.content}`);
    }

    return {
      output: {
        toolCallId: tc.id,
        toolName: toolDef.toolName,
        result: sanitized.content,
      },
    };
  }

  private async executeBridgeNode(
    run: WorkflowRun,
    exec: WorkflowNodeExecution,
    cfg: Record<string, unknown>,
    context: Record<string, unknown>
  ): Promise<{ awaitingApproval?: boolean; output?: Record<string, unknown> }> {
    if (!this.deps.dispatchBridgeTask) {
      throw new Error("Local Bridge dispatcher is not available in this workflow runtime.");
    }

    const deviceId = String(cfg.deviceId || "");
    const capability = String(cfg.capability || "");
    if (!deviceId || !capability) {
      throw new Error("Bridge capability node requires both deviceId and capability.");
    }

    const renderedParams = renderTemplateValue(
      (cfg.parameters as Record<string, unknown>) || {},
      context
    ) as Record<string, unknown>;
    const resourceScopes = Array.isArray(cfg.resourceScopes)
      ? cfg.resourceScopes.map((s) => renderSafeTemplate(String(s), context))
      : [];

    const dispatchRes = await this.deps.dispatchBridgeTask({
      workspaceId: run.workspaceId,
      userId: run.triggeredByUserId || "",
      deviceId,
      capability,
      resourceScopes,
      parameters: renderedParams,
      workflowRunId: run.id,
      workflowNodeExecId: exec.id,
    });

    await prisma.workflowNodeExecution.update({
      where: { id: exec.id },
      data: { bridgeTaskId: dispatchRes.bridgeTaskId },
    });

    if (dispatchRes.status === "AWAITING_APPROVAL" || dispatchRes.status === "QUEUED" || dispatchRes.status === "DISPATCHED" || dispatchRes.status === "RUNNING") {
      await prisma.workflowNodeExecution.update({
        where: { id: exec.id },
        data: { status: "AWAITING_APPROVAL" },
      });
      return {
        awaitingApproval: true,
        output: {
          waitingFor: "bridge_task",
          bridgeTaskId: dispatchRes.bridgeTaskId,
          capability,
        },
      };
    }

    if (dispatchRes.status !== "SUCCEEDED") {
      throw new Error(
        dispatchRes.errorMessage || `Bridge capability '${capability}' failed (${dispatchRes.status}).`
      );
    }

    return {
      output: {
        bridgeTaskId: dispatchRes.bridgeTaskId,
        capability,
        result: dispatchRes.result || {},
      },
    };
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
    if (!conn || conn.workspaceId !== params.workspaceId) {
      throw new Error(`MCP connection '${params.connectionName}' not found.`);
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
        isError: Boolean(res?.isError),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async finalizeRun(
    run: WorkflowRun,
    status: "COMPLETED" | "PARTIAL_COMPLETED" | "FAILED" | "CANCELLED",
    summary: string,
    safeErrorCode: string | null,
    finalOutput?: Record<string, unknown>
  ): Promise<void> {
    const now = new Date();
    await prisma.workflowRun.update({
      where: { id: run.id },
      data: {
        status,
        finalOutput: (finalOutput || null) as any,
        finalSummary: summary,
        safeErrorCode,
        ...(status === "FAILED" ? { errorMessage: summary } : {}),
        completedAt: now,
      },
    });

    const eventType: WorkflowStreamEventType =
      status === "COMPLETED"
        ? "workflow.run.completed"
        : status === "PARTIAL_COMPLETED"
        ? "workflow.run.partial_completed"
        : status === "CANCELLED"
        ? "workflow.run.cancelled"
        : "workflow.run.failed";

    await this.emitRunEvent({
      runId: run.id,
      workflowId: run.workflowId,
      workspaceId: run.workspaceId,
      type: eventType,
      payload: {
        status,
        summary,
        safeErrorCode,
        finalOutput: finalOutput || null,
      },
    });

    if (this.deps.onWorkflowTerminal) {
      await this.deps
        .onWorkflowTerminal({
          runId: run.id,
          workflowId: run.workflowId,
          workspaceId: run.workspaceId,
          status,
          summary,
          recursionDepth: run.recursionDepth,
          correlationId: run.correlationId,
          triggeredByUserId: run.triggeredByUserId,
        })
        .catch(() => {});
    }
  }
}
