"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Network,
  Play,
  Square,
  Plus,
  Sparkles,
  CheckCircle2,
  XCircle,
  ShieldAlert,
  Layers,
  Box,
  GitFork,
  RefreshCw,
  Bot,
  Activity,
  ChevronRight,
} from "lucide-react";
import { Button, Badge, Card, CardContent, cn } from "@messiah/ui";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { ToolApprovalCard } from "@/components/tools/ToolApprovalCard";
import { SwarmTopology2D } from "./SwarmTopology2D";
import { SwarmInspectorPanel } from "./SwarmInspectorPanel";
import { shouldPrefer2DFallback, getStatusColorHex } from "./swarmTopologyModel";
import { createClient } from "@/lib/supabase/client";
import type {
  AgentDefinitionInfo,
  AgentRunInfo,
  BridgeDeviceInfo,
  SwarmRunDetail,
  WorkspaceInfo,
} from "@messiah/shared";

const SwarmConstellation3D = dynamic(() => import("./SwarmConstellation3D"), {
  ssr: false,
  loading: () => (
    <div className="flex flex-col items-center justify-center h-full min-h-[360px] bg-[#090A0F] rounded-xl border border-[#1E2536] text-xs text-[#64748B] font-mono">
      <RefreshCw className="w-5 h-5 animate-spin text-[#00FFA3] mb-2" />
      Loading WebGL 3D Constellation...
    </div>
  ),
});

interface SwarmWorkspaceProps {
  initialRunId?: string;
}

export function SwarmWorkspace({ initialRunId }: SwarmWorkspaceProps) {
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [authToken, setAuthToken] = useState<string | null>(null);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceInfo | null>(null);

  const [agents, setAgents] = useState<AgentDefinitionInfo[]>([]);
  const [devices, setDevices] = useState<BridgeDeviceInfo[]>([]);
  const [runs, setRuns] = useState<AgentRunInfo[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(initialRunId || null);
  const [runDetail, setRunDetail] = useState<SwarmRunDetail | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>("supervisor");

  // View Mode: 3D vs Accessible 2D
  const [viewMode, setViewMode] = useState<"3d" | "2d">("2d");
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);

  // Composer State
  const [isComposerOpen, setIsComposerOpen] = useState(!initialRunId);
  const [objective, setObjective] = useState("");
  const [supervisorId, setSupervisorId] = useState("");
  const [workerIds, setWorkerIds] = useState<string[]>([]);
  const [targetDeviceId, setTargetDeviceId] = useState("");
  const [requirePlanApproval, setRequirePlanApproval] = useState(false);
  const [maxTotalTokens, setMaxTotalTokens] = useState(120000);
  const [maxConcurrency, setMaxConcurrency] = useState(3);
  const [isLaunching, setIsLaunching] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3001/api/v1/realtime";

  // Detect 3D / WebGL / reduced motion preference cleanly on client
  useEffect(() => {
    const prefer2D = shouldPrefer2DFallback();
    if (prefer2D) {
      setViewMode("2d");
      if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        setFallbackReason("Auto 2D (Reduced Motion)");
      } else {
        setFallbackReason("Auto 2D (Compatibility Mode)");
      }
    } else {
      setViewMode("3d");
      setFallbackReason(null);
    }
  }, []);

  // Init session + workspace
  useEffect(() => {
    const init = async () => {
      try {
        const supabase = createClient();
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) {
          router.push("/login");
          return;
        }
        setAuthToken(session.access_token);
        const res = await fetch(`${apiUrl}/api/v1/workspaces`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (res.ok) {
          const body = await res.json();
          const wsList: WorkspaceInfo[] = body.data || [];
          if (wsList.length > 0) setActiveWorkspace(wsList[0]!);
        }
      } catch (err) {
        console.error("SwarmWorkspace auth init failed:", err);
      }
    };
    init();
  }, [apiUrl, router]);

  // Load Agents, Devices, and Runs
  const loadWorkspaceResources = useCallback(async () => {
    if (!authToken || !activeWorkspace) return;
    try {
      const [agentsRes, devicesRes, runsRes] = await Promise.all([
        fetch(`${apiUrl}/api/v1/agents?workspaceId=${activeWorkspace.id}`, {
          headers: { Authorization: `Bearer ${authToken}` },
        }),
        fetch(`${apiUrl}/api/v1/devices?workspaceId=${activeWorkspace.id}`, {
          headers: { Authorization: `Bearer ${authToken}` },
        }),
        fetch(`${apiUrl}/api/v1/swarms?workspaceId=${activeWorkspace.id}`, {
          headers: { Authorization: `Bearer ${authToken}` },
        }),
      ]);

      if (agentsRes.ok) {
        const list: AgentDefinitionInfo[] = (await agentsRes.json()).data || [];
        setAgents(list);
        const firstSup = list.find((a) => a.canSupervise && a.status === "ACTIVE");
        if (firstSup && !supervisorId) setSupervisorId(firstSup.id);
        const defaultWorkers = list
          .filter((a) => !a.canSupervise && a.status === "ACTIVE" && a.modelId && a.providerConnectionId)
          .slice(0, 3)
          .map((a) => a.id);
        if (defaultWorkers.length > 0 && workerIds.length === 0) {
          setWorkerIds(defaultWorkers);
        }
      }

      if (devicesRes.ok) {
        setDevices((await devicesRes.json()).data || []);
      }

      if (runsRes.ok) {
        const runsList: AgentRunInfo[] = (await runsRes.json()).data || [];
        setRuns(runsList);
        if (!selectedRunId && runsList.length > 0 && initialRunId) {
          setSelectedRunId(initialRunId);
        }
      }
    } catch (err) {
      console.error("Failed loading swarm resources:", err);
    }
  }, [authToken, activeWorkspace, apiUrl, supervisorId, workerIds.length, selectedRunId, initialRunId]);

  useEffect(() => {
    loadWorkspaceResources();
  }, [loadWorkspaceResources]);

  // Fetch Run Detail
  const fetchRunDetail = useCallback(
    async (runId: string) => {
      if (!authToken || !activeWorkspace) return;
      try {
        const res = await fetch(
          `${apiUrl}/api/v1/swarms/${runId}?workspaceId=${activeWorkspace.id}`,
          { headers: { Authorization: `Bearer ${authToken}` } }
        );
        if (res.ok) {
          const detail: SwarmRunDetail = (await res.json()).data;
          setRunDetail(detail);
        }
      } catch (err) {
        console.error("Failed loading swarm detail:", err);
      }
    },
    [authToken, activeWorkspace, apiUrl]
  );

  useEffect(() => {
    if (selectedRunId) {
      fetchRunDetail(selectedRunId);
    }
  }, [selectedRunId, fetchRunDetail]);

  // WebSocket Subscription + Automatic Reconnect State Reconciliation
  useEffect(() => {
    if (!authToken || !activeWorkspace || !selectedRunId) return;

    let cancelled = false;
    let pollTimer: NodeJS.Timeout | null = null;

    const connectRealtime = async () => {
      try {
        const ticketRes = await fetch(`${apiUrl}/api/v1/realtime/ticket`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ workspaceId: activeWorkspace.id }),
        });
        if (!ticketRes.ok || cancelled) return;
        const ticket = (await ticketRes.json()).data.ticket;

        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          ws.send(JSON.stringify({ action: "auth", ticket }));
        };

        ws.onmessage = (msg) => {
          try {
            const frame = JSON.parse(msg.data);
            if (frame.event === "auth.success") {
              ws.send(JSON.stringify({ action: "swarm.subscribe", runId: selectedRunId }));
            } else if (frame.event === "swarm.snapshot" && frame.data) {
              setRunDetail(frame.data as SwarmRunDetail);
            } else if (typeof frame.event === "string" && frame.event.startsWith("swarm.")) {
              // Refresh authoritative state so tasks, comms, artifacts, approvals, and events stay 100% consistent
              fetchRunDetail(selectedRunId);
              loadWorkspaceResources();
            }
          } catch {}
        };

        ws.onclose = () => {
          if (!cancelled) {
            fetchRunDetail(selectedRunId);
          }
        };
      } catch {}
    };

    connectRealtime();

    // Resilient fallback poll while run is active
    pollTimer = setInterval(() => {
      if (
        runDetail &&
        ["PENDING", "PLANNING", "RUNNING", "SYNTHESIZING", "AWAITING_APPROVAL", "AWAITING_PLAN_APPROVAL"].includes(
          runDetail.status
        )
      ) {
        fetchRunDetail(selectedRunId);
      }
    }, 3000);

    return () => {
      cancelled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [authToken, activeWorkspace, selectedRunId, apiUrl, wsUrl, fetchRunDetail, loadWorkspaceResources, runDetail?.status]);

  const handleSeedTemplates = async () => {
    if (!authToken || !activeWorkspace) return;
    setActionError(null);
    const res = await fetch(`${apiUrl}/api/v1/agents/templates/seed`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workspaceId: activeWorkspace.id }),
    });
    if (res.ok) {
      await loadWorkspaceResources();
    } else {
      const err = await res.json();
      setActionError(err.error?.message || "Failed to seed agent templates.");
    }
  };

  const handleLaunchSwarm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authToken || !activeWorkspace || !supervisorId || workerIds.length === 0 || !objective.trim()) {
      setActionError("Select a Supervisor, at least 1 Worker agent, and enter an objective.");
      return;
    }

    setIsLaunching(true);
    setActionError(null);

    try {
      const res = await fetch(`${apiUrl}/api/v1/swarms`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workspaceId: activeWorkspace.id,
          supervisorAgentId: supervisorId,
          workerAgentIds: workerIds,
          objective: objective.trim(),
          requirePlanApproval,
          maxTotalTokens,
          maxConcurrency,
          targetBridgeDeviceId: targetDeviceId || undefined,
        }),
      });

      const body = await res.json();
      if (!res.ok) {
        setActionError(body.error?.message || "Failed to start swarm run.");
        return;
      }

      const launched: AgentRunInfo = body.data;
      setSelectedRunId(launched.id);
      setSelectedNodeId("supervisor");
      setIsComposerOpen(false);
      setObjective("");
      await loadWorkspaceResources();
      await fetchRunDetail(launched.id);
      router.push(`/swarms/${launched.id}`);
    } catch {
      setActionError("Network error starting swarm orchestration.");
    } finally {
      setIsLaunching(false);
    }
  };

  const handlePlanDecision = async (action: "approve" | "reject") => {
    if (!authToken || !activeWorkspace || !runDetail) return;
    const res = await fetch(`${apiUrl}/api/v1/swarms/${runDetail.id}/approve-plan`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workspaceId: activeWorkspace.id, action }),
    });
    if (res.ok) {
      await fetchRunDetail(runDetail.id);
    }
  };

  const handleCancelRun = async () => {
    if (!authToken || !activeWorkspace || !runDetail) return;
    await fetch(`${apiUrl}/api/v1/swarms/${runDetail.id}/cancel`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workspaceId: activeWorkspace.id }),
    });
    await fetchRunDetail(runDetail.id);
  };

  const handleApproveTool = async (approvalId: string) => {
    if (!authToken || !activeWorkspace || !runDetail) return;
    await fetch(`${apiUrl}/api/v1/tool-approvals/${approvalId}/approve`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workspaceId: activeWorkspace.id }),
    });
    await fetchRunDetail(runDetail.id);
  };

  const handleDenyTool = async (approvalId: string, reason?: string) => {
    if (!authToken || !activeWorkspace || !runDetail) return;
    await fetch(`${apiUrl}/api/v1/tool-approvals/${approvalId}/deny`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workspaceId: activeWorkspace.id, reason }),
    });
    await fetchRunDetail(runDetail.id);
  };

  const toggleWorker = (id: string) => {
    setWorkerIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const supervisorCandidates = agents.filter((a) => a.canSupervise && a.status === "ACTIVE");
  const workerCandidates = agents.filter((a) => a.status === "ACTIVE" && a.id !== supervisorId);

  return (
    <div className="flex h-screen flex-col bg-[#090A0F] text-[#F0F4FC]">
      <Header onToggleSidebar={() => setSidebarOpen((p) => !p)} />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          activeTab="swarms"
          onSelectTab={() => {}}
        />

        <main className="flex-1 flex flex-col overflow-hidden">
          {/* Top Swarm Command Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 md:px-6 py-3 border-b border-[#1E2536] bg-[#0E121B]">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-[#00FFA3]/10 border border-[#00FFA3]/30 flex items-center justify-center">
                <Network className="w-4 h-4 text-[#00FFA3]" />
              </div>
              <div>
                <h1 className="text-sm font-semibold text-[#F0F4FC]">
                  Multi-Agent Swarm Topology
                </h1>
                <p className="text-[11px] text-[#64748B]">
                  Supervisor DAG planning, concurrent execution, and 3D Constellation telemetry
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {/* View Switcher: 3D vs 2D Accessible */}
              <div className="inline-flex rounded-lg border border-[#1E2536] bg-[#090A0F] p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => {
                    setViewMode("3d");
                    setFallbackReason(null);
                  }}
                  className={cn(
                    "px-2.5 py-1 rounded-md flex items-center gap-1 transition-colors",
                    viewMode === "3d"
                      ? "bg-[#12151E] text-[#00FFA3] font-medium"
                      : "text-[#64748B] hover:text-[#CBD5E1]"
                  )}
                >
                  <Box className="w-3.5 h-3.5" />
                  3D Constellation
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode("2d")}
                  className={cn(
                    "px-2.5 py-1 rounded-md flex items-center gap-1 transition-colors",
                    viewMode === "2d"
                      ? "bg-[#12151E] text-[#00FFA3] font-medium"
                      : "text-[#64748B] hover:text-[#CBD5E1]"
                  )}
                >
                  <GitFork className="w-3.5 h-3.5" />
                  2D Accessible
                </button>
              </div>

              <Button
                type="button"
                variant="outline"
                onClick={() => setIsComposerOpen((p) => !p)}
                className="h-8 text-xs border-[#1E2536] bg-[#090A0F] hover:border-[#00FFA3]"
              >
                <Plus className="w-3.5 h-3.5 mr-1 text-[#00FFA3]" />
                New Swarm Run
              </Button>
            </div>
          </div>

          <div className="flex-1 flex overflow-hidden">
            {/* Left Runs Sidebar */}
            <aside className="hidden lg:flex w-64 shrink-0 flex-col border-r border-[#1E2536] bg-[#0A0D14]">
              <div className="px-3.5 py-2.5 border-b border-[#1E2536] flex items-center justify-between">
                <span className="text-[11px] font-mono uppercase tracking-wider text-[#64748B]">
                  Recent Swarms ({runs.length})
                </span>
                <Link href="/agents" className="text-[11px] text-[#00FFA3] hover:underline">
                  Agents →
                </Link>
              </div>
              <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
                {runs.length === 0 ? (
                  <div className="p-4 text-center text-xs text-[#64748B]">
                    No swarm runs yet. Launch one to inspect topology.
                  </div>
                ) : (
                  runs.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => {
                        setSelectedRunId(r.id);
                        setIsComposerOpen(false);
                        router.push(`/swarms/${r.id}`);
                      }}
                      className={cn(
                        "w-full text-left rounded-lg border px-2.5 py-2 transition-colors text-xs",
                        selectedRunId === r.id
                          ? "border-[#00FFA3]/60 bg-[#00FFA3]/5"
                          : "border-[#1E2536] bg-[#0E121B] hover:border-[#2A344D]"
                      )}
                    >
                      <div className="flex items-center justify-between gap-1 mb-1">
                        <span
                          className="font-mono text-[10px]"
                          style={{ color: getStatusColorHex(r.status) }}
                        >
                          {r.status}
                        </span>
                        <span className="font-mono text-[10px] text-[#64748B]">
                          {r.inputTokens + r.outputTokens}t
                        </span>
                      </div>
                      <div className="text-[#F0F4FC] line-clamp-2 font-medium">{r.objective}</div>
                    </button>
                  ))
                )}
              </div>
            </aside>

            {/* Center Workspace */}
            <div className="flex-1 flex flex-col overflow-y-auto p-4 md:p-6 space-y-4">
              {isComposerOpen && (
                <Card className="border-[#1E2536] bg-[#0E121B]">
                  <CardContent className="p-5 space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-[#00FFA3]" />
                        <h2 className="text-sm font-semibold">Launch Multi-Agent Swarm</h2>
                      </div>
                      {agents.length === 0 && (
                        <Button
                          type="button"
                          onClick={handleSeedTemplates}
                          variant="outline"
                          className="h-7 text-xs border-[#00FFA3]/40 text-[#00FFA3]"
                        >
                          Seed Default Agent Roster
                        </Button>
                      )}
                    </div>

                    {actionError && (
                      <div className="rounded-lg border border-red-500/30 bg-red-950/20 px-3 py-2 text-xs text-red-300">
                        {actionError}
                      </div>
                    )}

                    <form onSubmit={handleLaunchSwarm} className="space-y-4">
                      <div>
                        <label className="block text-xs text-[#94A3B8] mb-1.5">
                          Swarm Objective
                        </label>
                        <textarea
                          rows={3}
                          value={objective}
                          onChange={(e) => setObjective(e.target.value)}
                          placeholder="e.g., Audit the authentication API, identify edge cases, draft a patch, and run a security review..."
                          className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2 text-xs text-[#F0F4FC] placeholder-[#64748B] focus:outline-none focus:border-[#00FFA3]"
                        />
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs text-[#94A3B8] mb-1.5">
                            Supervisor Agent (DAG Planner)
                          </label>
                          <select
                            value={supervisorId}
                            onChange={(e) => setSupervisorId(e.target.value)}
                            className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2 text-xs text-[#F0F4FC]"
                          >
                            <option value="">Select Supervisor...</option>
                            {supervisorCandidates.map((sup) => (
                              <option key={sup.id} value={sup.id}>
                                {sup.name} ({sup.modelId || "Unconfigured model"})
                              </option>
                            ))}
                          </select>
                        </div>

                        <div>
                          <label className="block text-xs text-[#94A3B8] mb-1.5">
                            Target Workstation Bridge (Optional)
                          </label>
                          <select
                            value={targetDeviceId}
                            onChange={(e) => setTargetDeviceId(e.target.value)}
                            className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2 text-xs text-[#F0F4FC]"
                          >
                            <option value="">Cloud / Remote MCP Only</option>
                            {devices
                              .filter((d) => d.status === "ACTIVE")
                              .map((dev) => (
                                <option key={dev.id} value={dev.id}>
                                  {dev.displayName} ({dev.platform} • {dev.isOnline ? "Online" : "Offline"})
                                </option>
                              ))}
                          </select>
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs text-[#94A3B8] mb-1.5">
                          Participating Worker Agents ({workerIds.length} selected)
                        </label>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                          {workerCandidates.map((w) => {
                            const selected = workerIds.includes(w.id);
                            return (
                              <button
                                key={w.id}
                                type="button"
                                onClick={() => toggleWorker(w.id)}
                                className={cn(
                                  "flex items-center justify-between rounded-lg border px-3 py-2 text-left text-xs transition-colors",
                                  selected
                                    ? "border-[#00FFA3] bg-[#00FFA3]/10 text-[#F0F4FC]"
                                    : "border-[#1E2536] bg-[#090A0F] text-[#94A3B8]"
                                )}
                              >
                                <div className="truncate pr-2">
                                  <div className="font-medium truncate">{w.name}</div>
                                  <div className="text-[10px] font-mono text-[#64748B] truncate">
                                    {w.roleTitle} • {w.modelId || "no model"}
                                  </div>
                                </div>
                                {selected && <CheckCircle2 className="w-3.5 h-3.5 text-[#00FFA3] shrink-0" />}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-4 pt-2 border-t border-[#1E2536]">
                        <div className="flex flex-wrap items-center gap-4 text-xs text-[#94A3B8]">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={requirePlanApproval}
                              onChange={(e) => setRequirePlanApproval(e.target.checked)}
                              className="accent-[#00FFA3]"
                            />
                            Require human plan approval before worker execution
                          </label>

                          <div className="flex items-center gap-1.5 font-mono text-[11px]">
                            <span>Concurrency:</span>
                            <input
                              type="number"
                              min={1}
                              max={5}
                              value={maxConcurrency}
                              onChange={(e) => setMaxConcurrency(Number(e.target.value))}
                              className="w-12 rounded border border-[#1E2536] bg-[#090A0F] px-1.5 py-0.5 text-[#F0F4FC]"
                            />
                          </div>

                          <div className="flex items-center gap-1.5 font-mono text-[11px]">
                            <span>Max Tokens:</span>
                            <input
                              type="number"
                              min={5000}
                              max={500000}
                              step={5000}
                              value={maxTotalTokens}
                              onChange={(e) => setMaxTotalTokens(Number(e.target.value))}
                              className="w-20 rounded border border-[#1E2536] bg-[#090A0F] px-1.5 py-0.5 text-[#F0F4FC]"
                            />
                          </div>
                        </div>

                        <Button
                          type="submit"
                          disabled={isLaunching}
                          className="h-8 px-4 bg-[#00FFA3] text-black hover:bg-[#00FFA3]/90 text-xs font-semibold"
                        >
                          {isLaunching ? (
                            <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                          ) : (
                            <Play className="w-3.5 h-3.5 mr-1.5 fill-current" />
                          )}
                          Orchestrate Swarm
                        </Button>
                      </div>
                    </form>
                  </CardContent>
                </Card>
              )}

              {runDetail && (
                <>
                  {/* Run Header + Controls */}
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#1E2536] bg-[#0E121B] px-4 py-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="outline"
                          className="font-mono text-[10px] border-[#1E2536]"
                          style={{ color: getStatusColorHex(runDetail.status) }}
                        >
                          {runDetail.status}
                        </Badge>
                        <span className="font-mono text-[11px] text-[#64748B]">
                          Run {runDetail.id.slice(0, 8)} • {runDetail.inputTokens + runDetail.outputTokens} tokens • ${runDetail.estimatedCostUsd.toFixed(4)}
                        </span>
                      </div>
                      <h2 className="text-sm font-medium text-[#F0F4FC] mt-1 truncate">
                        {runDetail.objective}
                      </h2>
                    </div>

                    {["PENDING", "PLANNING", "RUNNING", "AWAITING_APPROVAL", "AWAITING_PLAN_APPROVAL", "SYNTHESIZING"].includes(
                      runDetail.status
                    ) && (
                      <Button
                        type="button"
                        onClick={handleCancelRun}
                        className="h-7 px-3 bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30 text-xs"
                      >
                        <Square className="w-3 h-3 mr-1 fill-current" />
                        Cancel Swarm
                      </Button>
                    )}
                  </div>

                  {/* Pre-Run Plan Approval Gate */}
                  {runDetail.status === "AWAITING_PLAN_APPROVAL" && (
                    <div className="rounded-xl border border-amber-500/40 bg-amber-950/20 p-4 flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5 text-xs text-amber-200">
                        <ShieldAlert className="w-5 h-5 text-amber-400 shrink-0" />
                        <div>
                          <div className="font-semibold">Execution Plan Ready for Review</div>
                          <div className="text-amber-300/80">
                            {runDetail.tasks.length} tasks compiled by supervisor. Approve to begin concurrent worker execution.
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          onClick={() => handlePlanDecision("reject")}
                          variant="outline"
                          className="h-8 text-xs border-red-500/40 text-red-400"
                        >
                          <XCircle className="w-3.5 h-3.5 mr-1" />
                          Reject
                        </Button>
                        <Button
                          type="button"
                          onClick={() => handlePlanDecision("approve")}
                          className="h-8 text-xs bg-[#00FFA3] text-black font-semibold"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
                          Approve & Execute
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* Pending HITL Tool Approval Cards */}
                  {runDetail.pendingToolApprovals && runDetail.pendingToolApprovals.length > 0 && (
                    <div className="space-y-3">
                      {runDetail.pendingToolApprovals.map((appItem) => (
                        <ToolApprovalCard
                          key={appItem.id}
                          approvalId={appItem.id}
                          toolCallId={appItem.toolCallId}
                          toolName={appItem.toolCall?.toolName || "mcp_tool"}
                          providerToolAlias={appItem.toolCall?.providerToolAlias || ""}
                          argumentsPreview={appItem.toolCall?.argumentsPreview || {}}
                          status={appItem.status}
                          expiresAt={appItem.expiresAt}
                          onApprove={handleApproveTool}
                          onDeny={handleDenyTool}
                        />
                      ))}
                    </div>
                  )}

                  {/* Main Topology + Right Inspector Grid */}
                  <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 min-h-[460px]">
                    <div className="xl:col-span-8 min-h-[420px]">
                      {viewMode === "3d" ? (
                        <SwarmConstellation3D
                          run={runDetail}
                          selectedNodeId={selectedNodeId}
                          onSelectNode={(id) => setSelectedNodeId(id)}
                          onWebGLFailure={(reason) => {
                            setViewMode("2d");
                            setFallbackReason(`2D Fallback (${reason})`);
                          }}
                        />
                      ) : (
                        <SwarmTopology2D
                          run={runDetail}
                          selectedNodeId={selectedNodeId}
                          onSelectNode={(id) => setSelectedNodeId(id)}
                          fallbackReason={fallbackReason}
                        />
                      )}
                    </div>

                    <div className="xl:col-span-4 min-h-[420px]">
                      <SwarmInspectorPanel run={runDetail} selectedNodeId={selectedNodeId} />
                    </div>
                  </div>

                  {/* Final Supervisor Synthesized Deliverable */}
                  {runDetail.finalSummary && (
                    <Card className="border-[#00FFA3]/30 bg-[#0E121B]">
                      <CardContent className="p-5 space-y-2">
                        <div className="flex items-center gap-2 text-xs font-semibold text-[#00FFA3]">
                          <Layers className="w-4 h-4" />
                          <span>Final Supervisor Deliverable</span>
                        </div>
                        <MarkdownRenderer content={runDetail.finalSummary} />
                      </CardContent>
                    </Card>
                  )}

                  {/* Realtime Telemetry Event Feed */}
                  {runDetail.events.length > 0 && (
                    <Card className="border-[#1E2536] bg-[#0E121B]">
                      <CardContent className="p-4 space-y-2">
                        <div className="flex items-center gap-2 text-xs font-mono uppercase text-[#64748B]">
                          <Activity className="w-3.5 h-3.5 text-[#00FFA3]" />
                          Execution Timeline ({runDetail.events.length} events)
                        </div>
                        <div className="max-h-48 overflow-y-auto divide-y divide-[#1E2536]/60 text-[11px] font-mono">
                          {[...runDetail.events].reverse().map((ev) => (
                            <div key={ev.id} className="py-1.5 flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2 truncate">
                                <span className="text-[#64748B]">#{ev.sequence}</span>
                                <ChevronRight className="w-3 h-3 text-[#00FFA3]" />
                                <span className="text-[#F0F4FC]">{ev.eventType}</span>
                                {ev.payload?.taskKey ? (
                                  <span className="text-[#38BDF8]">[{String(ev.payload.taskKey)}]</span>
                                ) : null}
                              </div>
                              <span className="text-[#64748B] shrink-0">
                                {new Date(ev.createdAt).toLocaleTimeString()}
                              </span>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  )}
                </>
              )}

              {!runDetail && !isComposerOpen && (
                <div className="flex flex-col items-center justify-center py-20 text-center text-xs text-[#64748B]">
                  <Bot className="w-8 h-8 text-[#00FFA3] mb-3 opacity-80" />
                  Select a swarm run from the left or click &quot;New Swarm Run&quot; to begin.
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
