import { describe, it, expect } from "vitest";
import { buildConstellationGraph, getStatusColorHex, shouldPrefer2DFallback } from "./swarmTopologyModel";
import type { SwarmRunDetail } from "@messiah/shared";

describe("Phase 5: Swarm Constellation Model & Accessibility Fallback", () => {
  const sampleRun: SwarmRunDetail = {
    id: "run-1",
    workspaceId: "ws-1",
    createdByUserId: "user-1",
    threadId: null,
    assistantMessageId: null,
    supervisorAgentId: "sup-1",
    supervisorVersionId: null,
    supervisorAgent: {
      id: "sup-1",
      name: "Supervisor Architect",
      roleTitle: "Orchestrator",
      category: "supervisor",
      avatarAccent: "#00FFA3",
      modelId: "gpt-4o",
    },
    workerAgentIds: ["w-1", "w-2"],
    objective: "Audit and review",
    status: "RUNNING",
    requirePlanApproval: false,
    planApprovedAt: null,
    planJson: null,
    maxTotalTokens: 100000,
    maxCostUsd: 2,
    maxDurationMs: 300000,
    maxConcurrency: 3,
    maxDelegationDepth: 2,
    maxReplanRounds: 1,
    replanCount: 0,
    inputTokens: 100,
    outputTokens: 50,
    estimatedCostUsd: 0.002,
    finalSummary: null,
    safeErrorCode: null,
    errorMessage: null,
    cancellationRequestedAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: [
      {
        id: "t-1",
        runId: "run-1",
        workspaceId: "ws-1",
        taskKey: "scan_a",
        title: "Scan A",
        instructions: "Inspect A",
        assignedAgentId: "w-1",
        assignedVersionId: null,
        assignedAgent: {
          id: "w-1",
          name: "Researcher",
          roleTitle: "Research",
          category: "research",
          avatarAccent: "#38BDF8",
          modelId: "gpt-4o-mini",
        },
        dependsOnKeys: [],
        inputTaskKeys: [],
        delegationDepth: 1,
        fingerprint: "fp1",
        status: "COMPLETED",
        priority: 1,
        maxIterations: 4,
        targetBridgeDeviceId: null,
        outputSummary: "Done A",
        outputData: null,
        errorCode: null,
        errorMessage: null,
        inputTokens: 40,
        outputTokens: 20,
        attemptCount: 1,
        startedAt: null,
        completedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "t-2",
        runId: "run-1",
        workspaceId: "ws-1",
        taskKey: "review_b",
        title: "Review B",
        instructions: "Review A",
        assignedAgentId: "w-2",
        assignedVersionId: null,
        assignedAgent: {
          id: "w-2",
          name: "Reviewer",
          roleTitle: "Reviewer",
          category: "reviewer",
          avatarAccent: "#F472B6",
          modelId: "gpt-4o-mini",
        },
        dependsOnKeys: ["scan_a"],
        inputTaskKeys: ["scan_a"],
        delegationDepth: 1,
        fingerprint: "fp2",
        status: "RUNNING",
        priority: 1,
        maxIterations: 4,
        targetBridgeDeviceId: null,
        outputSummary: null,
        outputData: null,
        errorCode: null,
        errorMessage: null,
        inputTokens: 60,
        outputTokens: 30,
        attemptCount: 1,
        startedAt: null,
        completedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    executions: [],
    communications: [],
    artifacts: [],
    events: [],
  };

  it("constructs supervisor root + layered topological wave nodes and edges", () => {
    const graph = buildConstellationGraph(sampleRun);
    expect(graph.nodes.length).toBe(3);

    const supNode = graph.nodes.find((n) => n.id === "supervisor")!;
    const t1Node = graph.nodes.find((n) => n.id === "t-1")!;
    const t2Node = graph.nodes.find((n) => n.id === "t-2")!;

    expect(supNode.waveIndex).toBe(0);
    expect(t1Node.waveIndex).toBe(1);
    expect(t2Node.waveIndex).toBe(2);
    expect(t2Node.y3d).toBeLessThan(t1Node.y3d);

    expect(graph.edges.some((e) => e.sourceId === "supervisor" && e.targetId === "t-1")).toBe(true);
    expect(graph.edges.some((e) => e.sourceId === "t-1" && e.targetId === "t-2" && e.active)).toBe(true);
  });

  it("auto-selects accessible 2D fallback when WebGL is missing, reduced motion enabled, or low hardware cores", () => {
    expect(shouldPrefer2DFallback({ hasWebGL: false, prefersReducedMotion: false, lowHardwareConcurrency: false })).toBe(true);
    expect(shouldPrefer2DFallback({ hasWebGL: true, prefersReducedMotion: true, lowHardwareConcurrency: false })).toBe(true);
    expect(shouldPrefer2DFallback({ hasWebGL: true, prefersReducedMotion: false, lowHardwareConcurrency: true })).toBe(true);
    expect(shouldPrefer2DFallback({ hasWebGL: true, prefersReducedMotion: false, lowHardwareConcurrency: false })).toBe(false);
  });

  it("maps statuses to expected Obsidian telemetry accent colors", () => {
    expect(getStatusColorHex("RUNNING")).toBe("#00FFA3");
    expect(getStatusColorHex("AWAITING_APPROVAL")).toBe("#FBBF24");
    expect(getStatusColorHex("FAILED")).toBe("#EF4444");
  });
});
