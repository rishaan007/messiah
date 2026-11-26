"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Database,
  Search,
  Plus,
  Sparkles,
  Trash2,
  Edit3,
  Pin,
  History,
  Settings2,
  FolderPlus,
  RefreshCw,
  ShieldAlert,
  Lock,
  Users,
  Bot,
  X,
  CheckCircle2,
} from "lucide-react";
import { Button, Badge, Card, CardContent } from "@messiah/ui";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { createClient } from "@/lib/supabase/client";
import {
  MEMORY_CONSTANTS,
  type AgentDefinitionInfo,
  type MemoryCollectionInfo,
  type MemoryInfo,
  type MemoryScope,
  type MemorySearchResponse,
  type MemorySettingsInfo,
  type ProviderConnectionInfo,
  type WorkspaceInfo,
} from "@messiah/shared";

export default function MemoryManagementPage() {
  const router = useRouter();
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);

  const [activeScope, setActiveScope] = useState<"ALL" | MemoryScope>("ALL");
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");

  const [memories, setMemories] = useState<MemoryInfo[]>([]);
  const [collections, setCollections] = useState<MemoryCollectionInfo[]>([]);
  const [agents, setAgents] = useState<AgentDefinitionInfo[]>([]);
  const [connections, setConnections] = useState<ProviderConnectionInfo[]>([]);
  const [settings, setSettings] = useState<MemorySettingsInfo | null>(null);

  const [isLoading, setIsLoading] = useState(true);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Hybrid search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResult, setSearchResult] = useState<MemorySearchResponse | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  // Create Memory Modal
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newScope, setNewScope] = useState<MemoryScope>("WORKSPACE");
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newTags, setNewTags] = useState("");
  const [newAgentId, setNewAgentId] = useState("");
  const [newCollectionId, setNewCollectionId] = useState("");
  const [newImportance, setNewImportance] = useState(0.7);
  const [newPinned, setNewPinned] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Inspector / Edit / Version History Drawer
  const [inspectedMemory, setInspectedMemory] = useState<MemoryInfo | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editReason, setEditReason] = useState("");
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  // Settings Modal
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [cfgProvider, setCfgProvider] = useState<string>("");
  const [cfgModel, setCfgModel] = useState<string>("");
  const [cfgDimensions, setCfgDimensions] = useState<number>(1536);
  const [cfgConnId, setCfgConnId] = useState<string>("");
  const [cfgAutoCapture, setCfgAutoCapture] = useState(false);
  const [cfgChatInjection, setCfgChatInjection] = useState(true);
  const [cfgSwarmInjection, setCfgSwarmInjection] = useState(true);
  const [cfgTopK, setCfgTopK] = useState(6);
  const [cfgRetention, setCfgRetention] = useState<string>("");
  const [isReembedding, setIsReembedding] = useState(false);

  // New Collection Modal
  const [isCollectionOpen, setIsCollectionOpen] = useState(false);
  const [colName, setColName] = useState("");
  const [colScope, setColScope] = useState<MemoryScope>("WORKSPACE");
  const [colAgentId, setColAgentId] = useState("");

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

      const scopeParam = activeScope !== "ALL" ? `&scope=${activeScope}` : "";
      const colParam = selectedCollectionId ? `&collectionId=${selectedCollectionId}` : "";
      const agParam = selectedAgentId ? `&agentId=${selectedAgentId}` : "";

      const [memRes, colRes, setRes, agRes, connRes] = await Promise.all([
        fetch(
          `${apiUrl}/api/v1/memories?workspaceId=${ws.id}${scopeParam}${colParam}${agParam}`,
          { headers: { Authorization: `Bearer ${session.access_token}` } }
        ),
        fetch(`${apiUrl}/api/v1/memories/collections?workspaceId=${ws.id}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        }),
        fetch(`${apiUrl}/api/v1/memories/settings?workspaceId=${ws.id}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        }),
        fetch(`${apiUrl}/api/v1/agents?workspaceId=${ws.id}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        }),
        fetch(`${apiUrl}/api/v1/provider-connections?workspaceId=${ws.id}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        }),
      ]);

      if (memRes.ok) setMemories((await memRes.json()).data || []);
      if (colRes.ok) setCollections((await colRes.json()).data || []);
      if (agRes.ok) setAgents((await agRes.json()).data || []);
      if (connRes.ok) setConnections((await connRes.json()).data || []);
      if (setRes.ok) {
        const s: MemorySettingsInfo = (await setRes.json()).data;
        setSettings(s);
        setCfgProvider(s.embeddingProvider || "");
        setCfgModel(s.embeddingModel || "");
        setCfgDimensions(s.embeddingDimensions || 1536);
        setCfgConnId(s.providerConnectionId || "");
        setCfgAutoCapture(s.enableAutoCapture);
        setCfgChatInjection(s.enableChatInjection);
        setCfgSwarmInjection(s.enableSwarmInjection);
        setCfgTopK(s.defaultTopK);
        setCfgRetention(s.retentionDays ? String(s.retentionDays) : "");
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to load Vector Memory workspace.");
    } finally {
      setIsLoading(false);
    }
  }, [apiUrl, router, activeScope, selectedCollectionId, selectedAgentId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authToken || !workspace) return;
    const q = searchQuery.trim();
    if (!q) {
      setSearchResult(null);
      return;
    }

    setIsSearching(true);
    setErrorMsg(null);
    try {
      const scopesToSearch: MemoryScope[] =
        activeScope === "ALL" ? ["PERSONAL", "WORKSPACE", "AGENT"] : [activeScope];

      const res = await fetch(`${apiUrl}/api/v1/memories/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          workspaceId: workspace.id,
          query: q,
          scopes: scopesToSearch,
          agentIds: selectedAgentId ? [selectedAgentId] : undefined,
          collectionId: selectedCollectionId || undefined,
          topK: settings?.defaultTopK || 8,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErrorMsg(json.error?.message || "Hybrid search failed.");
        return;
      }
      setSearchResult(json.data);
    } finally {
      setIsSearching(false);
    }
  };

  const handleCreateMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authToken || !workspace) return;
    setIsSubmitting(true);
    setErrorMsg(null);
    try {
      const res = await fetch(`${apiUrl}/api/v1/memories`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          workspaceId: workspace.id,
          scope: newScope,
          agentId: newScope === "AGENT" ? newAgentId || null : null,
          collectionId: newCollectionId || null,
          sourceType: newScope === "PERSONAL" ? "PREFERENCE" : "MANUAL",
          title: newTitle,
          content: newContent,
          tags: newTags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          importance: newImportance,
          isPinned: newPinned,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErrorMsg(json.error?.message || "Failed to save memory.");
        return;
      }
      setIsCreateOpen(false);
      setNewTitle("");
      setNewContent("");
      setNewTags("");
      setStatusMessage("Memory stored safely with provenance tracking.");
      await loadData();
    } finally {
      setIsSubmitting(false);
    }
  };

  const openInspector = async (mem: MemoryInfo) => {
    setInspectedMemory(mem);
    setEditTitle(mem.title);
    setEditContent(mem.content);
    setEditReason("");
    if (!authToken || !workspace) return;
    const res = await fetch(`${apiUrl}/api/v1/memories/${mem.id}?workspaceId=${workspace.id}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (res.ok) {
      const detail: MemoryInfo = (await res.json()).data;
      setInspectedMemory(detail);
    }
  };

  const handleSaveEdit = async () => {
    if (!authToken || !workspace || !inspectedMemory) return;
    setIsSavingEdit(true);
    setErrorMsg(null);
    try {
      const res = await fetch(`${apiUrl}/api/v1/memories/${inspectedMemory.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          workspaceId: workspace.id,
          title: editTitle,
          content: editContent,
          changeReason: editReason || "Manual revision",
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErrorMsg(json.error?.message || "Failed to update memory.");
        return;
      }
      setInspectedMemory(json.data);
      setStatusMessage(`Saved revision v${json.data.currentVersion}.`);
      await loadData();
    } finally {
      setIsSavingEdit(false);
    }
  };

  const handleDeleteMemory = async (memoryId: string) => {
    if (!authToken || !workspace) return;
    const res = await fetch(`${apiUrl}/api/v1/memories/${memoryId}?workspaceId=${workspace.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (res.ok) {
      if (inspectedMemory?.id === memoryId) setInspectedMemory(null);
      setSearchResult((prev) =>
        prev
          ? { ...prev, matches: prev.matches.filter((m) => m.memory.id !== memoryId) }
          : null
      );
      await loadData();
    }
  };

  const handleCreateCollection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authToken || !workspace) return;
    const res = await fetch(`${apiUrl}/api/v1/memories/collections`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        workspaceId: workspace.id,
        scope: colScope,
        agentId: colScope === "AGENT" ? colAgentId || null : null,
        name: colName,
      }),
    });
    if (res.ok) {
      setColName("");
      setIsCollectionOpen(false);
      await loadData();
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authToken || !workspace) return;
    setErrorMsg(null);
    const res = await fetch(`${apiUrl}/api/v1/memories/settings`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        workspaceId: workspace.id,
        embeddingProvider: cfgProvider || null,
        embeddingModel: cfgModel || null,
        embeddingDimensions: cfgDimensions,
        providerConnectionId: cfgConnId || null,
        enableAutoCapture: cfgAutoCapture,
        enableChatInjection: cfgChatInjection,
        enableSwarmInjection: cfgSwarmInjection,
        defaultTopK: cfgTopK,
        retentionDays: cfgRetention ? Number(cfgRetention) : null,
      }),
    });
    const json = await res.json();
    if (!res.ok) {
      setErrorMsg(json.error?.message || "Failed to update settings.");
      return;
    }
    setSettings(json.data);
    setIsSettingsOpen(false);
    setStatusMessage("Memory & pgvector embedding settings saved.");
  };

  const handleReembed = async () => {
    if (!authToken || !workspace) return;
    setIsReembedding(true);
    setErrorMsg(null);
    try {
      const res = await fetch(`${apiUrl}/api/v1/memories/reembed`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ workspaceId: workspace.id, forceAll: true }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErrorMsg(json.error?.message || "Re-embedding failed.");
        return;
      }
      setStatusMessage(
        `Re-embedded ${json.data.succeeded}/${json.data.processed} memories via ${json.data.mode}.`
      );
      await loadData();
    } finally {
      setIsReembedding(false);
    }
  };

  const handleClearPersonal = async () => {
    if (!authToken || !workspace) return;
    const scope = activeScope === "ALL" ? "PERSONAL" : activeScope;
    const res = await fetch(`${apiUrl}/api/v1/memories/clear`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        workspaceId: workspace.id,
        scope,
        collectionId: selectedCollectionId || undefined,
      }),
    });
    if (res.ok) {
      const json = await res.json();
      setStatusMessage(`Cleared ${json.data.deletedCount} ${scope.toLowerCase()} memory item(s).`);
      await loadData();
    }
  };

  const scopeBadge = (scope: MemoryScope) => {
    if (scope === "PERSONAL") {
      return (
        <span className="inline-flex items-center gap-1 rounded border border-[#00F0FF]/30 bg-[#00F0FF]/10 px-2 py-0.5 text-[10px] font-medium text-[#00F0FF]">
          <Lock className="h-3 w-3" /> Personal
        </span>
      );
    }
    if (scope === "AGENT") {
      return (
        <span className="inline-flex items-center gap-1 rounded border border-[#A78BFA]/30 bg-[#A78BFA]/10 px-2 py-0.5 text-[10px] font-medium text-[#A78BFA]">
          <Bot className="h-3 w-3" /> Agent
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded border border-[#00FFA3]/30 bg-[#00FFA3]/10 px-2 py-0.5 text-[10px] font-medium text-[#00FFA3]">
        <Users className="h-3 w-3" /> Workspace
      </span>
    );
  };

  const embeddingReadyCount = memories.filter((m) => m.embeddingStatus === "READY").length;
  const displayedItems = searchResult
    ? searchResult.matches.map((m) => ({
        memory: m.memory,
        score: m.score,
        semanticScore: m.semanticScore,
        lexicalScore: m.lexicalScore,
        matchMode: m.matchMode,
      }))
    : memories.map((memory) => ({
        memory,
        score: null as number | null,
        semanticScore: null as number | null,
        lexicalScore: null as number | null,
        matchMode: null as string | null,
      }));

  return (
    <div className="flex h-screen overflow-hidden bg-[#090A0F] text-[#F0F4FC]">
      <Sidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        activeTab="memory"
        onSelectTab={() => {}}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header onToggleSidebar={() => setSidebarOpen((p) => !p)} />
        <main className="flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto max-w-7xl space-y-6">
            {/* Top Header */}
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#1E2536] pb-5">
              <div>
                <div className="flex items-center gap-2.5">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#00F0FF]/30 bg-[#00F0FF]/10 text-[#00F0FF]">
                    <Database className="h-5 w-5" />
                  </div>
                  <h1 className="text-xl font-semibold tracking-tight">Long-Term Vector Memory</h1>
                  <Badge variant="outline" className="border-[#00FFA3]/40 text-[#00FFA3]">
                    pgvector + Hybrid Search
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-[#8E9BB4]">
                  Tenant-isolated Personal, Workspace, and Agent knowledge indexed for universal chat, swarms, and workflows.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2.5">
                <Button
                  variant="outline"
                  onClick={() => setIsCollectionOpen(true)}
                  className="border-[#1E2536] bg-[#12151E] text-xs hover:border-[#00F0FF]/40"
                >
                  <FolderPlus className="mr-1.5 h-3.5 w-3.5" /> New Collection
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setIsSettingsOpen(true)}
                  className="border-[#1E2536] bg-[#12151E] text-xs hover:border-[#00F0FF]/40"
                >
                  <Settings2 className="mr-1.5 h-3.5 w-3.5" /> Embedding Settings
                </Button>
                <Button
                  onClick={() => setIsCreateOpen(true)}
                  className="bg-[#00F0FF] text-xs font-semibold text-[#090A0F] hover:bg-[#00F0FF]/90"
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" /> Add Memory
                </Button>
              </div>
            </div>

            {statusMessage && (
              <div className="flex items-center justify-between rounded-lg border border-[#00FFA3]/30 bg-[#00FFA3]/10 px-4 py-2.5 text-xs text-[#00FFA3]">
                <span className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4" />
                  {statusMessage}
                </span>
                <button onClick={() => setStatusMessage(null)} className="opacity-70 hover:opacity-100">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            {errorMsg && (
              <div className="flex items-center justify-between rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-300">
                <span className="flex items-center gap-2">
                  <ShieldAlert className="h-4 w-4" />
                  {errorMsg}
                </span>
                <button onClick={() => setErrorMsg(null)} className="opacity-70 hover:opacity-100">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            {/* KPI Row */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Card className="border-[#1E2536] bg-[#12151E]">
                <CardContent className="p-4">
                  <div className="text-[11px] uppercase tracking-wider text-[#8E9BB4]">Visible Memories</div>
                  <div className="mt-1 text-2xl font-semibold">{memories.length}</div>
                  <div className="mt-1 text-[11px] text-[#8E9BB4]">{collections.length} collection(s)</div>
                </CardContent>
              </Card>
              <Card className="border-[#1E2536] bg-[#12151E]">
                <CardContent className="p-4">
                  <div className="text-[11px] uppercase tracking-wider text-[#8E9BB4]">pgvector Indexed</div>
                  <div className="mt-1 text-2xl font-semibold text-[#00FFA3]">{embeddingReadyCount}</div>
                  <div className="mt-1 text-[11px] text-[#8E9BB4]">
                    {settings?.embeddingProvider || "auto-detect"} / {settings?.embeddingDimensions || 1536}d
                  </div>
                </CardContent>
              </Card>
              <Card className="border-[#1E2536] bg-[#12151E]">
                <CardContent className="p-4">
                  <div className="text-[11px] uppercase tracking-wider text-[#8E9BB4]">Prompt Injection</div>
                  <div className="mt-1 text-2xl font-semibold text-[#00F0FF]">
                    {settings?.enableChatInjection ? "Active" : "Paused"}
                  </div>
                  <div className="mt-1 text-[11px] text-[#8E9BB4]">
                    Top-{settings?.defaultTopK || 6} · Auto-capture {settings?.enableAutoCapture ? "ON" : "OFF"}
                  </div>
                </CardContent>
              </Card>
              <Card className="border-[#1E2536] bg-[#12151E]">
                <CardContent className="p-4">
                  <div className="text-[11px] uppercase tracking-wider text-[#8E9BB4]">Secret Guard</div>
                  <div className="mt-1 text-2xl font-semibold text-[#F0F4FC]">Enforced</div>
                  <div className="mt-1 text-[11px] text-[#8E9BB4]">API keys & private credentials blocked</div>
                </CardContent>
              </Card>
            </div>

            {/* Scope Filters & Hybrid Search Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#1E2536] bg-[#12151E] p-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {(["ALL", "WORKSPACE", "PERSONAL", "AGENT"] as const).map((sc) => (
                  <button
                    key={sc}
                    onClick={() => {
                      setActiveScope(sc);
                      setSearchResult(null);
                    }}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                      activeScope === sc
                        ? "bg-[#00F0FF]/15 text-[#00F0FF] ring-1 ring-[#00F0FF]/40"
                        : "text-[#8E9BB4] hover:bg-[#191E2B] hover:text-[#F0F4FC]"
                    }`}
                  >
                    {sc === "ALL" ? "All Scopes" : sc.charAt(0) + sc.slice(1).toLowerCase()}
                  </button>
                ))}
                {activeScope === "AGENT" && (
                  <select
                    value={selectedAgentId}
                    onChange={(e) => setSelectedAgentId(e.target.value)}
                    className="ml-2 rounded-lg border border-[#1E2536] bg-[#090A0F] px-2.5 py-1.5 text-xs text-[#F0F4FC]"
                  >
                    <option value="">All Workspace Agents</option>
                    {agents.map((ag) => (
                      <option key={ag.id} value={ag.id}>
                        {ag.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <form onSubmit={handleSearch} className="flex flex-1 items-center gap-2 sm:max-w-md">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-2.5 h-3.5 w-3.5 text-[#8E9BB4]" />
                  <input
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      if (!e.target.value.trim()) setSearchResult(null);
                    }}
                    placeholder="Semantic + lexical memory search..."
                    className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] py-2 pl-8 pr-3 text-xs text-[#F0F4FC] placeholder-[#5B677D] focus:border-[#00F0FF] focus:outline-none"
                  />
                </div>
                <Button
                  type="submit"
                  disabled={isSearching}
                  variant="outline"
                  className="border-[#00F0FF]/40 bg-[#00F0FF]/10 text-xs text-[#00F0FF]"
                >
                  {isSearching ? "Searching..." : "Retrieve"}
                </Button>
              </form>
            </div>

            {searchResult && (
              <div className="flex items-center justify-between rounded-lg border border-[#00F0FF]/30 bg-[#00F0FF]/5 px-4 py-2 text-xs">
                <span className="text-[#F0F4FC]">
                  Retrieval mode:{" "}
                  <strong className="text-[#00F0FF]">{searchResult.mode}</strong> · Found{" "}
                  {searchResult.matches.length} relevant memory entry(s)
                  {searchResult.embeddingModel ? ` via ${searchResult.embeddingModel}` : ""}
                </span>
                <button
                  onClick={() => {
                    setSearchQuery("");
                    setSearchResult(null);
                  }}
                  className="text-[#8E9BB4] hover:text-[#F0F4FC]"
                >
                  Clear Search
                </button>
              </div>
            )}

            {/* Main Grid: Collections + Memory List + Inspector */}
            <div className="grid gap-6 lg:grid-cols-12">
              {/* Collections Left Sidebar */}
              <div className="space-y-3 lg:col-span-3">
                <Card className="border-[#1E2536] bg-[#12151E]">
                  <CardContent className="p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <h2 className="text-xs font-semibold uppercase tracking-wider text-[#8E9BB4]">
                        Collections
                      </h2>
                      <button
                        onClick={handleClearPersonal}
                        className="text-[11px] text-rose-400 hover:underline"
                      >
                        Clear Scope
                      </button>
                    </div>
                    <button
                      onClick={() => setSelectedCollectionId(null)}
                      className={`w-full rounded-lg px-3 py-2 text-left text-xs transition ${
                        selectedCollectionId === null
                          ? "bg-[#191E2B] text-[#00F0FF]"
                          : "text-[#8E9BB4] hover:bg-[#191E2B]/60"
                      }`}
                    >
                      All Entries
                    </button>
                    {collections.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => setSelectedCollectionId(c.id)}
                        className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition ${
                          selectedCollectionId === c.id
                            ? "bg-[#191E2B] text-[#00F0FF]"
                            : "text-[#8E9BB4] hover:bg-[#191E2B]/60"
                        }`}
                      >
                        <span className="truncate">{c.name}</span>
                        <span className="rounded bg-[#090A0F] px-1.5 py-0.5 text-[10px]">
                          {c.memoryCount ?? 0}
                        </span>
                      </button>
                    ))}
                  </CardContent>
                </Card>
              </div>

              {/* Memory Feed */}
              <div className="space-y-3 lg:col-span-5">
                {isLoading ? (
                  <Card className="border-[#1E2536] bg-[#12151E]">
                    <CardContent className="p-8 text-center text-xs text-[#8E9BB4]">
                      Loading long-term memory entries...
                    </CardContent>
                  </Card>
                ) : displayedItems.length === 0 ? (
                  <Card className="border-[#1E2536] bg-[#12151E]">
                    <CardContent className="p-8 text-center">
                      <Sparkles className="mx-auto h-7 w-7 text-[#00F0FF]/50" />
                      <p className="mt-2 text-sm font-medium">No memories stored yet</p>
                      <p className="mt-1 text-xs text-[#8E9BB4]">
                        Add preferences, workspace conventions, or let workflows save insights here.
                      </p>
                    </CardContent>
                  </Card>
                ) : (
                  displayedItems.map(({ memory, score, matchMode }) => (
                    <Card
                      key={memory.id}
                      onClick={() => openInspector(memory)}
                      className={`cursor-pointer border transition ${
                        inspectedMemory?.id === memory.id
                          ? "border-[#00F0FF]/60 bg-[#151A28]"
                          : "border-[#1E2536] bg-[#12151E] hover:border-[#2C364F]"
                      }`}
                    >
                      <CardContent className="p-4 space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            {scopeBadge(memory.scope)}
                            <span className="text-xs font-semibold text-[#F0F4FC]">
                              {memory.title}
                            </span>
                            {memory.isPinned && <Pin className="h-3 w-3 text-[#00F0FF]" />}
                          </div>
                          {score !== null && (
                            <span className="rounded bg-[#00F0FF]/15 px-2 py-0.5 text-[10px] font-mono text-[#00F0FF]">
                              {(score * 100).toFixed(0)}% {matchMode}
                            </span>
                          )}
                        </div>
                        <p className="line-clamp-2 text-xs text-[#A3B1C6]">{memory.content}</p>
                        <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[10px] text-[#6E7B94]">
                          <div className="flex items-center gap-2">
                            <span>v{memory.currentVersion}</span>
                            <span>·</span>
                            <span>{memory.sourceType}</span>
                            {memory.agentName && <span>· {memory.agentName}</span>}
                            <span>
                              · Vector:{" "}
                              <strong
                                className={
                                  memory.embeddingStatus === "READY"
                                    ? "text-[#00FFA3]"
                                    : "text-amber-400"
                                }
                              >
                                {memory.embeddingStatus || "LEXICAL"}
                              </strong>
                            </span>
                          </div>
                          <span>{new Date(memory.updatedAt).toLocaleDateString()}</span>
                        </div>
                      </CardContent>
                    </Card>
                  ))
                )}
              </div>

              {/* Right Provenance & Revision Inspector */}
              <div className="lg:col-span-4">
                {inspectedMemory ? (
                  <Card className="border-[#1E2536] bg-[#12151E]">
                    <CardContent className="p-4 space-y-4">
                      <div className="flex items-center justify-between border-b border-[#1E2536] pb-3">
                        <div className="flex items-center gap-2">
                          {scopeBadge(inspectedMemory.scope)}
                          <span className="text-xs font-semibold">Provenance & Revisions</span>
                        </div>
                        <button
                          onClick={() => handleDeleteMemory(inspectedMemory.id)}
                          className="rounded p-1 text-rose-400 hover:bg-rose-500/10"
                          title="Delete memory"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>

                      <div className="space-y-2.5 text-xs">
                        <div>
                          <label className="mb-1 block text-[11px] text-[#8E9BB4]">Title</label>
                          <input
                            value={editTitle}
                            onChange={(e) => setEditTitle(e.target.value)}
                            className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-1.5 text-xs"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-[11px] text-[#8E9BB4]">Content</label>
                          <textarea
                            rows={5}
                            value={editContent}
                            onChange={(e) => setEditContent(e.target.value)}
                            className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2 text-xs"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-[11px] text-[#8E9BB4]">Revision Reason</label>
                          <input
                            value={editReason}
                            onChange={(e) => setEditReason(e.target.value)}
                            placeholder="Why this memory was refined..."
                            className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-1.5 text-xs"
                          />
                        </div>
                        <Button
                          onClick={handleSaveEdit}
                          disabled={isSavingEdit}
                          className="w-full bg-[#00F0FF] text-xs font-semibold text-[#090A0F]"
                        >
                          <Edit3 className="mr-1.5 h-3.5 w-3.5" />
                          {isSavingEdit ? "Saving Revision..." : "Save & Create New Version"}
                        </Button>
                      </div>

                      <div className="rounded-lg border border-[#1E2536] bg-[#090A0F] p-3 text-[11px] text-[#8E9BB4] space-y-1">
                        <div>Source Type: {inspectedMemory.sourceType}</div>
                        <div>Sensitivity: {inspectedMemory.sensitivity}</div>
                        <div>Content Hash: {inspectedMemory.contentHash.slice(0, 16)}...</div>
                        {inspectedMemory.sourceWorkflowRunId && (
                          <div>Workflow Run: {inspectedMemory.sourceWorkflowRunId}</div>
                        )}
                        {inspectedMemory.sourceThreadId && (
                          <div>Chat Thread: {inspectedMemory.sourceThreadId}</div>
                        )}
                      </div>

                      {inspectedMemory.versions && inspectedMemory.versions.length > 0 && (
                        <div className="space-y-2">
                          <div className="flex items-center gap-1.5 text-xs font-medium text-[#8E9BB4]">
                            <History className="h-3.5 w-3.5" /> Version History
                          </div>
                          <div className="max-h-44 space-y-1.5 overflow-y-auto">
                            {inspectedMemory.versions.map((ver) => (
                              <div
                                key={ver.id}
                                className="rounded border border-[#1E2536] bg-[#090A0F] p-2 text-[11px]"
                              >
                                <div className="flex justify-between text-[#00F0FF]">
                                  <span>v{ver.versionNumber}</span>
                                  <span className="text-[#6E7B94]">
                                    {new Date(ver.createdAt).toLocaleString()}
                                  </span>
                                </div>
                                <div className="mt-0.5 text-[#8E9BB4]">{ver.changeReason || "Update"}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ) : (
                  <Card className="border-[#1E2536] bg-[#12151E]">
                    <CardContent className="p-8 text-center text-xs text-[#8E9BB4]">
                      Select any memory item to inspect provenance, version history, or edit content.
                    </CardContent>
                  </Card>
                )}
              </div>
            </div>
          </div>
        </main>
      </div>

      {/* Create Memory Modal */}
      {isCreateOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-lg rounded-xl border border-[#1E2536] bg-[#12151E] p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Store Long-Term Memory</h2>
              <button onClick={() => setIsCreateOpen(false)}>
                <X className="h-4 w-4 text-[#8E9BB4]" />
              </button>
            </div>
            <form onSubmit={handleCreateMemory} className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-[#8E9BB4]">Scope</label>
                  <select
                    value={newScope}
                    onChange={(e) => setNewScope(e.target.value as MemoryScope)}
                    className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-2.5 py-2"
                  >
                    <option value="WORKSPACE">Workspace Memory</option>
                    <option value="PERSONAL">Personal Memory (Private)</option>
                    <option value="AGENT">Agent Memory</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-[#8E9BB4]">Collection (optional)</label>
                  <select
                    value={newCollectionId}
                    onChange={(e) => setNewCollectionId(e.target.value)}
                    className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-2.5 py-2"
                  >
                    <option value="">None</option>
                    {collections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {newScope === "AGENT" && (
                <div>
                  <label className="mb-1 block text-[#8E9BB4]">Target Agent</label>
                  <select
                    required
                    value={newAgentId}
                    onChange={(e) => setNewAgentId(e.target.value)}
                    className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-2.5 py-2"
                  >
                    <option value="">Select agent...</option>
                    {agents.map((ag) => (
                      <option key={ag.id} value={ag.id}>
                        {ag.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="mb-1 block text-[#8E9BB4]">Title</label>
                <input
                  required
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="e.g., Backend Coding & Deployment Conventions"
                  className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2"
                />
              </div>
              <div>
                <label className="mb-1 block text-[#8E9BB4]">Memory Content</label>
                <textarea
                  required
                  rows={5}
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  placeholder="Durable preference, architectural decision, or verified takeaway..."
                  className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-[#8E9BB4]">Tags (comma-separated)</label>
                  <input
                    value={newTags}
                    onChange={(e) => setNewTags(e.target.value)}
                    placeholder="architecture, postgres"
                    className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[#8E9BB4]">Importance ({newImportance})</label>
                  <input
                    type="range"
                    min="0.1"
                    max="1"
                    step="0.1"
                    value={newImportance}
                    onChange={(e) => setNewImportance(Number(e.target.value))}
                    className="mt-2 w-full"
                  />
                </div>
              </div>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={newPinned}
                  onChange={(e) => setNewPinned(e.target.checked)}
                />
                <span>Pin memory for priority retrieval</span>
              </label>
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" onClick={() => setIsCreateOpen(false)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={isSubmitting}
                  className="bg-[#00F0FF] font-semibold text-[#090A0F]"
                >
                  {isSubmitting ? "Saving..." : "Store Memory"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Collection Modal */}
      {isCollectionOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-md rounded-xl border border-[#1E2536] bg-[#12151E] p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Create Memory Collection</h2>
              <button onClick={() => setIsCollectionOpen(false)}>
                <X className="h-4 w-4 text-[#8E9BB4]" />
              </button>
            </div>
            <form onSubmit={handleCreateCollection} className="space-y-3 text-xs">
              <div>
                <label className="mb-1 block text-[#8E9BB4]">Collection Name</label>
                <input
                  required
                  value={colName}
                  onChange={(e) => setColName(e.target.value)}
                  placeholder="Architecture Decisions"
                  className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2"
                />
              </div>
              <div>
                <label className="mb-1 block text-[#8E9BB4]">Scope</label>
                <select
                  value={colScope}
                  onChange={(e) => setColScope(e.target.value as MemoryScope)}
                  className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-2.5 py-2"
                >
                  <option value="WORKSPACE">Workspace</option>
                  <option value="PERSONAL">Personal</option>
                  <option value="AGENT">Agent</option>
                </select>
              </div>
              {colScope === "AGENT" && (
                <div>
                  <label className="mb-1 block text-[#8E9BB4]">Target Agent</label>
                  <select
                    required
                    value={colAgentId}
                    onChange={(e) => setColAgentId(e.target.value)}
                    className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-2.5 py-2"
                  >
                    <option value="">Select agent...</option>
                    {agents.map((ag) => (
                      <option key={ag.id} value={ag.id}>
                        {ag.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setIsCollectionOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" className="bg-[#00F0FF] font-semibold text-[#090A0F]">
                  Create Collection
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Embedding & Memory Settings Modal */}
      {isSettingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-lg rounded-xl border border-[#1E2536] bg-[#12151E] p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Memory & Embedding Configuration</h2>
              <button onClick={() => setIsSettingsOpen(false)}>
                <X className="h-4 w-4 text-[#8E9BB4]" />
              </button>
            </div>
            <form onSubmit={handleSaveSettings} className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-[#8E9BB4]">Embedding Provider</label>
                  <select
                    value={cfgProvider}
                    onChange={(e) => {
                      const p = e.target.value;
                      setCfgProvider(p);
                      if (p === "openai") {
                        setCfgModel("text-embedding-3-small");
                        setCfgDimensions(1536);
                      } else if (p === "gemini") {
                        setCfgModel("gemini-embedding-001");
                        setCfgDimensions(768);
                      }
                    }}
                    className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-2.5 py-2"
                  >
                    <option value="">Auto-detect connected provider</option>
                    <option value="openai">OpenAI</option>
                    <option value="gemini">Google Gemini</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-[#8E9BB4]">Dimensions</label>
                  <select
                    value={cfgDimensions}
                    onChange={(e) => setCfgDimensions(Number(e.target.value))}
                    className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-2.5 py-2"
                  >
                    {MEMORY_CONSTANTS.SUPPORTED_DIMENSIONS.map((d) => (
                      <option key={d} value={d}>
                        {d} dimensions
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-[#8E9BB4]">Embedding Model</label>
                  <input
                    value={cfgModel}
                    onChange={(e) => setCfgModel(e.target.value)}
                    placeholder="text-embedding-3-small"
                    className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[#8E9BB4]">Connection</label>
                  <select
                    value={cfgConnId}
                    onChange={(e) => setCfgConnId(e.target.value)}
                    className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-2.5 py-2"
                  >
                    <option value="">Auto-select workspace connection</option>
                    {connections
                      .filter((c) => c.provider === "openai" || c.provider === "gemini")
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.displayName} ({c.provider})
                        </option>
                      ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-[#8E9BB4]">Top-K Memories Retrieved</label>
                  <input
                    type="number"
                    min={1}
                    max={25}
                    value={cfgTopK}
                    onChange={(e) => setCfgTopK(Number(e.target.value))}
                    className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[#8E9BB4]">Retention (Days, optional)</label>
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    value={cfgRetention}
                    onChange={(e) => setCfgRetention(e.target.value)}
                    placeholder="No expiry"
                    className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2"
                  />
                </div>
              </div>
              <div className="space-y-1.5 pt-1">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={cfgChatInjection}
                    onChange={(e) => setCfgChatInjection(e.target.checked)}
                  />
                  <span>Inject relevant memories into Universal Chat prompts</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={cfgSwarmInjection}
                    onChange={(e) => setCfgSwarmInjection(e.target.checked)}
                  />
                  <span>Inject authorized memories into Multi-Agent Swarms</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={cfgAutoCapture}
                    onChange={(e) => setCfgAutoCapture(e.target.checked)}
                  />
                  <span>Auto-capture scrubbed chat summaries as Personal memories</span>
                </label>
              </div>
              <div className="flex items-center justify-between border-t border-[#1E2536] pt-3">
                <Button
                  type="button"
                  variant="outline"
                  disabled={isReembedding}
                  onClick={handleReembed}
                  className="border-[#00FFA3]/40 text-xs text-[#00FFA3]"
                >
                  <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isReembedding ? "animate-spin" : ""}`} />
                  {isReembedding ? "Re-embedding..." : "Re-embed All Memories"}
                </Button>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" onClick={() => setIsSettingsOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" className="bg-[#00F0FF] font-semibold text-[#090A0F]">
                    Save Configuration
                  </Button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
