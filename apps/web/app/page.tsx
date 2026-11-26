"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  Server,
  Database,
  Cpu,
  Bot,
  Laptop2,
  Sparkles,
  RefreshCw,
  CheckCircle2,
  Key,
  MessageSquare,
  GitFork,
  Workflow,
  ShieldAlert,
  ArrowRight,
  Circle,
} from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Badge,
  StatusDot,
  Button,
} from "@messiah/ui";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { createClient } from "@/lib/supabase/client";
import { pickPreferredWorkspace } from "@/lib/desktopBridge";
import type { WorkspaceInfo } from "@messiah/shared";

interface HealthData {
  status: string;
  timestamp: string;
  version: string;
  checks?: {
    database?: { status: string; latencyMs?: number; message?: string };
    redis?: { status: string; latencyMs?: number; message?: string };
  };
}

interface WorkspaceStats {
  providersCount: number;
  agentsCount: number;
  devicesCount: number;
  onlineDevicesCount: number;
  threadsCount: number;
  swarmsCount: number;
  workflowsCount: number;
  memoriesCount: number;
  pendingApprovalsCount: number;
}

export default function DashboardPage() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("overview");
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceInfo | null>(null);
  const [healthData, setHealthData] = useState<HealthData | null>(null);
  const [isLoadingHealth, setIsLoadingHealth] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [stats, setStats] = useState<WorkspaceStats>({
    providersCount: 0,
    agentsCount: 0,
    devicesCount: 0,
    onlineDevicesCount: 0,
    threadsCount: 0,
    swarmsCount: 0,
    workflowsCount: 0,
    memoriesCount: 0,
    pendingApprovalsCount: 0,
  });

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

  const fetchAll = useCallback(async () => {
    setIsLoadingHealth(true);
    setHealthError(null);
    try {
      const hRes = await fetch(`${apiUrl}/health/ready`, { cache: "no-store" });
      if (hRes.ok || hRes.status === 503) {
        setHealthData(await hRes.json());
      }
    } catch {
      setHealthError(`Unable to connect to Messiah gateway on ${apiUrl}`);
    } finally {
      setIsLoadingHealth(false);
    }

    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) return;

      const wsRes = await fetch(`${apiUrl}/api/v1/workspaces`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!wsRes.ok) return;
      const wsBody = await wsRes.json();
      const wsList: WorkspaceInfo[] = Array.isArray(wsBody) ? wsBody : wsBody.data || [];
      const ws = activeWorkspace || pickPreferredWorkspace(wsList);
      if (!ws) return;
      setActiveWorkspace(ws);

      const headers = { Authorization: `Bearer ${session.access_token}` };
      const [provR, agR, devR, thR, swR, wfR, memR, appR] = await Promise.all([
        fetch(`${apiUrl}/api/v1/provider-connections?workspaceId=${ws.id}`, { headers }),
        fetch(`${apiUrl}/api/v1/agents?workspaceId=${ws.id}`, { headers }),
        fetch(`${apiUrl}/api/v1/devices?workspaceId=${ws.id}`, { headers }),
        fetch(`${apiUrl}/api/v1/threads?workspaceId=${ws.id}`, { headers }),
        fetch(`${apiUrl}/api/v1/swarms?workspaceId=${ws.id}`, { headers }),
        fetch(`${apiUrl}/api/v1/workflows?workspaceId=${ws.id}`, { headers }),
        fetch(`${apiUrl}/api/v1/memories?workspaceId=${ws.id}`, { headers }),
        fetch(`${apiUrl}/api/v1/approvals?workspaceId=${ws.id}`, { headers }),
      ]);

      const prov = provR.ok ? (await provR.json()).data || [] : [];
      const ag = agR.ok ? (await agR.json()).data || [] : [];
      const dev = devR.ok ? (await devR.json()).data || [] : [];
      const th = thR.ok ? (await thR.json()).data || [] : [];
      const sw = swR.ok ? (await swR.json()).data || [] : [];
      const wf = wfR.ok ? (await wfR.json()).data || [] : [];
      const mem = memR.ok ? (await memR.json()).data || [] : [];
      const app = appR.ok ? (await appR.json()).data || [] : [];

      setStats({
        providersCount: prov.length,
        agentsCount: ag.length,
        devicesCount: dev.length,
        onlineDevicesCount: dev.filter((d: { isOnline?: boolean }) => d.isOnline).length,
        threadsCount: th.length,
        swarmsCount: sw.length,
        workflowsCount: wf.length,
        memoriesCount: mem.length,
        pendingApprovalsCount: app.length,
      });
    } catch {
      // Unauthenticated or transient failure
    }
  }, [apiUrl, activeWorkspace]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const onboardingSteps = [
    { label: "Sign in & verify identity", done: true, href: "/settings/notifications" },
    { label: "Workspace active", done: Boolean(activeWorkspace), href: "/" },
    { label: "Connect AI Provider", done: stats.providersCount > 0, href: "/settings/integrations" },
    { label: "Configure Agent Roster", done: stats.agentsCount > 0, href: "/agents" },
    { label: "Start Conversation", done: stats.threadsCount > 0, href: "/chat" },
    { label: "Pair Local Workstation", done: stats.devicesCount > 0, href: "/settings/devices" },
    { label: "Launch Multi-Agent Swarm", done: stats.swarmsCount > 0, href: "/swarms" },
    { label: "Create Automated Workflow", done: stats.workflowsCount > 0, href: "/workflows" },
    { label: "Store Long-Term Memory", done: stats.memoriesCount > 0, href: "/memory" },
    { label: "Review Approvals Queue", done: stats.pendingApprovalsCount === 0, href: "/approvals" },
  ];

  const completedSteps = onboardingSteps.filter((s) => s.done).length;

  return (
    <div className="flex h-screen flex-col bg-[#090A0F] text-[#F0F4FC]">
      <Header
        onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
        onWorkspaceChange={(ws) => setActiveWorkspace(ws)}
      />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          activeTab={activeTab}
          onSelectTab={setActiveTab}
        />

        <main className="flex-1 overflow-y-auto p-4 md:p-8">
          <div className="mx-auto max-w-7xl space-y-6">
            {/* Command Center Header */}
            <div className="flex flex-col justify-between gap-4 border-b border-[#1E2536] pb-6 sm:flex-row sm:items-center">
              <div>
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <h1 className="text-xl md:text-2xl font-bold tracking-tight text-[#F0F4FC]">
                    AI Command Center
                  </h1>
                  <Badge variant="cyan">MESSIAH v{healthData?.version || "1.0.0"}</Badge>
                  {activeWorkspace && (
                    <Badge variant="outline">{activeWorkspace.name}</Badge>
                  )}
                </div>
                <p className="text-xs text-[#94A3B8]">
                  One intelligence layer. Every agent. Every device.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Link href="/chat">
                  <Button variant="cyan" size="sm" className="font-mono text-xs font-semibold bg-[#00FFA3] text-black hover:bg-[#00FFA3]/90">
                    <MessageSquare className="h-3.5 w-3.5 mr-1.5" />
                    Launch Chat
                  </Button>
                </Link>
                <Link href="/approvals">
                  <Button
                    variant="outline"
                    size="sm"
                    className={`font-mono text-xs ${
                      stats.pendingApprovalsCount > 0
                        ? "border-amber-500/50 text-amber-300 bg-amber-500/10"
                        : ""
                    }`}
                  >
                    <ShieldAlert className="h-3.5 w-3.5 mr-1.5" />
                    Approvals ({stats.pendingApprovalsCount})
                  </Button>
                </Link>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={fetchAll}
                  isLoading={isLoadingHealth}
                  className="font-mono text-xs"
                >
                  <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                  Refresh
                </Button>
              </div>
            </div>

            {/* Pending Approvals Alert Banner */}
            {stats.pendingApprovalsCount > 0 && (
              <Link
                href="/approvals"
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 hover:bg-amber-500/15 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <ShieldAlert className="h-5 w-5 text-amber-400 shrink-0" />
                  <div>
                    <div className="text-sm font-semibold text-amber-200">
                      {stats.pendingApprovalsCount} Human-in-the-Loop Approval{stats.pendingApprovalsCount === 1 ? "" : "s"} Pending
                    </div>
                    <p className="text-xs text-amber-300/80">
                      Paused MCP tool calls, Local Bridge commands, Swarm plans, or Workflow gates await explicit verification.
                    </p>
                  </div>
                </div>
                <span className="inline-flex items-center gap-1 font-mono text-xs font-semibold text-amber-200">
                  Review Now <ArrowRight className="h-3.5 w-3.5" />
                </span>
              </Link>
            )}

            {/* Platform Infrastructure Probes */}
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-xs font-mono uppercase tracking-wider text-[#64748B]">
                  Live Infrastructure Probes
                </h2>
                <span className="text-[11px] font-mono text-[#94A3B8]">
                  PostgreSQL 16 + pgvector · Redis 7.2 · Fastify 5 · BullMQ
                </span>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Card className="hover:border-[#00F0FF]/30 transition-all">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-xs font-semibold text-[#F0F4FC]">
                        <Server className="h-4 w-4 text-[#00F0FF]" />
                        <span>API & Realtime Gateway</span>
                      </div>
                      <StatusDot
                        status={healthData ? "online" : healthError ? "error" : "busy"}
                        pulse
                      />
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-1 text-xs font-mono">
                      <div className="flex justify-between">
                        <span className="text-[#64748B]">Release:</span>
                        <span className="text-[#94A3B8]">v{healthData?.version || "1.0.0"}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#64748B]">State:</span>
                        <span className={healthData ? "text-[#00FFA3]" : "text-[#FF3366]"}>
                          {healthData ? "Healthy" : healthError ? "Unreachable" : "Probing..."}
                        </span>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card className="hover:border-[#00FFA3]/30 transition-all">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-xs font-semibold text-[#F0F4FC]">
                        <Database className="h-4 w-4 text-[#00FFA3]" />
                        <span>PostgreSQL + pgvector</span>
                      </div>
                      <StatusDot
                        status={
                          healthData?.checks?.database?.status === "healthy"
                            ? "online"
                            : "offline"
                        }
                        pulse={healthData?.checks?.database?.status === "healthy"}
                      />
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-1 text-xs font-mono">
                      <div className="flex justify-between">
                        <span className="text-[#64748B]">Memories:</span>
                        <span className="text-[#94A3B8]">{stats.memoriesCount} stored</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#64748B]">Latency:</span>
                        <span className="text-[#00FFA3]">
                          {healthData?.checks?.database?.latencyMs !== undefined
                            ? `${healthData.checks.database.latencyMs} ms`
                            : "N/A"}
                        </span>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card className="hover:border-[#FFB800]/30 transition-all">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-xs font-semibold text-[#F0F4FC]">
                        <Cpu className="h-4 w-4 text-[#FFB800]" />
                        <span>Redis & BullMQ</span>
                      </div>
                      <StatusDot
                        status={
                          healthData?.checks?.redis?.status === "healthy" ? "online" : "offline"
                        }
                        pulse={healthData?.checks?.redis?.status === "healthy"}
                      />
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-1 text-xs font-mono">
                      <div className="flex justify-between">
                        <span className="text-[#64748B]">Role:</span>
                        <span className="text-[#94A3B8]">Queues & Pub/Sub</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[#64748B]">Latency:</span>
                        <span className="text-[#00FFA3]">
                          {healthData?.checks?.redis?.latencyMs !== undefined
                            ? `${healthData.checks.redis.latencyMs} ms`
                            : "N/A"}
                        </span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>

            {/* Active Workspace Capabilities Grid */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Link href="/settings/integrations" className="block group">
                <Card className="h-full group-hover:border-[#00F0FF]/40 transition-colors">
                  <CardHeader>
                    <CardTitle className="text-sm font-semibold flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        <Key className="h-4 w-4 text-[#00F0FF]" />
                        AI Providers
                      </span>
                      <span className="font-mono text-xs text-[#00F0FF]">{stats.providersCount}</span>
                    </CardTitle>
                    <CardDescription>OpenAI, Anthropic & Google Gemini encrypted vault</CardDescription>
                  </CardHeader>
                </Card>
              </Link>

              <Link href="/agents" className="block group">
                <Card className="h-full group-hover:border-[#00FFA3]/40 transition-colors">
                  <CardHeader>
                    <CardTitle className="text-sm font-semibold flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        <Bot className="h-4 w-4 text-[#00FFA3]" />
                        Agent Fleet & Swarms
                      </span>
                      <span className="font-mono text-xs text-[#00FFA3]">
                        {stats.agentsCount} agents · {stats.swarmsCount} runs
                      </span>
                    </CardTitle>
                    <CardDescription>Versioned personas, 3D Constellation & 2D topology</CardDescription>
                  </CardHeader>
                </Card>
              </Link>

              <Link href="/settings/devices" className="block group">
                <Card className="h-full group-hover:border-[#38BDF8]/40 transition-colors">
                  <CardHeader>
                    <CardTitle className="text-sm font-semibold flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        <Laptop2 className="h-4 w-4 text-[#38BDF8]" />
                        Local Agent Bridges
                      </span>
                      <span className="font-mono text-xs text-[#38BDF8]">
                        {stats.onlineDevicesCount}/{stats.devicesCount} online
                      </span>
                    </CardTitle>
                    <CardDescription>Ed25519 workstations with OS sandbox containment</CardDescription>
                  </CardHeader>
                </Card>
              </Link>

              <Link href="/workflows" className="block group">
                <Card className="h-full group-hover:border-amber-400/40 transition-colors">
                  <CardHeader>
                    <CardTitle className="text-sm font-semibold flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        <Workflow className="h-4 w-4 text-amber-400" />
                        Workflow Automation
                      </span>
                      <span className="font-mono text-xs text-amber-300">{stats.workflowsCount} flows</span>
                    </CardTitle>
                    <CardDescription>Visual DAG studio, cron triggers & event routing</CardDescription>
                  </CardHeader>
                </Card>
              </Link>

              <Link href="/memory" className="block group">
                <Card className="h-full group-hover:border-[#00FFA3]/40 transition-colors">
                  <CardHeader>
                    <CardTitle className="text-sm font-semibold flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        <Database className="h-4 w-4 text-[#00FFA3]" />
                        Vector Memory (pgvector)
                      </span>
                      <span className="font-mono text-xs text-[#00FFA3]">{stats.memoriesCount} items</span>
                    </CardTitle>
                    <CardDescription>Scoped Personal, Workspace & Agent semantic recall</CardDescription>
                  </CardHeader>
                </Card>
              </Link>

              <Link href="/swarms" className="block group">
                <Card className="h-full group-hover:border-indigo-400/40 transition-colors">
                  <CardHeader>
                    <CardTitle className="text-sm font-semibold flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        <GitFork className="h-4 w-4 text-indigo-400" />
                        Multi-Agent Constellations
                      </span>
                      <span className="font-mono text-xs text-indigo-300">{stats.threadsCount} threads</span>
                    </CardTitle>
                    <CardDescription>Live Supervisor-Worker orchestration across devices</CardDescription>
                  </CardHeader>
                </Card>
              </Link>
            </div>

            {/* First-Run Onboarding Checklist */}
            <Card className="border-[#1E2536] bg-[#0E111A]/80">
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <CardTitle className="text-sm font-semibold flex items-center gap-2">
                      <Sparkles className="h-4 w-4 text-[#00F0FF]" />
                      Workspace Readiness & First-Run Journey
                    </CardTitle>
                    <CardDescription>
                      Complete these verified steps to unlock every MESSIAH capability across web, desktop, and mobile.
                    </CardDescription>
                  </div>
                  <Badge variant="cyan">
                    {completedSteps} / {onboardingSteps.length} Complete
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
                  {onboardingSteps.map((step, idx) => (
                    <Link
                      key={step.label}
                      href={step.href}
                      className={`flex items-start gap-2.5 rounded-lg border p-3 text-xs transition-colors ${
                        step.done
                          ? "border-[#00FFA3]/25 bg-[#00FFA3]/5 text-[#F0F4FC]"
                          : "border-[#1E2536] bg-[#12151E] text-[#94A3B8] hover:border-[#00F0FF]/40"
                      }`}
                    >
                      {step.done ? (
                        <CheckCircle2 className="h-4 w-4 text-[#00FFA3] shrink-0 mt-0.5" />
                      ) : (
                        <Circle className="h-4 w-4 text-[#64748B] shrink-0 mt-0.5" />
                      )}
                      <div>
                        <div className="font-mono text-[10px] text-[#64748B]">Step {idx + 1}</div>
                        <div className="font-medium leading-snug">{step.label}</div>
                      </div>
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        </main>
      </div>
    </div>
  );
}
