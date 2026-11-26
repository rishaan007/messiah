"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  GitFork,
  Plus,
  Sparkles,
  Play,
  Pause,
  Clock,
  Zap,
  ExternalLink,
  Trash2,
  X,
  Activity,
} from "lucide-react";
import { Button, Badge, Card, CardContent } from "@messiah/ui";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { createClient } from "@/lib/supabase/client";
import {
  STARTER_WORKFLOW_TEMPLATES,
  type WorkflowDefinitionInfo,
  type WorkflowRunInfo,
  type WorkspaceInfo,
} from "@messiah/shared";

export default function WorkflowsPage() {
  const router = useRouter();
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);

  const [workflows, setWorkflows] = useState<WorkflowDefinitionInfo[]>([]);
  const [runs, setRuns] = useState<WorkflowRunInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newCategory, setNewCategory] = useState("automation");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) {
        router.push("/login");
        return;
      }
      setAuthToken(session.access_token);

      const wsRes = await fetch(`${apiUrl}/api/v1/workspaces`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!wsRes.ok) return;
      const wsList: WorkspaceInfo[] = (await wsRes.json()).data || [];
      const ws = wsList[0];
      if (!ws) return;
      setWorkspace(ws);

      const [wfRes, runRes] = await Promise.all([
        fetch(`${apiUrl}/api/v1/workflows?workspaceId=${ws.id}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        }),
        fetch(`${apiUrl}/api/v1/workflows/runs?workspaceId=${ws.id}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        }),
      ]);
      if (wfRes.ok) setWorkflows((await wfRes.json()).data || []);
      if (runRes.ok) setRuns((await runRes.json()).data || []);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to load workflows.");
    } finally {
      setIsLoading(false);
    }
  }, [apiUrl, router]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSeedTemplates = async () => {
    if (!authToken || !workspace) return;
    const res = await fetch(`${apiUrl}/api/v1/workflows/templates/seed`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ workspaceId: workspace.id }),
    });
    if (res.ok) {
      await loadData();
    }
  };

  const handleCreateBlank = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authToken || !workspace) return;
    setIsSubmitting(true);
    setErrorMsg(null);
    try {
      const res = await fetch(`${apiUrl}/api/v1/workflows`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          workspaceId: workspace.id,
          name: newName,
          description: newDesc || null,
          category: newCategory,
          draftGraph: {
            nodes: [
              {
                id: "trigger_manual",
                type: "manual_trigger",
                title: "Manual Trigger",
                position: { x: 80, y: 180 },
                config: { defaultPayload: {} },
              },
              {
                id: "step_agent",
                type: "run_agent",
                title: "Analyze Request",
                position: { x: 380, y: 180 },
                config: {
                  promptTemplate: "Analyze input: {{trigger.payload}}",
                  useMemoryRetrieval: true,
                },
              },
              {
                id: "complete_end",
                type: "completion",
                title: "Finish Workflow",
                position: { x: 700, y: 180 },
                config: {
                  summaryTemplate: "{{steps.step_agent.output.summary}}",
                },
              },
            ],
            edges: [
              { id: "e1", source: "trigger_manual", target: "step_agent" },
              { id: "e2", source: "step_agent", target: "complete_end" },
            ],
          },
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErrorMsg(json.error?.message || "Failed to create workflow.");
        return;
      }
      setIsCreateOpen(false);
      router.push(`/workflows/${json.data.id}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRunNow = async (workflowId: string) => {
    if (!authToken || !workspace) return;
    const res = await fetch(`${apiUrl}/api/v1/workflows/${workflowId}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ workspaceId: workspace.id, triggerPayload: {} }),
    });
    const json = await res.json();
    if (!res.ok) {
      setErrorMsg(json.error?.message || "Failed to trigger workflow.");
      return;
    }
    router.push(`/workflows/runs/${json.data.id}`);
  };

  const handleToggleSchedule = async (wf: WorkflowDefinitionInfo) => {
    if (!authToken || !workspace || !wf.schedule) return;
    await fetch(`${apiUrl}/api/v1/workflows/${wf.id}/schedule/toggle`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ workspaceId: workspace.id, enabled: !wf.schedule.enabled }),
    });
    await loadData();
  };

  const handleDeleteWorkflow = async (workflowId: string) => {
    if (!authToken || !workspace) return;
    const res = await fetch(`${apiUrl}/api/v1/workflows/${workflowId}?workspaceId=${workspace.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (res.ok) await loadData();
  };

  const activeCount = workflows.filter((w) => w.status === "ACTIVE").length;
  const scheduledCount = workflows.filter((w) => w.schedule?.enabled).length;

  return (
    <div className="flex h-screen overflow-hidden bg-[#090A0F] text-[#F0F4FC]">
      <Sidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        activeTab="workflows"
        onSelectTab={() => {}}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header onToggleSidebar={() => setSidebarOpen((p) => !p)} />
        <main className="flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto max-w-7xl space-y-6">
            {/* Page Header */}
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#1E2536] pb-5">
              <div>
                <div className="flex items-center gap-2.5">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#00FFA3]/30 bg-[#00FFA3]/10 text-[#00FFA3]">
                    <GitFork className="h-5 w-5" />
                  </div>
                  <h1 className="text-xl font-semibold tracking-tight">Workflow Automation Studio</h1>
                  <Badge variant="outline" className="border-[#00F0FF]/40 text-[#00F0FF]">
                    Durable DAG Engine
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-[#8E9BB4]">
                  Orchestrate AI agents, swarms, MCP tools, Local Bridges, human gates, and cron/event triggers.
                </p>
              </div>
              <div className="flex items-center gap-2.5">
                <Button
                  variant="outline"
                  onClick={handleSeedTemplates}
                  className="border-[#1E2536] bg-[#12151E] text-xs hover:border-[#00FFA3]/40"
                >
                  <Sparkles className="mr-1.5 h-3.5 w-3.5 text-[#00FFA3]" /> Seed Starter Templates
                </Button>
                <Button
                  onClick={() => setIsCreateOpen(true)}
                  className="bg-[#00F0FF] text-xs font-semibold text-[#090A0F]"
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" /> New Workflow
                </Button>
              </div>
            </div>

            {errorMsg && (
              <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-300">
                {errorMsg}
              </div>
            )}

            {/* KPI Row */}
            <div className="grid gap-4 sm:grid-cols-4">
              <Card className="border-[#1E2536] bg-[#12151E]">
                <CardContent className="p-4">
                  <div className="text-[11px] uppercase tracking-wider text-[#8E9BB4]">Workflows</div>
                  <div className="mt-1 text-2xl font-semibold">{workflows.length}</div>
                  <div className="mt-1 text-[11px] text-[#8E9BB4]">{activeCount} active</div>
                </CardContent>
              </Card>
              <Card className="border-[#1E2536] bg-[#12151E]">
                <CardContent className="p-4">
                  <div className="text-[11px] uppercase tracking-wider text-[#8E9BB4]">Scheduled Jobs</div>
                  <div className="mt-1 text-2xl font-semibold text-[#00F0FF]">{scheduledCount}</div>
                  <div className="mt-1 text-[11px] text-[#8E9BB4]">PostgreSQL cron persisted</div>
                </CardContent>
              </Card>
              <Card className="border-[#1E2536] bg-[#12151E]">
                <CardContent className="p-4">
                  <div className="text-[11px] uppercase tracking-wider text-[#8E9BB4]">Recent Executions</div>
                  <div className="mt-1 text-2xl font-semibold text-[#00FFA3]">{runs.length}</div>
                  <div className="mt-1 text-[11px] text-[#8E9BB4]">BullMQ + Outbox guaranteed</div>
                </CardContent>
              </Card>
              <Card className="border-[#1E2536] bg-[#12151E]">
                <CardContent className="p-4">
                  <div className="text-[11px] uppercase tracking-wider text-[#8E9BB4]">Starter Blueprints</div>
                  <div className="mt-1 text-2xl font-semibold">{STARTER_WORKFLOW_TEMPLATES.length}</div>
                  <div className="mt-1 text-[11px] text-[#8E9BB4]">Validated DAG templates</div>
                </CardContent>
              </Card>
            </div>

            {/* Workflow Definitions Grid */}
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-[#F0F4FC]">Workspace Workflows</h2>
              {isLoading ? (
                <Card className="border-[#1E2536] bg-[#12151E]">
                  <CardContent className="p-8 text-center text-xs text-[#8E9BB4]">
                    Loading workflows...
                  </CardContent>
                </Card>
              ) : workflows.length === 0 ? (
                <Card className="border-[#1E2536] bg-[#12151E]">
                  <CardContent className="p-8 text-center space-y-3">
                    <GitFork className="mx-auto h-8 w-8 text-[#00F0FF]/50" />
                    <p className="text-sm font-medium">No workflows configured yet</p>
                    <p className="text-xs text-[#8E9BB4]">
                      Deploy starter automation templates or create a blank visual DAG workflow.
                    </p>
                    <Button
                      onClick={handleSeedTemplates}
                      className="bg-[#00FFA3] text-xs font-semibold text-[#090A0F]"
                    >
                      Load Starter Workflows
                    </Button>
                  </CardContent>
                </Card>
              ) : (
                <div className="grid gap-4 md:grid-cols-2">
                  {workflows.map((wf) => (
                    <Card key={wf.id} className="border-[#1E2536] bg-[#12151E]">
                      <CardContent className="p-5 space-y-3">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="flex items-center gap-2">
                              <Link
                                href={`/workflows/${wf.id}`}
                                className="text-sm font-semibold hover:text-[#00F0FF]"
                              >
                                {wf.name}
                              </Link>
                              <Badge
                                variant="outline"
                                className={
                                  wf.status === "ACTIVE"
                                    ? "border-[#00FFA3]/40 text-[#00FFA3]"
                                    : "border-[#1E2536] text-[#8E9BB4]"
                                }
                              >
                                {wf.status}
                              </Badge>
                            </div>
                            <p className="mt-1 text-xs text-[#8E9BB4] line-clamp-2">
                              {wf.description || "Custom DAG workflow"}
                            </p>
                          </div>
                          <button
                            onClick={() => handleDeleteWorkflow(wf.id)}
                            className="rounded p-1 text-rose-400/70 hover:bg-rose-500/10 hover:text-rose-400"
                            title="Delete workflow"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#8E9BB4]">
                          <span className="rounded bg-[#090A0F] px-2 py-0.5">
                            {wf.draftGraph.nodes.length} nodes
                          </span>
                          <span className="rounded bg-[#090A0F] px-2 py-0.5">
                            v{wf.activeVersionNumber ?? "draft"}
                          </span>
                          {wf.schedule && (
                            <span className="inline-flex items-center gap-1 rounded bg-[#00F0FF]/10 px-2 py-0.5 text-[#00F0FF]">
                              <Clock className="h-3 w-3" /> {wf.schedule.cronExpression} (
                              {wf.schedule.enabled ? "active" : "paused"})
                            </span>
                          )}
                          {wf.eventTriggers &&
                            wf.eventTriggers.map((et) => (
                              <span
                                key={et.id}
                                className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-2 py-0.5 text-amber-300"
                              >
                                <Zap className="h-3 w-3" /> {et.eventType}
                              </span>
                            ))}
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#1E2536] pt-3">
                          <Link
                            href={`/workflows/${wf.id}`}
                            className="inline-flex items-center gap-1.5 text-xs font-medium text-[#00F0FF] hover:underline"
                          >
                            Open Visual Builder <ExternalLink className="h-3 w-3" />
                          </Link>
                          <div className="flex items-center gap-2">
                            {wf.schedule && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleToggleSchedule(wf)}
                                className="border-[#1E2536] text-xs"
                              >
                                {wf.schedule.enabled ? (
                                  <>
                                    <Pause className="mr-1 h-3 w-3" /> Pause Schedule
                                  </>
                                ) : (
                                  <>
                                    <Play className="mr-1 h-3 w-3" /> Enable Schedule
                                  </>
                                )}
                              </Button>
                            )}
                            <Button
                              size="sm"
                              onClick={() => handleRunNow(wf.id)}
                              className="bg-[#00FFA3] text-xs font-semibold text-[#090A0F]"
                            >
                              <Play className="mr-1 h-3 w-3" /> Run Now
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </div>

            {/* Recent Runs */}
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Activity className="h-4 w-4 text-[#00F0FF]" />
                <span>Execution History</span>
              </div>
              <Card className="border-[#1E2536] bg-[#12151E]">
                <CardContent className="p-0 overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-[#1E2536] text-[11px] uppercase text-[#8E9BB4]">
                      <tr>
                        <th className="px-4 py-3">Workflow</th>
                        <th className="px-4 py-3">Trigger</th>
                        <th className="px-4 py-3">Status</th>
                        <th className="px-4 py-3">Summary</th>
                        <th className="px-4 py-3">Started</th>
                        <th className="px-4 py-3">Inspect</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1E2536]">
                      {runs.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="px-4 py-6 text-center text-[#8E9BB4]">
                            No workflow executions recorded yet.
                          </td>
                        </tr>
                      ) : (
                        runs.map((r) => (
                          <tr key={r.id} className="hover:bg-[#191E2B]/40">
                            <td className="px-4 py-3 font-medium">{r.workflowName || r.workflowId}</td>
                            <td className="px-4 py-3 text-[#8E9BB4]">{r.triggerType}</td>
                            <td className="px-4 py-3">
                              <span
                                className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
                                  r.status === "COMPLETED"
                                    ? "bg-[#00FFA3]/15 text-[#00FFA3]"
                                    : r.status === "AWAITING_APPROVAL"
                                    ? "bg-amber-500/15 text-amber-300"
                                    : r.status === "FAILED"
                                    ? "bg-rose-500/15 text-rose-300"
                                    : "bg-[#00F0FF]/15 text-[#00F0FF]"
                                }`}
                              >
                                {r.status}
                              </span>
                            </td>
                            <td className="max-w-xs truncate px-4 py-3 text-[#8E9BB4]">
                              {r.finalSummary || "—"}
                            </td>
                            <td className="px-4 py-3 text-[#6E7B94]">
                              {new Date(r.createdAt).toLocaleString()}
                            </td>
                            <td className="px-4 py-3">
                              <Link
                                href={`/workflows/runs/${r.id}`}
                                className="text-[#00F0FF] hover:underline"
                              >
                                View Run →
                              </Link>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            </div>
          </div>
        </main>
      </div>

      {/* New Workflow Modal */}
      {isCreateOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-md rounded-xl border border-[#1E2536] bg-[#12151E] p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Create Visual Workflow</h2>
              <button onClick={() => setIsCreateOpen(false)}>
                <X className="h-4 w-4 text-[#8E9BB4]" />
              </button>
            </div>
            <form onSubmit={handleCreateBlank} className="space-y-3 text-xs">
              <div>
                <label className="mb-1 block text-[#8E9BB4]">Workflow Name</label>
                <input
                  required
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Nightly Security & Dependency Audit"
                  className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2"
                />
              </div>
              <div>
                <label className="mb-1 block text-[#8E9BB4]">Category</label>
                <input
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2"
                />
              </div>
              <div>
                <label className="mb-1 block text-[#8E9BB4]">Description</label>
                <textarea
                  rows={3}
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2"
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setIsCreateOpen(false)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={isSubmitting}
                  className="bg-[#00F0FF] font-semibold text-[#090A0F]"
                >
                  {isSubmitting ? "Creating..." : "Open in Builder"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
