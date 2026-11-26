"use client";

import React, { useState, useEffect, useCallback, Suspense } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import {
  Shield,
  ArrowLeft,
  FolderLock,
  Plus,
  Trash2,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Terminal,
  Server,
  Sliders,
} from "lucide-react";
import { Button, Card, CardContent, Badge } from "@messiah/ui";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { BridgeTaskCard } from "@/components/BridgeTaskCard";
import { createClient } from "@/lib/supabase/client";
import { BRIDGE_CAPABILITIES, type BridgeTaskInfo, type BridgeLocalMcpServerInfo, type WorkspaceInfo } from "@messiah/shared";

const ALL_CAPABILITIES = [
  { key: BRIDGE_CAPABILITIES.FILESYSTEM_LIST, label: "List Directory Contents", group: "Filesystem" },
  { key: BRIDGE_CAPABILITIES.FILESYSTEM_READ, label: "Read File (Byte Capped)", group: "Filesystem" },
  { key: BRIDGE_CAPABILITIES.FILESYSTEM_SEARCH, label: "Fast File / Text Search", group: "Filesystem" },
  { key: BRIDGE_CAPABILITIES.FILESYSTEM_CREATE, label: "Atomic File Creation", group: "Filesystem" },
  { key: BRIDGE_CAPABILITIES.FILESYSTEM_MODIFY, label: "Atomic Modify with Hash Check", group: "Filesystem" },
  { key: BRIDGE_CAPABILITIES.FILESYSTEM_DELETE, label: "Delete File / Directory", group: "Filesystem" },
  { key: BRIDGE_CAPABILITIES.MCP_DISCOVER, label: "Discover Local MCP Servers", group: "MCP" },
  { key: BRIDGE_CAPABILITIES.MCP_INVOKE, label: "Invoke Local MCP Server Tools", group: "MCP" },
  { key: BRIDGE_CAPABILITIES.PROCESS_RUN, label: "Sandboxed Process Execution", group: "Terminal & Process" },
  { key: BRIDGE_CAPABILITIES.PROCESS_INSPECT, label: "Inspect Process Lifecycle", group: "Terminal & Process" },
  { key: BRIDGE_CAPABILITIES.AGENT_START, label: "Spawn Subagent in Workstation", group: "Agent Automation" },
  { key: BRIDGE_CAPABILITIES.AGENT_STATUS, label: "Poll Workstation Subagent", group: "Agent Automation" },
  { key: BRIDGE_CAPABILITIES.AGENT_CANCEL, label: "Terminate Workstation Subagent", group: "Agent Automation" },
];

function DeviceCapabilitiesContent() {
  const params = useParams();
  const searchParams = useSearchParams();
  const deviceId = params.deviceId as string;
  const workspaceIdFromUrl = searchParams.get("workspaceId");

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(workspaceIdFromUrl);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceInfo | null>(null);

  const [deviceData, setDeviceData] = useState<{
    deviceId: string;
    displayName: string;
    platform: string;
    architecture: string;
    isOnline: boolean;
    capabilities: string[];
    allowedRoots: string[];
    devicePolicy?: any;
    updatedAt: string;
  } | null>(null);

  const [localMcpServers, setLocalMcpServers] = useState<BridgeLocalMcpServerInfo[]>([]);
  const [tasks, setTasks] = useState<BridgeTaskInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Form edit state
  const [allowedRoots, setAllowedRoots] = useState<string[]>([]);
  const [newRootInput, setNewRootInput] = useState("");
  const [selectedCapabilities, setSelectedCapabilities] = useState<string[]>([]);
  const [terminalExecution, setTerminalExecution] = useState(false);
  const [maxProcesses, setMaxProcesses] = useState(5);
  const [maxMemoryMb, setMaxMemoryMb] = useState(1024);

  // Local MCP modal state
  const [showAddMcpModal, setShowAddMcpModal] = useState(false);
  const [mcpServerName, setMcpServerName] = useState("");
  const [mcpCommand, setMcpCommand] = useState("");
  const [mcpArgs, setMcpArgs] = useState("");
  const [mcpCwd, setMcpCwd] = useState("");
  const [isRegisteringMcp, setIsRegisteringMcp] = useState(false);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

  const loadAll = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        setErrorMessage("Please sign in to view device capabilities.");
        setIsLoading(false);
        return;
      }

      let wsId = activeWorkspaceId;
      const wsRes = await fetch(`${apiUrl}/api/v1/workspaces`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (wsRes.ok) {
        const wsJson = await wsRes.json();
        const wsList: WorkspaceInfo[] = wsJson.data || [];
        const matched = wsId ? wsList.find((w) => w.id === wsId) || wsList[0] : wsList[0];
        if (matched) {
          wsId = matched.id;
          setActiveWorkspaceId(matched.id);
          setActiveWorkspace(matched);
        }
      }

      if (!wsId) {
        setErrorMessage("No active workspace found.");
        setIsLoading(false);
        return;
      }

      // Fetch capabilities & policy
      const capRes = await fetch(
        `${apiUrl}/api/v1/devices/${deviceId}/capabilities?workspaceId=${wsId}`,
        {
          headers: { Authorization: `Bearer ${session.access_token}` },
        }
      );

      if (!capRes.ok) {
        throw new Error(`Failed to load device capabilities (${capRes.status})`);
      }

      const capJson = await capRes.json();
      const capData = capJson.data;
      setDeviceData(capData);
      setAllowedRoots(capData.allowedRoots || []);
      setSelectedCapabilities(capData.capabilities || []);
      setTerminalExecution(capData.devicePolicy?.terminalExecutionEnabled ?? false);
      setMaxProcesses(capData.devicePolicy?.maxProcesses ?? 5);
      setMaxMemoryMb(
        capData.devicePolicy?.maxMemoryBytes
          ? Math.round(capData.devicePolicy.maxMemoryBytes / (1024 * 1024))
          : 1024
      );

      // Fetch local MCP servers
      const mcpRes = await fetch(
        `${apiUrl}/api/v1/devices/${deviceId}/mcp?workspaceId=${wsId}`,
        {
          headers: { Authorization: `Bearer ${session.access_token}` },
        }
      );
      if (mcpRes.ok) {
        const mcpJson = await mcpRes.json();
        setLocalMcpServers(mcpJson.data || []);
      }

      // Fetch recent tasks
      const taskRes = await fetch(
        `${apiUrl}/api/v1/devices/${deviceId}/tasks?workspaceId=${wsId}&limit=20`,
        {
          headers: { Authorization: `Bearer ${session.access_token}` },
        }
      );
      if (taskRes.ok) {
        const taskJson = await taskRes.json();
        setTasks(taskJson.data || []);
      }
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to load device information.");
    } finally {
      setIsLoading(false);
    }
  }, [apiUrl, deviceId, activeWorkspaceId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Handle Save Policy & Roots
  const handleSavePolicy = async () => {
    if (!activeWorkspaceId) return;
    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) throw new Error("Not signed in");

      const res = await fetch(`${apiUrl}/api/v1/devices/${deviceId}/policy`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workspaceId: activeWorkspaceId,
          allowedRoots,
          capabilities: selectedCapabilities,
          devicePolicy: {
            terminalExecutionEnabled: terminalExecution,
            maxProcesses,
            maxMemoryBytes: maxMemoryMb * 1024 * 1024,
            writableRoots: allowedRoots,
          },
        }),
      });

      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error?.message || "Failed to update device security policy.");
      }

      setSuccessMessage("Security policy and capabilities updated successfully.");
      loadAll();
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to save policy.");
    } finally {
      setIsSaving(false);
    }
  };

  // Add Root
  const handleAddRoot = () => {
    const trimmed = newRootInput.trim();
    if (!trimmed) return;
    if (allowedRoots.includes(trimmed)) return;
    setAllowedRoots([...allowedRoots, trimmed]);
    setNewRootInput("");
  };

  // Remove Root
  const handleRemoveRoot = (root: string) => {
    setAllowedRoots(allowedRoots.filter((r) => r !== root));
  };

  // Toggle Capability
  const toggleCapability = (key: string) => {
    if (selectedCapabilities.includes(key)) {
      setSelectedCapabilities(selectedCapabilities.filter((k) => k !== key));
    } else {
      setSelectedCapabilities([...selectedCapabilities, key]);
    }
  };

  // Register Local MCP Server
  const handleRegisterMcp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeWorkspaceId || !mcpServerName || !mcpCommand) return;
    setIsRegisteringMcp(true);
    setErrorMessage(null);

    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) throw new Error("Not signed in");

      const argsArray = mcpArgs
        .split(" ")
        .map((a) => a.trim())
        .filter((a) => a.length > 0);

      const res = await fetch(`${apiUrl}/api/v1/devices/${deviceId}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workspaceId: activeWorkspaceId,
          serverName: mcpServerName.trim(),
          command: mcpCommand.trim(),
          args: argsArray,
          cwd: mcpCwd.trim() || undefined,
        }),
      });

      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error?.message || "Failed to register local MCP server.");
      }

      setShowAddMcpModal(false);
      setMcpServerName("");
      setMcpCommand("");
      setMcpArgs("");
      setMcpCwd("");
      setSuccessMessage(`Local MCP Server '${json.data.serverName}' registered.`);
      loadAll();
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to register local MCP server.");
    } finally {
      setIsRegisteringMcp(false);
    }
  };

  // Task Approval handlers
  const handleApproveTask = async (taskId: string) => {
    if (!activeWorkspaceId) return;
    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Not signed in");

      const res = await fetch(`${apiUrl}/api/v1/devices/tasks/${taskId}/approve`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workspaceId: activeWorkspaceId,
          action: "approve",
        }),
      });

      if (!res.ok) throw new Error("Failed to approve task.");
      setSuccessMessage("Task approved and dispatched to workstation.");
      loadAll();
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to approve task.");
    }
  };

  const handleRejectTask = async (taskId: string, rejectionReason?: string) => {
    if (!activeWorkspaceId) return;
    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Not signed in");

      const res = await fetch(`${apiUrl}/api/v1/devices/tasks/${taskId}/reject`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workspaceId: activeWorkspaceId,
          action: "reject",
          rejectionReason,
        }),
      });

      if (!res.ok) throw new Error("Failed to reject task.");
      setSuccessMessage("Task rejected and cancel sent to workstation.");
      loadAll();
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to reject task.");
    }
  };

  return (
    <div className="flex h-screen bg-[#07080B] text-[#CBD5E1]">
      <Sidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        activeTab="devices"
        onSelectTab={() => {}}
      />

      <div className="flex flex-1 flex-col overflow-hidden">
        <Header
          onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
          activeWorkspace={activeWorkspace}
          onWorkspaceChange={(ws) => {
            setActiveWorkspace(ws);
            setActiveWorkspaceId(ws.id);
          }}
        />

        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 space-y-6 max-w-6xl mx-auto w-full">
          {/* Back Button & Title */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link href="/settings/devices">
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-[#94A3B8] hover:text-white">
                  <ArrowLeft className="h-4 w-4" />
                </Button>
              </Link>
              <div>
                <h1 className="text-xl font-bold text-white flex items-center gap-2">
                  <span>{deviceData?.displayName || "Workstation Capabilities"}</span>
                  {deviceData?.isOnline ? (
                    <Badge variant="outline" className="border-emerald-500/30 bg-emerald-950/20 text-emerald-400 text-xs">
                      <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      Online
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="border-[#1E2536] bg-[#151822] text-[#94A3B8] text-xs">
                      Offline
                    </Badge>
                  )}
                </h1>
                <p className="text-xs text-[#94A3B8] flex items-center gap-2 pt-0.5">
                  <span>Platform: {deviceData?.platform} ({deviceData?.architecture})</span>
                  <span>·</span>
                  <span className="font-mono text-[11px] text-[#64748B]">ID: {deviceId}</span>
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={loadAll}
                disabled={isLoading}
                className="border-[#1E2536] text-[#CBD5E1] hover:text-white hover:bg-[#151822] h-8 text-xs"
              >
                <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
              <Button
                size="sm"
                onClick={handleSavePolicy}
                disabled={isSaving}
                className="bg-indigo-600 hover:bg-indigo-500 text-white h-8 text-xs px-4"
              >
                {isSaving ? "Saving..." : "Save Policy"}
              </Button>
            </div>
          </div>

          {/* Alerts */}
          {errorMessage && (
            <div className="rounded-xl border border-red-500/30 bg-red-950/20 p-4 text-xs text-red-300 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-red-400" />
                <span>{errorMessage}</span>
              </div>
              <button onClick={() => setErrorMessage(null)} className="text-red-400 hover:text-white">
                ✕
              </button>
            </div>
          )}

          {successMessage && (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-4 text-xs text-emerald-300 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                <span>{successMessage}</span>
              </div>
              <button onClick={() => setSuccessMessage(null)} className="text-emerald-400 hover:text-white">
                ✕
              </button>
            </div>
          )}

          {/* Grid: Allowed Roots & Security Policy */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Allowed Project Roots */}
            <Card className="border-[#1E2536] bg-[#0E121B]">
              <CardContent className="p-5 space-y-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <FolderLock className="h-4 w-4 text-indigo-400" />
                  <span>Approved Project Root Directories</span>
                </div>
                <p className="text-xs text-[#94A3B8]">
                  Workstation operations (reads, edits, search, execution) are strictly confined
                  to these canonical directories. Symlink escapes and directory traversal outside
                  these paths are rejected by PathGuard.
                </p>

                {/* Roots List */}
                <div className="space-y-2">
                  {allowedRoots.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-[#1E2536] p-4 text-center text-xs text-[#64748B]">
                      No directories approved. Workstation filesystem access is disabled.
                    </div>
                  ) : (
                    allowedRoots.map((root, idx) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between rounded-lg bg-[#07080B] border border-[#1E2536] p-2.5 text-xs font-mono text-[#CBD5E1]"
                      >
                        <span className="truncate mr-2">{root}</span>
                        <button
                          onClick={() => handleRemoveRoot(root)}
                          className="text-[#64748B] hover:text-red-400"
                          title="Remove root"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))
                  )}
                </div>

                {/* Add Root Input */}
                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="text"
                    placeholder="/Users/username/my-project"
                    value={newRootInput}
                    onChange={(e) => setNewRootInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleAddRoot()}
                    className="flex-1 rounded-lg bg-[#07080B] border border-[#1E2536] px-3 py-1.5 text-xs text-white placeholder-[#64748B] outline-none focus:border-indigo-500 font-mono"
                  />
                  <Button
                    size="sm"
                    onClick={handleAddRoot}
                    className="bg-[#151822] hover:bg-[#1E2536] text-white text-xs h-8 px-3"
                  >
                    <Plus className="h-3.5 w-3.5 mr-1" />
                    Add
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Sandbox & Execution Policy */}
            <Card className="border-[#1E2536] bg-[#0E121B]">
              <CardContent className="p-5 space-y-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <Shield className="h-4 w-4 text-indigo-400" />
                  <span>Workstation Sandbox & Execution Limits</span>
                </div>
                <p className="text-xs text-[#94A3B8]">
                  Configure process isolation, resource thresholds, and privilege boundaries.
                  OS sandbox-dependent execution fails closed with SANDBOX_UNAVAILABLE when the host OS lacks verified kernel isolation.
                </p>

                {deviceData && !deviceData.capabilities.includes("process.run") && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-950/20 p-3 text-xs text-amber-300">
                    <div className="font-semibold flex items-center gap-1.5">
                      <AlertCircle className="h-3.5 w-3.5" />
                      <span>Sandboxed Process / MCP Execution Unavailable</span>
                    </div>
                    <p className="text-[11px] text-amber-200/80 pt-1">
                      This workstation has not reported active OS sandbox availability for `process.run` or `mcp.invoke`. Unsandboxed fallback execution is strictly disabled.
                    </p>
                  </div>
                )}

                <div className="space-y-3 pt-1">
                  {/* Terminal Execution Toggle */}
                  <label className="flex items-center justify-between p-3 rounded-lg bg-[#07080B] border border-[#1E2536] cursor-pointer">
                    <div>
                      <div className="text-xs font-medium text-white flex items-center gap-1.5">
                        <Terminal className="h-3.5 w-3.5 text-indigo-400" />
                        <span>Terminal & Process Execution</span>
                      </div>
                      <div className="text-[11px] text-[#64748B] pt-0.5">
                        Allow agents to run commands (`process.run`) inside approved project roots.
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={terminalExecution}
                      onChange={(e) => setTerminalExecution(e.target.checked)}
                      className="h-4 w-4 rounded border-[#1E2536] text-indigo-600 focus:ring-0 bg-[#151822]"
                    />
                  </label>

                  {/* Resource Thresholds */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="p-3 rounded-lg bg-[#07080B] border border-[#1E2536] space-y-1">
                      <label className="text-[11px] text-[#64748B] block font-medium">
                        Max Memory (MB)
                      </label>
                      <input
                        type="number"
                        min="256"
                        max="8192"
                        value={maxMemoryMb}
                        onChange={(e) => setMaxMemoryMb(parseInt(e.target.value, 10) || 1024)}
                        className="w-full rounded bg-[#151822] border border-[#1E2536] px-2 py-1 text-xs text-white outline-none"
                      />
                    </div>
                    <div className="p-3 rounded-lg bg-[#07080B] border border-[#1E2536] space-y-1">
                      <label className="text-[11px] text-[#64748B] block font-medium">
                        Max Concurrent Processes
                      </label>
                      <input
                        type="number"
                        min="1"
                        max="20"
                        value={maxProcesses}
                        onChange={(e) => setMaxProcesses(parseInt(e.target.value, 10) || 5)}
                        className="w-full rounded bg-[#151822] border border-[#1E2536] px-2 py-1 text-xs text-white outline-none"
                      />
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Capabilities Grid */}
          <Card className="border-[#1E2536] bg-[#0E121B]">
            <CardContent className="p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                    <Sliders className="h-4 w-4 text-indigo-400" />
                    <span>Enabled Workstation Capabilities</span>
                  </h3>
                  <p className="text-xs text-[#94A3B8] pt-1">
                    Select which low-level system adapters are permitted on this workstation.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedCapabilities(ALL_CAPABILITIES.map((c) => c.key))}
                    className="text-xs text-indigo-400 hover:text-indigo-300 h-7"
                  >
                    Select All
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedCapabilities([])}
                    className="text-xs text-[#64748B] hover:text-white h-7"
                  >
                    Clear All
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {ALL_CAPABILITIES.map((cap) => {
                  const isChecked = selectedCapabilities.includes(cap.key);
                  return (
                    <div
                      key={cap.key}
                      onClick={() => toggleCapability(cap.key)}
                      className={`flex items-start gap-3 p-3 rounded-lg border transition-all cursor-pointer ${
                        isChecked
                          ? "border-indigo-500/40 bg-indigo-950/20 text-white"
                          : "border-[#1E2536] bg-[#07080B] text-[#94A3B8] hover:border-[#2D3748]"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => {}}
                        className="mt-0.5 h-3.5 w-3.5 rounded border-[#1E2536] text-indigo-600 focus:ring-0 bg-[#151822]"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium leading-none mb-1">{cap.label}</div>
                        <div className="font-mono text-[10px] text-[#64748B] truncate">{cap.key}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Local MCP Servers Section */}
          <Card className="border-[#1E2536] bg-[#0E121B]">
            <CardContent className="p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                    <Server className="h-4 w-4 text-indigo-400" />
                    <span>Local Stdio MCP Servers</span>
                  </h3>
                  <p className="text-xs text-[#94A3B8] pt-1">
                    Workstation-local tools managed directly by the Bridge daemon (e.g., git, sqlite, filesystem).
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={() => setShowAddMcpModal(true)}
                  className="bg-[#151822] hover:bg-[#1E2536] text-white text-xs h-8"
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  Register Local MCP
                </Button>
              </div>

              {localMcpServers.length === 0 ? (
                <div className="rounded-lg border border-dashed border-[#1E2536] p-6 text-center text-xs text-[#64748B]">
                  No local MCP stdio servers registered yet on this workstation.
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {localMcpServers.map((s) => (
                    <div
                      key={s.id}
                      className="p-3.5 rounded-lg border border-[#1E2536] bg-[#07080B] space-y-2"
                    >
                      <div className="flex items-center justify-between">
                        <div className="font-semibold text-xs text-white">{s.serverName}</div>
                        <Badge
                          variant="outline"
                          className={
                            s.status === "ACTIVE"
                              ? "border-emerald-500/30 bg-emerald-950/20 text-emerald-400 text-[10px]"
                              : "border-red-500/30 bg-red-950/20 text-red-400 text-[10px]"
                          }
                        >
                          {s.status}
                        </Badge>
                      </div>
                      <div className="font-mono text-[11px] text-indigo-300 truncate">
                        {s.command} {s.args?.join(" ")}
                      </div>
                      {s.tools && Array.isArray(s.tools) && (
                        <div className="text-[11px] text-[#64748B]">
                          {s.tools.length} discovered tools
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Recent Workstation Tasks History */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Terminal className="h-4 w-4 text-indigo-400" />
              <span>Recent Tasks & Live Executions ({tasks.length})</span>
            </h3>

            {tasks.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[#1E2536] p-8 text-center text-xs text-[#64748B] bg-[#0E121B]">
                No tasks executed on this workstation yet.
              </div>
            ) : (
              <div className="space-y-3">
                {tasks.map((t) => (
                  <BridgeTaskCard
                    key={t.id}
                    task={t as any}
                    onApprove={handleApproveTask}
                    onReject={handleRejectTask}
                  />
                ))}
              </div>
            )}
          </div>
        </main>
      </div>

      {/* Modal: Register Local MCP Server */}
      {showAddMcpModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-xl border border-[#1E2536] bg-[#0E121B] p-6 text-white space-y-4 shadow-2xl">
            <h3 className="text-base font-semibold text-white flex items-center gap-2">
              <Server className="h-4 w-4 text-indigo-400" />
              <span>Register Local MCP Server</span>
            </h3>
            <p className="text-xs text-[#94A3B8]">
              The Bridge daemon will spawn and manage this stdio MCP process inside the workstation sandbox.
            </p>

            <form onSubmit={handleRegisterMcp} className="space-y-3">
              <div>
                <label className="text-xs text-[#94A3B8] block mb-1">Server Name</label>
                <input
                  type="text"
                  placeholder="e.g. git-mcp"
                  value={mcpServerName}
                  onChange={(e) => setMcpServerName(e.target.value)}
                  required
                  className="w-full rounded-lg bg-[#07080B] border border-[#1E2536] px-3 py-1.5 text-xs text-white outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="text-xs text-[#94A3B8] block mb-1">Executable Command</label>
                <input
                  type="text"
                  placeholder="npx, python3, /usr/local/bin/my-server"
                  value={mcpCommand}
                  onChange={(e) => setMcpCommand(e.target.value)}
                  required
                  className="w-full rounded-lg bg-[#07080B] border border-[#1E2536] px-3 py-1.5 text-xs text-white outline-none focus:border-indigo-500 font-mono"
                />
              </div>

              <div>
                <label className="text-xs text-[#94A3B8] block mb-1">Arguments (Space-separated)</label>
                <input
                  type="text"
                  placeholder="-y @modelcontextprotocol/server-git"
                  value={mcpArgs}
                  onChange={(e) => setMcpArgs(e.target.value)}
                  className="w-full rounded-lg bg-[#07080B] border border-[#1E2536] px-3 py-1.5 text-xs text-white outline-none focus:border-indigo-500 font-mono"
                />
              </div>

              <div>
                <label className="text-xs text-[#94A3B8] block mb-1">Working Directory (Optional)</label>
                <input
                  type="text"
                  placeholder="/Users/dev/messiah-project"
                  value={mcpCwd}
                  onChange={(e) => setMcpCwd(e.target.value)}
                  className="w-full rounded-lg bg-[#07080B] border border-[#1E2536] px-3 py-1.5 text-xs text-white outline-none focus:border-indigo-500 font-mono"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowAddMcpModal(false)}
                  className="text-xs text-[#94A3B8] hover:text-white"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={isRegisteringMcp}
                  className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs px-4"
                >
                  {isRegisteringMcp ? "Registering..." : "Register Server"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default function DeviceCapabilitiesPage() {
  return (
    <Suspense fallback={<div className="flex h-screen items-center justify-center bg-[#07080B] text-xs text-[#94A3B8]">Loading device capabilities...</div>}>
      <DeviceCapabilitiesContent />
    </Suspense>
  );
}
