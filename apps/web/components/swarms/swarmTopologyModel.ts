import type { AgentRunStatus, AgentTaskStatus, SwarmRunDetail } from "@messiah/shared";

export type TopologyNodeStatus =
  | "PENDING"
  | "QUEUED"
  | "RUNNING"
  | "AWAITING_APPROVAL"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "SKIPPED"
  | "UNKNOWN_OUTCOME";

export interface ConstellationNode {
  id: string; // "supervisor" or AgentTask.id
  kind: "supervisor" | "task";
  taskKey?: string;
  title: string;
  subtitle: string;
  agentId: string;
  agentName: string;
  modelId: string | null;
  status: TopologyNodeStatus;
  accentColor: string;
  waveIndex: number;
  inputTokens: number;
  outputTokens: number;
  x3d: number;
  y3d: number;
  z3d: number;
  x2d: number; // percentage 0-100
  y2d: number; // percentage 0-100
}

export interface ConstellationEdge {
  id: string;
  sourceId: string;
  targetId: string;
  kind: "delegation" | "dependency" | "synthesis";
  active: boolean;
  attention: boolean;
}

export interface ConstellationGraph {
  nodes: ConstellationNode[];
  edges: ConstellationEdge[];
}

export function getStatusColorHex(status: AgentRunStatus | AgentTaskStatus | string): string {
  switch (status) {
    case "RUNNING":
    case "PLANNING":
    case "SYNTHESIZING":
      return "#00FFA3";
    case "AWAITING_APPROVAL":
    case "AWAITING_PLAN_APPROVAL":
      return "#FBBF24";
    case "COMPLETED":
    case "PARTIAL_COMPLETED":
      return "#10B981";
    case "FAILED":
    case "UNKNOWN_OUTCOME":
      return "#EF4444";
    case "QUEUED":
      return "#38BDF8";
    default:
      return "#64748B";
  }
}

export function shouldPrefer2DFallback(env?: {
  hasWebGL?: boolean;
  prefersReducedMotion?: boolean;
  isNarrowViewport?: boolean;
  lowHardwareConcurrency?: boolean;
}): boolean {
  const hasWebGL = env?.hasWebGL ?? detectWebGLSupport();
  const prefersReducedMotion =
    env?.prefersReducedMotion ??
    (typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const lowHardware =
    env?.lowHardwareConcurrency ??
    (typeof navigator !== "undefined" &&
      typeof navigator.hardwareConcurrency === "number" &&
      navigator.hardwareConcurrency <= 2);

  return !hasWebGL || prefersReducedMotion || lowHardware;
}

export function detectWebGLSupport(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return false;
  }
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    return Boolean(gl);
  } catch {
    return false;
  }
}

/**
 * Transforms an authoritative SwarmRunDetail into deterministic 3D orbital coordinates
 * and accessible 2D hierarchical coordinates grouped by topological wave depth.
 */
export function buildConstellationGraph(run: SwarmRunDetail): ConstellationGraph {
  const nodes: ConstellationNode[] = [];
  const edges: ConstellationEdge[] = [];

  const supStatus: TopologyNodeStatus =
    run.status === "AWAITING_PLAN_APPROVAL" || run.status === "AWAITING_APPROVAL"
      ? "AWAITING_APPROVAL"
      : run.status === "PLANNING" || run.status === "SYNTHESIZING" || run.status === "RUNNING"
      ? "RUNNING"
      : run.status === "COMPLETED" || run.status === "PARTIAL_COMPLETED"
      ? "COMPLETED"
      : run.status === "FAILED"
      ? "FAILED"
      : run.status === "CANCELLED"
      ? "CANCELLED"
      : "PENDING";

  nodes.push({
    id: "supervisor",
    kind: "supervisor",
    title: run.supervisorAgent?.name || "Supervisor Agent",
    subtitle: run.supervisorAgent?.roleTitle || "Orchestrator",
    agentId: run.supervisorAgentId,
    agentName: run.supervisorAgent?.name || "Supervisor",
    modelId: run.supervisorAgent?.modelId || null,
    status: supStatus,
    accentColor: run.supervisorAgent?.avatarAccent || "#00FFA3",
    waveIndex: 0,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    x3d: 0,
    y3d: 3.4,
    z3d: 0,
    x2d: 50,
    y2d: 14,
  });

  if (!run.tasks || run.tasks.length === 0) {
    return { nodes, edges };
  }

  // Compute topological wave depth per task from dependsOnKeys
  const taskByKey = new Map(run.tasks.map((t) => [t.taskKey, t]));
  const depthCache = new Map<string, number>();

  const computeDepth = (taskKey: string, visited = new Set<string>()): number => {
    if (depthCache.has(taskKey)) return depthCache.get(taskKey)!;
    if (visited.has(taskKey)) return 1;
    visited.add(taskKey);
    const task = taskByKey.get(taskKey);
    if (!task || task.dependsOnKeys.length === 0) {
      depthCache.set(taskKey, 1);
      return 1;
    }
    const maxParent = Math.max(
      ...task.dependsOnKeys.map((dk) => computeDepth(dk, new Set(visited)))
    );
    const depth = maxParent + 1;
    depthCache.set(taskKey, depth);
    return depth;
  };

  for (const t of run.tasks) {
    computeDepth(t.taskKey);
  }

  // Group tasks by depth wave
  const waves = new Map<number, typeof run.tasks>();
  let maxDepth = 1;
  for (const t of run.tasks) {
    const d = depthCache.get(t.taskKey) || 1;
    if (d > maxDepth) maxDepth = d;
    if (!waves.has(d)) waves.set(d, []);
    waves.get(d)!.push(t);
  }

  const taskIdByKey = new Map(run.tasks.map((t) => [t.taskKey, t.id]));

  for (const [waveDepth, group] of waves.entries()) {
    const count = group.length;
    const radius = Math.max(3.6, Math.min(6.4, count * 1.45));
    const y3d = 3.4 - waveDepth * 2.55;
    const y2d = Math.min(86, 18 + (waveDepth / (maxDepth + 0.35)) * 70);

    group.forEach((task, idx) => {
      const angle = (idx / Math.max(count, 1)) * Math.PI * 2 - Math.PI / 2;
      const x3d = count === 1 ? 0 : Math.cos(angle) * radius;
      const z3d = count === 1 ? 0 : Math.sin(angle) * radius;
      const x2d = count === 1 ? 50 : 14 + ((idx + 0.5) / count) * 72;

      nodes.push({
        id: task.id,
        kind: "task",
        taskKey: task.taskKey,
        title: task.title,
        subtitle: task.assignedAgent?.name || "Worker",
        agentId: task.assignedAgentId,
        agentName: task.assignedAgent?.name || "Worker",
        modelId: task.assignedAgent?.modelId || null,
        status: task.status,
        accentColor: task.assignedAgent?.avatarAccent || "#38BDF8",
        waveIndex: waveDepth,
        inputTokens: task.inputTokens,
        outputTokens: task.outputTokens,
        x3d,
        y3d,
        z3d,
        x2d,
        y2d,
      });

      // Delegation edge from supervisor -> wave 1 root tasks
      if (task.dependsOnKeys.length === 0) {
        edges.push({
          id: `sup-${task.id}`,
          sourceId: "supervisor",
          targetId: task.id,
          kind: "delegation",
          active: task.status === "RUNNING" || task.status === "QUEUED",
          attention: task.status === "AWAITING_APPROVAL",
        });
      } else {
        for (const depKey of task.dependsOnKeys) {
          const parentId = taskIdByKey.get(depKey);
          if (parentId) {
            edges.push({
              id: `${parentId}-${task.id}`,
              sourceId: parentId,
              targetId: task.id,
              kind: "dependency",
              active: task.status === "RUNNING" || task.status === "QUEUED",
              attention: task.status === "AWAITING_APPROVAL",
            });
          }
        }
      }

      // If no downstream dependents and synthesis active/completed, show return arc to supervisor
      const hasChild = run.tasks.some((other) => other.dependsOnKeys.includes(task.taskKey));
      if (!hasChild && (run.status === "SYNTHESIZING" || run.status === "COMPLETED" || run.status === "PARTIAL_COMPLETED")) {
        edges.push({
          id: `synth-${task.id}`,
          sourceId: task.id,
          targetId: "supervisor",
          kind: "synthesis",
          active: run.status === "SYNTHESIZING",
          attention: false,
        });
      }
    });
  }

  return { nodes, edges };
}
