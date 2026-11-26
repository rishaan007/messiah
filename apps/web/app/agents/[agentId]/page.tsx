"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Bot, Save, History } from "lucide-react";
import { Button, Badge, Card, CardContent } from "@messiah/ui";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { createClient } from "@/lib/supabase/client";
import type {
  AgentDefinitionInfo,
  ModelInfo,
  ProviderConnectionInfo,
  WorkspaceInfo,
} from "@messiah/shared";

export default function AgentDetailPage() {
  const params = useParams();
  const agentId = String(params?.agentId || "");
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [authToken, setAuthToken] = useState<string | null>(null);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceInfo | null>(null);
  const [agent, setAgent] = useState<AgentDefinitionInfo | null>(null);
  const [connections, setConnections] = useState<ProviderConnectionInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);

  const [name, setName] = useState("");
  const [roleTitle, setRoleTitle] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [providerConnectionId, setProviderConnectionId] = useState("");
  const [modelId, setModelId] = useState("");
  const [canSupervise, setCanSupervise] = useState(false);
  const [temperature, setTemperature] = useState(0.3);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

  const loadAgent = useCallback(async () => {
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
      const ws = (await wsRes.json()).data?.[0] as WorkspaceInfo | undefined;
      if (!ws) return;
      setActiveWorkspace(ws);

      const [agRes, connRes] = await Promise.all([
        fetch(`${apiUrl}/api/v1/agents/${agentId}?workspaceId=${ws.id}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        }),
        fetch(`${apiUrl}/api/v1/provider-connections?workspaceId=${ws.id}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        }),
      ]);

      if (connRes.ok) setConnections((await connRes.json()).data || []);
      if (agRes.ok) {
        const a: AgentDefinitionInfo = (await agRes.json()).data;
        setAgent(a);
        setName(a.name);
        setRoleTitle(a.roleTitle);
        setDescription(a.description || "");
        setSystemPrompt(a.systemPrompt);
        setProviderConnectionId(a.providerConnectionId || "");
        setModelId(a.modelId || "");
        setCanSupervise(a.canSupervise);
        setTemperature(a.temperature);
      }
    } catch (err) {
      console.error("Failed loading agent detail:", err);
    }
  }, [agentId, apiUrl, router]);

  useEffect(() => {
    if (agentId) loadAgent();
  }, [agentId, loadAgent]);

  useEffect(() => {
    if (!authToken || !activeWorkspace || !providerConnectionId) return;
    const conn = connections.find((c) => c.id === providerConnectionId);
    if (!conn) return;
    fetch(`${apiUrl}/api/v1/providers/${conn.provider}/models?workspaceId=${activeWorkspace.id}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (b?.data) setModels(b.data);
      })
      .catch(() => {});
  }, [authToken, activeWorkspace, providerConnectionId, connections, apiUrl]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authToken || !activeWorkspace || !agent) return;
    setIsSaving(true);
    setSaveMessage(null);
    try {
      const res = await fetch(`${apiUrl}/api/v1/agents/${agent.id}?workspaceId=${activeWorkspace.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name,
          roleTitle,
          description: description || null,
          systemPrompt,
          providerConnectionId: providerConnectionId || null,
          modelId: modelId || null,
          canSupervise,
          temperature,
        }),
      });
      if (res.ok) {
        const updated: AgentDefinitionInfo = (await res.json()).data;
        setAgent(updated);
        setSaveMessage(`Saved new immutable snapshot v${updated.activeVersion}.`);
      }
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex h-screen flex-col bg-[#090A0F] text-[#F0F4FC]">
      <Header onToggleSidebar={() => setSidebarOpen((p) => !p)} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} activeTab="agents" onSelectTab={() => {}} />

        <main className="flex-1 overflow-y-auto p-4 md:p-8 space-y-6 max-w-5xl">
          <Link href="/agents" className="inline-flex items-center gap-1.5 text-xs text-[#64748B] hover:text-[#F0F4FC]">
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to Agent Registry
          </Link>

          {!agent ? (
            <div className="text-xs text-[#64748B]">Loading agent configuration...</div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Bot className="w-6 h-6 text-[#00FFA3]" />
                  <div>
                    <h1 className="text-lg font-semibold">{agent.name}</h1>
                    <p className="text-xs text-[#64748B] font-mono">
                      Slug: {agent.slug} • Active Snapshot v{agent.activeVersion}
                    </p>
                  </div>
                </div>
                <Badge variant="outline" className="font-mono text-xs border-[#1E2536]">
                  {agent.status}
                </Badge>
              </div>

              {saveMessage && (
                <div className="rounded-lg border border-[#00FFA3]/30 bg-[#00FFA3]/10 px-4 py-2 text-xs text-[#00FFA3]">
                  {saveMessage}
                </div>
              )}

              <Card className="border-[#1E2536] bg-[#0E121B]">
                <CardContent className="p-5">
                  <form onSubmit={handleSave} className="space-y-4 text-xs">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-[#94A3B8] mb-1">Agent Name</label>
                        <input
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2"
                        />
                      </div>
                      <div>
                        <label className="block text-[#94A3B8] mb-1">Role Title</label>
                        <input
                          value={roleTitle}
                          onChange={(e) => setRoleTitle(e.target.value)}
                          className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div>
                        <label className="block text-[#94A3B8] mb-1">Provider Connection</label>
                        <select
                          value={providerConnectionId}
                          onChange={(e) => setProviderConnectionId(e.target.value)}
                          className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2"
                        >
                          <option value="">Unassigned</option>
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
                          <option value={modelId}>{modelId || "Select model..."}</option>
                          {models.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name || m.id}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[#94A3B8] mb-1">Temperature ({temperature})</label>
                        <input
                          type="range"
                          min={0}
                          max={1.5}
                          step={0.1}
                          value={temperature}
                          onChange={(e) => setTemperature(Number(e.target.value))}
                          className="w-full accent-[#00FFA3] mt-2"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-[#94A3B8] mb-1">Description</label>
                      <input
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2"
                      />
                    </div>

                    <div>
                      <label className="block text-[#94A3B8] mb-1">System Prompt</label>
                      <textarea
                        rows={5}
                        value={systemPrompt}
                        onChange={(e) => setSystemPrompt(e.target.value)}
                        className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] p-3 font-mono"
                      />
                    </div>

                    <div className="flex items-center justify-between pt-2">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={canSupervise}
                          onChange={(e) => setCanSupervise(e.target.checked)}
                          className="accent-[#00FFA3]"
                        />
                        Supervisor Orchestration Role Enabled
                      </label>

                      <Button type="submit" disabled={isSaving} className="bg-[#00FFA3] text-black font-semibold">
                        <Save className="w-3.5 h-3.5 mr-1.5" />
                        {isSaving ? "Saving Snapshot..." : "Save Configuration"}
                      </Button>
                    </div>
                  </form>
                </CardContent>
              </Card>

              {/* Immutable Configuration Version History */}
              <Card className="border-[#1E2536] bg-[#0E121B]">
                <CardContent className="p-5 space-y-3">
                  <div className="flex items-center gap-2 text-xs font-semibold text-[#F0F4FC]">
                    <History className="w-4 h-4 text-[#38BDF8]" />
                    <span>Immutable Version History ({agent.versions?.length || 0})</span>
                  </div>
                  <div className="divide-y divide-[#1E2536] text-xs font-mono">
                    {(agent.versions || []).map((ver) => (
                      <div key={ver.id} className="py-2.5 flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <span className="text-[#00FFA3] font-semibold">v{ver.versionNumber}</span>{" "}
                          <span className="text-[#F0F4FC]">{ver.modelId || "no-model"}</span>{" "}
                          <span className="text-[#64748B]">• {ver.allowedMcpToolIds.length} MCP tools</span>
                        </div>
                        <div className="text-[#64748B]">
                          sha:{ver.configHash.slice(0, 12)} • {new Date(ver.createdAt).toLocaleString()}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
