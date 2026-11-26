import crypto from "node:crypto";
import {
  WORKFLOW_CONSTANTS,
  WorkflowGraphSchema,
  type WorkflowEdgeSpec,
  type WorkflowGraphDefinition,
  type WorkflowNodeSpec,
  type WorkflowValidationIssue,
  type WorkflowValidationResult,
} from "@messiah/shared";
import { CronExpressionEngine } from "./cronEngine.js";
import { SafeExpressionEvaluator } from "./safeEvaluator.js";

const TRIGGER_TYPES = new Set(["manual_trigger", "schedule_trigger", "event_trigger"]);

export class WorkflowDagError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly validation?: WorkflowValidationResult
  ) {
    super(message);
    this.name = "WorkflowDagError";
  }
}

export class WorkflowDagValidator {
  public static computeGraphHash(graph: WorkflowGraphDefinition): string {
    const canonical = {
      nodes: [...graph.nodes]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((n) => ({
          id: n.id,
          type: n.type,
          title: n.title.trim(),
          config: n.config,
          retryPolicy: n.retryPolicy || null,
          timeoutMs: n.timeoutMs || null,
        })),
      edges: [...graph.edges]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((e) => ({
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle || null,
        })),
    };
    return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  }

  public static validate(rawGraph: unknown): WorkflowValidationResult {
    const issues: WorkflowValidationIssue[] = [];
    const parsed = WorkflowGraphSchema.safeParse(rawGraph);

    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push({
          severity: "error",
          code: "INVALID_GRAPH_SCHEMA",
          message: `${issue.path.join(".")}: ${issue.message}`,
        });
      }
      return {
        valid: false,
        issues,
        topologicalOrder: [],
        triggerNodeIds: [],
      };
    }

    const graph = parsed.data;
    if (graph.nodes.length > WORKFLOW_CONSTANTS.MAX_NODES_PER_WORKFLOW) {
      issues.push({
        severity: "error",
        code: "MAX_NODES_EXCEEDED",
        message: `Workflow exceeds maximum allowed nodes (${WORKFLOW_CONSTANTS.MAX_NODES_PER_WORKFLOW}).`,
      });
    }
    if (graph.edges.length > WORKFLOW_CONSTANTS.MAX_EDGES_PER_WORKFLOW) {
      issues.push({
        severity: "error",
        code: "MAX_EDGES_EXCEEDED",
        message: `Workflow exceeds maximum allowed edges (${WORKFLOW_CONSTANTS.MAX_EDGES_PER_WORKFLOW}).`,
      });
    }

    const nodeMap = new Map<string, WorkflowNodeSpec>();
    for (const node of graph.nodes) {
      if (nodeMap.has(node.id)) {
        issues.push({
          severity: "error",
          nodeId: node.id,
          code: "DUPLICATE_NODE_ID",
          message: `Duplicate node ID '${node.id}'.`,
        });
      } else {
        nodeMap.set(node.id, node as WorkflowNodeSpec);
      }
    }

    const incoming = new Map<string, WorkflowEdgeSpec[]>();
    const outgoing = new Map<string, WorkflowEdgeSpec[]>();
    for (const id of nodeMap.keys()) {
      incoming.set(id, []);
      outgoing.set(id, []);
    }

    const seenEdgePairs = new Set<string>();
    for (const edge of graph.edges) {
      if (!nodeMap.has(edge.source)) {
        issues.push({
          severity: "error",
          edgeId: edge.id,
          code: "DANGLING_EDGE_SOURCE",
          message: `Edge '${edge.id}' references missing source node '${edge.source}'.`,
        });
        continue;
      }
      if (!nodeMap.has(edge.target)) {
        issues.push({
          severity: "error",
          edgeId: edge.id,
          code: "DANGLING_EDGE_TARGET",
          message: `Edge '${edge.id}' references missing target node '${edge.target}'.`,
        });
        continue;
      }
      if (edge.source === edge.target) {
        issues.push({
          severity: "error",
          edgeId: edge.id,
          nodeId: edge.source,
          code: "SELF_LOOP",
          message: `Self-referential loop on node '${edge.source}' is not allowed.`,
        });
        continue;
      }

      const pairKey = `${edge.source}->${edge.target}:${edge.sourceHandle || ""}`;
      if (seenEdgePairs.has(pairKey)) {
        issues.push({
          severity: "warning",
          edgeId: edge.id,
          code: "DUPLICATE_EDGE",
          message: `Duplicate connection between '${edge.source}' and '${edge.target}'.`,
        });
      }
      seenEdgePairs.add(pairKey);

      outgoing.get(edge.source)!.push(edge);
      incoming.get(edge.target)!.push(edge);
    }

    // Trigger checks
    const triggers = graph.nodes.filter((n) => TRIGGER_TYPES.has(n.type));
    const triggerNodeIds = triggers.map((t) => t.id);

    if (triggers.length === 0) {
      issues.push({
        severity: "error",
        code: "MISSING_TRIGGER",
        message: "Workflow must include at least one trigger node (Manual, Schedule, or Event).",
      });
    }

    for (const trig of triggers) {
      if ((incoming.get(trig.id)?.length || 0) > 0) {
        issues.push({
          severity: "error",
          nodeId: trig.id,
          code: "TRIGGER_HAS_INCOMING_EDGE",
          message: `Trigger node '${trig.title}' cannot have incoming edges.`,
        });
      }
    }

    // Validate per-node safety and configuration
    for (const node of graph.nodes) {
      const cfg = (node.config || {}) as Record<string, unknown>;

      if (node.type === "schedule_trigger") {
        const expr = String(cfg.cronExpression || "").trim();
        const tz = String(cfg.timezone || "UTC").trim();
        if (!expr) {
          issues.push({
            severity: "error",
            nodeId: node.id,
            code: "MISSING_CRON_EXPRESSION",
            message: `Schedule trigger '${node.title}' requires a valid cronExpression.`,
          });
        } else {
          const check = CronExpressionEngine.validate(expr, tz);
          if (!check.valid) {
            issues.push({
              severity: "error",
              nodeId: node.id,
              code: "INVALID_CRON_SCHEDULE",
              message: `Schedule trigger '${node.title}': ${check.error}`,
            });
          }
        }
      }

      if (node.type === "event_trigger") {
        const eventType = String(cfg.eventType || "").trim();
        if (!eventType) {
          issues.push({
            severity: "error",
            nodeId: node.id,
            code: "MISSING_EVENT_TYPE",
            message: `Event trigger '${node.title}' requires an eventType.`,
          });
        }
      }

      if (node.type === "condition") {
        const expression = String(cfg.expression || "").trim();
        const check = SafeExpressionEvaluator.validateSyntax(expression);
        if (!check.valid) {
          issues.push({
            severity: "error",
            nodeId: node.id,
            code: "INVALID_CONDITION_EXPRESSION",
            message: `Condition node '${node.title}': ${check.error}`,
          });
        }
      }

      if (node.type === "run_agent") {
        const prompt = String(cfg.promptTemplate || "").trim();
        if (!prompt) {
          issues.push({
            severity: "warning",
            nodeId: node.id,
            code: "EMPTY_AGENT_PROMPT",
            message: `Agent node '${node.title}' has an empty promptTemplate and will pass upstream JSON summary.`,
          });
        }
      }

      if (node.type === "mcp_tool") {
        if (!cfg.toolDefinitionId && !cfg.toolName) {
          issues.push({
            severity: "error",
            nodeId: node.id,
            code: "MISSING_MCP_TOOL",
            message: `MCP Tool node '${node.title}' must specify a target toolDefinitionId or toolName.`,
          });
        }
      }

      if (node.type === "bridge_capability") {
        if (!cfg.capability) {
          issues.push({
            severity: "error",
            nodeId: node.id,
            code: "MISSING_BRIDGE_CAPABILITY",
            message: `Bridge Capability node '${node.title}' must specify a capability.`,
          });
        }
      }

      if (node.type === "transform") {
        const rawCode = String(cfg.code || cfg.script || "");
        if (rawCode.trim().length > 0) {
          issues.push({
            severity: "error",
            nodeId: node.id,
            code: "UNSAFE_SCRIPT_DISALLOWED",
            message: `Transform node '${node.title}' cannot execute arbitrary script code; use template/extract/pick mode.`,
          });
        }
      }
    }

    // Kahn's algorithm for cycle detection + topological ordering
    const inDegree = new Map<string, number>();
    for (const [id, edgesIn] of incoming.entries()) {
      inDegree.set(id, edgesIn.length);
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) queue.push(id);
    }

    const topologicalOrder: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      topologicalOrder.push(current);
      for (const edge of outgoing.get(current) || []) {
        const nextDeg = (inDegree.get(edge.target) || 0) - 1;
        inDegree.set(edge.target, nextDeg);
        if (nextDeg === 0) {
          queue.push(edge.target);
        }
      }
    }

    if (topologicalOrder.length !== nodeMap.size) {
      issues.push({
        severity: "error",
        code: "CYCLE_DETECTED",
        message: "Workflow graph contains a cycle. Workflows must form a Directed Acyclic Graph (DAG).",
      });
    }

    // Reachability check from trigger nodes
    if (triggers.length > 0) {
      const reachable = new Set<string>(triggerNodeIds);
      const bfs = [...triggerNodeIds];
      while (bfs.length > 0) {
        const cur = bfs.shift()!;
        for (const edge of outgoing.get(cur) || []) {
          if (!reachable.has(edge.target)) {
            reachable.add(edge.target);
            bfs.push(edge.target);
          }
        }
      }

      for (const id of nodeMap.keys()) {
        if (!reachable.has(id)) {
          issues.push({
            severity: "warning",
            nodeId: id,
            code: "ORPHAN_NODE",
            message: `Node '${nodeMap.get(id)?.title}' is not reachable from any trigger node.`,
          });
        }
      }
    }

    const hasErrors = issues.some((i) => i.severity === "error");
    return {
      valid: !hasErrors,
      issues,
      topologicalOrder,
      triggerNodeIds,
    };
  }
}
