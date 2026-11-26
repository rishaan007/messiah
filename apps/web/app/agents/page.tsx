"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Bot,
  Plus,
  Sparkles,
  Copy,
  Archive,
  Play,
  Edit3,
  Cpu,
  Laptop2,
  Crown,
  X,
  RefreshCw,
} from "lucide-react";
import { Button, Badge, Card, CardContent } from "@messiah/ui";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { createClient } from "@/lib/supabase/client";
import {
  BRIDGE_CAPABILITIES,
  type AgentDefinitionInfo,
  type BridgeDeviceInfo,
  type McpToolDefinitionInfo,
  type ModelInfo,
  type ProviderConnectionInfo,
  type WorkspaceInfo,
} from "@messiah/shared";

const ALL_BRIDGE_CAPS = Object.values(BRIDGE_CAPABILITIES);

export default function AgentsRegistryPage() {
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [authToken, setAuthToken] = useState<string | null>(null);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceInfo | null>(null);

  const [agents, setAgents] = useState<AgentDefinitionInfo[]>([]);
  const [connections, setConnections] = useState<ProviderConnectionInfo[]>([]);
  const [modelsByConn, setModelsByConn] = useState<Record<string, ModelInfo[]>>({});
  const [mcpTools, setMcpTools] = useState<McpToolDefinitionInfo[]>([]);
  const [devices, setDevices] = useState<BridgeDeviceInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Create Modal
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [roleTitle, setRoleTitle] = useState("");
  const [category, setCategory] = useState("custom");
  const [description, setDescription] = useState("");
  const [canSupervise, setCanSupervise] = useState(false);
  const [providerConnectionId, setProviderConnectionId] = useState("");
  const [modelId, setModelId] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [selectedMcpToolIds, setSelectedMcpToolIds] = useState<string[]>([]);
  const [selectedBridgeCaps, setSelectedBridgeCaps] = useState<string[]>([]);
  const [preferredDeviceId, setPreferredDeviceId] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Test Modal
  const [testingAgent, setTestingAgent] = useState<AgentDefinitionInfo | null>(null);
  const [testPrompt, setTestPrompt] = useState("Summarize your specialization and approach concisely.");
  const [testResult, setTestResult] = useState<{ output: string; durationMs: number; modelId: string } | null>(null);
  const [isTesting, setIsTesting] = useState(false);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
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
      setActiveWorkspace(ws);

      const [agRes, connRes, toolRes, devRes] = await Promise.all([
        fetch(`${apiUrl}/api/v1/agents?workspaceId=${ws.id}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        }),
        fetch(`${apiUrl}/api/v1/provider-connections?workspaceId=${ws.id}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        }),
        fetch(`${apiUrl}/api/v1/mcp/tools?workspaceId=${ws.id}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        }),
        fetch(`${apiUrl}/api/v1/devices?workspaceId=${ws.id}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        }),
      ]);

      if (agRes.ok) setAgents((await agRes.json()).data || []);
      if (connRes.ok) {
        const cList: ProviderConnectionInfo[] = (await connRes.json()).data || [];
        setConnections(cList);
        if (cList[0] && !providerConnectionId) {
          setProviderConnectionId(cList[0].id);
        }
      }
      if (toolRes.ok) setMcpTools((await toolRes.json()).data || []);
      if (devRes.ok) setDevices((await devRes.json()).data || []);
    } catch (err) {
      console.error("Failed loading Agent Registry:", err);
    } finally {
      setIsLoading(false);
    }
  }, [apiUrl, router, providerConnectionId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Load models when connection changes
  useEffect(() => {
    if (!authToken || !activeWorkspace || !providerConnectionId) return;
    const conn = connections.find((c) => c.id === providerConnectionId);
    if (!conn || modelsByConn[conn.id]) return;

    fetch(`${apiUrl}/api/v1/providers/${conn.provider}/models?workspaceId=${activeWorkspace.id}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (body?.data) {
          const list: ModelInfo[] = body.data;
          setModelsByConn((prev) => ({ ...prev, [conn.id]: list }));
          if (list[0] && !modelId) setModelId(list[0].id);
        }
      })
      .catch(() => {});
  }, [authToken, activeWorkspace, providerConnectionId, connections, modelsByConn, apiUrl, modelId]);

  const handleSeedTemplates = async () => {
    if (!authToken || !activeWorkspace) return;
    setErrorMsg(null);
    const res = await fetch(`${apiUrl}/api/v1/agents/templates/seed`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workspaceId: activeWorkspace.id }),
    });
    if (res.ok) {
      await loadData();
    } else {
      const b = await res.json();
      setErrorMsg(b.error?.message || "Failed to seed agent templates.");
    }
  };

  const handleCreateAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authToken || !activeWorkspace) return;
    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      const res = await fetch(`${apiUrl}/api/v1/agents`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workspaceId: activeWorkspace.id,
          name,
          roleTitle,
          category,
          description: description || null,
          canSupervise,
          providerConnectionId: providerConnectionId || null,
          modelId: modelId || null,
          systemPrompt,
          allowedMcpToolIds: selectedMcpToolIds,
          allowedBridgeCapabilities: selectedBridgeCaps,
          preferredBridgeDeviceId: preferredDeviceId || null,
        }),
      });
      const b = await res.json();
      if (!res.ok) {
        setErrorMsg(b.error?.message || "Failed to create agent.");
        return;
      }
      setIsCreateOpen(false);
      setName("");
      setRoleTitle("");
      setSystemPrompt("");
      await loadData();
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDuplicate = async (agentId: string) => {
    if (!authToken || !activeWorkspace) return;
    await fetch(`${apiUrl}/api/v1/agents/${agentId}/duplicate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workspaceId: activeWorkspace.id }),
    });
    await loadData();
  };

  const handleArchive = async (agentId: string) => {
    if (!authToken || !activeWorkspace) return;
    await fetch(`${apiUrl}/api/v1/agents/${agentId}?workspaceId=${activeWorkspace.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    await loadData();
  };

  const handleRunTestPrompt = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authToken || !activeWorkspace || !testingAgent) return;
    setIsTesting(true);
    setTestResult(null);
    setErrorMsg(null);
    try {
      const res = await fetch(`${apiUrl}/api/v1/agents/${testingAgent.id}/test`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ workspaceId: activeWorkspace.id, prompt: testPrompt }),
      });
      const b = await res.json();
      if (!res.ok) {
        setErrorMsg(b.error?.message || "Test execution failed.");
      } else {
        setTestResult(b.data);
      }
    } finally {
      setIsTesting(false);
    }
  };

  const currentModels = providerConnectionId ? modelsByConn[providerConnectionId] || [] : [];

  return (
    <div className="flex h-screen flex-col bg-[#090A0F] text-[#F0F4FC]">
      <Header onToggleSidebar={() => setSidebarOpen((p) => !p)} />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} activeTab="agents" onSelectTab={() => {}} />

        <main className="flex-1 overflow-y-auto p-4 md:p-8 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold text-[#F0F4FC]">Agent Registry</h1>
              <p className="text-xs text-[#94A3B8] mt-1">
                Configure specialized personas, system prompts, MCP tools, and Local Bridge authorizations.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={handleSeedTemplates}
                className="h-9 text-xs border-[#1E2536]"
              >
                <Sparkles className="w-3.5 h-3.5 mr-1.5 text-[#00FFA3]" />
                Seed Templates
              </Button>
              <Button
                type="button"
                onClick={() => setIsCreateOpen(true)}
                className="h-9 text-xs bg-[#00FFA3] text-black hover:bg-[#00FFA3]/90 font-semibold"
              >
                <Plus className="w-3.5 h-3.5 mr-1.5" />
                Create Agent
              </Button>
            </div>
          </div>

          {errorMsg && (
            <div className="rounded-lg border border-red-500/30 bg-red-950/20 px-4 py-2.5 text-xs text-red-300">
              {errorMsg}
            </div>
          )}

          {isLoading ? (
            <div className="py-12 text-center text-xs text-[#64748B]">Loading agents...</div>
          ) : agents.length === 0 ? (
            <Card className="border-[#1E2536] bg-[#0E121B]">
              <CardContent className="p-10 text-center space-y-3">
                <Bot className="w-10 h-10 text-[#00FFA3] mx-auto" />
                <h2 className="text-sm font-semibold">No Agents Configured Yet</h2>
                <p className="text-xs text-[#94A3B8] max-w-md mx-auto">
                  Seed Messiah&apos;s starter swarm roster (Supervisor, Research, Developer, Code Reviewer, Analyst, Assistant) or create a custom specialized agent.
                </p>
                <Button onClick={handleSeedTemplates} className="bg-[#00FFA3] text-black text-xs font-semibold">
                  Seed Starter Agent Roster
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {agents.map((agent) => (
                <Card key={agent.id} className="border-[#1E2536] bg-[#0E121B] flex flex-col">
                  <CardContent className="p-5 flex-1 flex flex-col space-y-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className="w-9 h-9 rounded-lg border flex items-center justify-center shrink-0"
                          style={{
                            borderColor: `${agent.avatarAccent || "#00FFA3"}50`,
                            backgroundColor: `${agent.avatarAccent || "#00FFA3"}15`,
                          }}
                        >
                          {agent.canSupervise ? (
                            <Crown className="w-4 h-4" style={{ color: agent.avatarAccent || "#00FFA3" }} />
                          ) : (
                            <Bot className="w-4 h-4" style={{ color: agent.avatarAccent || "#38BDF8" }} />
                          )}
                        </div>
                        <div className="min-w-0">
                          <Link
                            href={`/agents/${agent.id}`}
                            className="text-sm font-semibold text-[#F0F4FC] hover:text-[#00FFA3] truncate block"
                          >
                            {agent.name}
                          </Link>
                          <div className="text-xs text-[#64748B] truncate">{agent.roleTitle}</div>
                        </div>
                      </div>
                      <Badge variant="outline" className="font-mono text-[10px] border-[#1E2536]">
                        v{agent.activeVersion}
                      </Badge>
                    </div>

                    <p className="text-xs text-[#94A3B8] line-clamp-2 flex-1">
                      {agent.description || agent.systemPrompt}
                    </p>

                    <div className="flex flex-wrap gap-1.5 text-[10px] font-mono">
                      {agent.canSupervise && (
                        <Badge variant="outline" className="border-[#00FFA3]/30 text-[#00FFA3]">
                          SUPERVISOR
                        </Badge>
                      )}
                      <Badge variant="outline" className="border-[#1E2536] text-[#CBD5E1]">
                        {agent.modelId || "No Model"}
                      </Badge>
                      <Badge variant="outline" className="border-[#1E2536] text-[#8B949E]">
                        <Cpu className="w-3 h-3 mr-1" />
                        {agent.allowedMcpToolIds.length} MCP
                      </Badge>
                      {agent.allowedBridgeCapabilities.length > 0 && (
                        <Badge variant="outline" className="border-indigo-500/30 text-indigo-300">
                          <Laptop2 className="w-3 h-3 mr-1" />
                          {agent.allowedBridgeCapabilities.length} Bridge
                        </Badge>
                      )}
                    </div>

                    <div className="flex items-center justify-between pt-3 border-t border-[#1E2536]">
                      <div className="flex items-center gap-1.5">
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => {
                            setTestingAgent(agent);
                            setTestResult(null);
                          }}
                          className="h-7 px-2 text-xs text-[#00FFA3]"
                        >
                          <Play className="w-3 h-3 mr-1" />
                          Test
                        </Button>
                        <Link
                          href={`/agents/${agent.id}`}
                          className="inline-flex items-center h-7 px-2 text-xs text-[#94A3B8] hover:text-[#F0F4FC]"
                        >
                          <Edit3 className="w-3 h-3 mr-1" />
                          Configure
                        </Link>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => handleDuplicate(agent.id)}
                          className="h-7 w-7 p-0 text-[#64748B] hover:text-[#F0F4FC]"
                          title="Duplicate agent"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => handleArchive(agent.id)}
                          className="h-7 w-7 p-0 text-[#64748B] hover:text-red-400"
                          title="Archive agent"
                        >
                          <Archive className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </main>
      </div>

      {/* Create Agent Modal */}
      {isCreateOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 overflow-y-auto">
          <div className="w-full max-w-2xl rounded-xl border border-[#1E2536] bg-[#0E121B] p-6 space-y-4 my-8">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Create Specialized Agent</h2>
              <button onClick={() => setIsCreateOpen(false)} className="text-[#64748B] hover:text-[#F0F4FC]">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateAgent} className="space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[#94A3B8] mb-1">Agent Name</label>
                  <input
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g., Database Architect"
                    className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block text-[#94A3B8] mb-1">Role Title</label>
                  <input
                    required
                    value={roleTitle}
                    onChange={(e) => setRoleTitle(e.target.value)}
                    placeholder="e.g., Schema & Query Engineer"
                    className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-[#94A3B8] mb-1">Category</label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2"
                  >
                    <option value="custom">Custom</option>
                    <option value="supervisor">Supervisor</option>
                    <option value="research">Research</option>
                    <option value="developer">Developer</option>
                    <option value="reviewer">Code Reviewer</option>
                    <option value="analyst">Analyst</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[#94A3B8] mb-1">Provider Connection</label>
                  <select
                    value={providerConnectionId}
                    onChange={(e) => {
                      setProviderConnectionId(e.target.value);
                      setModelId("");
                    }}
                    className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2"
                  >
                    <option value="">None</option>
                    {connections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.displayName} ({c.provider})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[#94A3B8] mb-1">Model ID</label>
                  <select
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                    className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2"
                  >
                    <option value="">Select model...</option>
                    {currentModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name || m.id}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[#94A3B8] mb-1">Description (Optional)</label>
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Short summary shown on Registry cards..."
                  className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2"
                />
              </div>

              <div>
                <label className="block text-[#94A3B8] mb-1">System Prompt / Behavioral Contract</label>
                <textarea
                  required
                  rows={4}
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder="Describe exact responsibilities, tool usage guidelines, and accuracy rules..."
                  className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2"
                />
              </div>

              <div className="flex items-center justify-between gap-4">
                <label className="flex items-center gap-2 cursor-pointer text-[#CBD5E1]">
                  <input
                    type="checkbox"
                    checked={canSupervise}
                    onChange={(e) => setCanSupervise(e.target.checked)}
                    className="accent-[#00FFA3]"
                  />
                  Allow as Swarm Supervisor (DAG planning & synthesis)
                </label>

                <select
                  value={preferredDeviceId}
                  onChange={(e) => setPreferredDeviceId(e.target.value)}
                  className="rounded-lg border border-[#1E2536] bg-[#090A0F] px-2.5 py-1.5"
                >
                  <option value="">No Preferred Bridge Device</option>
                  {devices.map((d) => (
                    <option key={d.id} value={d.id}>
                      Device: {d.displayName}
                    </option>
                  ))}
                </select>
              </div>

              {mcpTools.length > 0 && (
                <div>
                  <label className="block text-[#94A3B8] mb-1">Allowed MCP Tools</label>
                  <div className="max-h-28 overflow-y-auto grid grid-cols-2 gap-1.5 rounded-lg border border-[#1E2536] bg-[#090A0F] p-2">
                    {mcpTools.map((t) => (
                      <label key={t.id} className="flex items-center gap-1.5 truncate cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedMcpToolIds.includes(t.id)}
                          onChange={() =>
                            setSelectedMcpToolIds((prev) =>
                              prev.includes(t.id) ? prev.filter((x) => x !== t.id) : [...prev, t.id]
                            )
                          }
                          className="accent-[#00FFA3]"
                        />
                        <span className="truncate font-mono text-[11px]">{t.namespacedName}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <label className="block text-[#94A3B8] mb-1">Allowed Bridge Capabilities</label>
                <div className="max-h-28 overflow-y-auto grid grid-cols-3 gap-1.5 rounded-lg border border-[#1E2536] bg-[#090A0F] p-2">
                  {ALL_BRIDGE_CAPS.map((cap) => (
                    <label key={cap} className="flex items-center gap-1.5 truncate cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedBridgeCaps.includes(cap)}
                        onChange={() =>
                          setSelectedBridgeCaps((prev) =>
                            prev.includes(cap) ? prev.filter((x) => x !== cap) : [...prev, cap]
                          )
                        }
                        className="accent-[#00FFA3]"
                      />
                      <span className="truncate font-mono text-[11px]">{cap}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" onClick={() => setIsCreateOpen(false)} className="border-[#1E2536]">
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting} className="bg-[#00FFA3] text-black font-semibold">
                  {isSubmitting ? "Creating..." : "Create Agent"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Test Prompt Modal */}
      {testingAgent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-lg rounded-xl border border-[#1E2536] bg-[#0E121B] p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Test Agent: {testingAgent.name}</h3>
              <button onClick={() => setTestingAgent(null)} className="text-[#64748B]">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleRunTestPrompt} className="space-y-3 text-xs">
              <textarea
                rows={3}
                value={testPrompt}
                onChange={(e) => setTestPrompt(e.target.value)}
                className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] p-3"
              />
              <Button type="submit" disabled={isTesting} className="bg-[#00FFA3] text-black font-semibold">
                {isTesting ? <RefreshCw className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Play className="w-3.5 h-3.5 mr-1" />}
                Execute Safe Preview
              </Button>
            </form>

            {testResult && (
              <div className="rounded-lg border border-[#1E2536] bg-[#090A0F] p-3 space-y-2 text-xs">
                <div className="font-mono text-[10px] text-[#00FFA3]">
                  Model: {testResult.modelId} • {testResult.durationMs}ms
                </div>
                <div className="text-[#CBD5E1] whitespace-pre-wrap max-h-60 overflow-y-auto">
                  {testResult.output}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
