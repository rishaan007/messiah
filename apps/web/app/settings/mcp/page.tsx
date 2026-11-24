"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  Cpu,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Trash2,
  Edit3,
  Shield,
  Layers,
  Eye,
  EyeOff,
  Plus,
  X,
  Lock,
  ArrowLeft,
  Activity,
  Globe,
  Sliders,
} from "lucide-react";
import {
  Button,
  Card,
  CardContent,
  Badge,
  StatusDot,
} from "@messiah/ui";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { createClient } from "@/lib/supabase/client";
import type {
  McpServerConnectionInfo,
  McpTransportType,
  McpAuthType,
  McpTestConnectionResult,
  WorkspaceInfo,
} from "@messiah/shared";

export default function McpSettingsPage() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeTab] = useState("mcp");

  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceInfo | null>(null);

  const [connections, setConnections] = useState<McpServerConnectionInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Modal States
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingConnectionId, setEditingConnectionId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [transportType, setTransportType] = useState<McpTransportType>("STREAMABLE_HTTP");
  const [authType, setAuthType] = useState<McpAuthType>("NONE");
  const [bearerToken, setBearerToken] = useState("");
  const [showBearerToken, setShowBearerToken] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  // Health Test & Probe States
  const [testingConnectionId, setTestingConnectionId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; result: McpTestConnectionResult } | null>(null);

  // Action States
  const [discoveringConnectionId, setDiscoveringConnectionId] = useState<string | null>(null);
  const [deletingConnection, setDeletingConnection] = useState<McpServerConnectionInfo | null>(null);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

  // 1. Load Initial Data (Session, Workspaces, Connections)
  const loadData = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        setErrorMessage("Please sign in to access MCP settings.");
        setIsLoading(false);
        return;
      }

      // Fetch Workspaces
      const wsRes = await fetch(`${apiUrl}/api/v1/workspaces`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (!wsRes.ok) {
        throw new Error(`Failed to fetch workspaces (${wsRes.status})`);
      }

      const wsData = await wsRes.json();
      const loadedWorkspaces: WorkspaceInfo[] = wsData.data || [];
      setWorkspaces(loadedWorkspaces);

      if (loadedWorkspaces.length > 0) {
        const primaryWorkspace = loadedWorkspaces[0]!;
        setActiveWorkspace(primaryWorkspace);

        // Fetch MCP Connections for primary workspace
        const connRes = await fetch(
          `${apiUrl}/api/v1/mcp/connections?workspaceId=${primaryWorkspace.id}`,
          {
            headers: { Authorization: `Bearer ${session.access_token}` },
          }
        );

        if (connRes.ok) {
          const connData = await connRes.json();
          setConnections(connData.data || []);
        } else {
          setConnections([]);
        }
      }
    } catch (err: unknown) {
      setErrorMessage((err as Error).message || "An unexpected error occurred.");
    } finally {
      setIsLoading(false);
    }
  }, [apiUrl]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Handle Workspace Switch
  const handleSelectWorkspace = async (ws: WorkspaceInfo) => {
    setActiveWorkspace(ws);
    setIsLoading(true);
    setErrorMessage(null);
    setTestResult(null);

    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) return;

      const connRes = await fetch(`${apiUrl}/api/v1/mcp/connections?workspaceId=${ws.id}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (connRes.ok) {
        const connData = await connRes.json();
        setConnections(connData.data || []);
      }
    } catch (err: unknown) {
      setErrorMessage((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  // Open Add Modal
  const handleOpenAddModal = () => {
    setEditingConnectionId(null);
    setName("");
    setEndpointUrl("");
    setTransportType("STREAMABLE_HTTP");
    setAuthType("NONE");
    setBearerToken("");
    setShowBearerToken(false);
    setModalError(null);
    setIsModalOpen(true);
  };

  // Open Edit Modal
  const handleOpenEditModal = (conn: McpServerConnectionInfo) => {
    setEditingConnectionId(conn.id);
    setName(conn.name);
    setEndpointUrl(conn.endpointUrl);
    setTransportType(conn.transportType);
    setAuthType(conn.authenticationStatus !== "NONE" ? "BEARER" : "NONE");
    setBearerToken("");
    setShowBearerToken(false);
    setModalError(null);
    setIsModalOpen(true);
  };

  // Submit Modal Form (Create or Update)
  const handleSubmitConnection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeWorkspace) return;

    if (!name.trim()) {
      setModalError("Server name is required.");
      return;
    }

    if (!endpointUrl.trim()) {
      setModalError("Endpoint URL is required.");
      return;
    }

    setIsSubmitting(true);
    setModalError(null);

    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        setModalError("Authentication session expired.");
        setIsSubmitting(false);
        return;
      }

      if (editingConnectionId) {
        // Update
        const payload: Record<string, unknown> = {
          name: name.trim(),
          endpointUrl: endpointUrl.trim(),
          transportType,
          authType,
        };
        if (bearerToken.trim()) {
          payload.bearerToken = bearerToken.trim();
        }

        const res = await fetch(`${apiUrl}/api/v1/mcp/connections/${editingConnectionId}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify(payload),
        });

        const resData = await res.json();
        if (!res.ok) {
          throw new Error(resData.error?.message || "Failed to update MCP connection.");
        }

        setSuccessMessage(`Updated MCP connection '${name}'.`);
      } else {
        // Create
        const payload: Record<string, unknown> = {
          workspaceId: activeWorkspace.id,
          name: name.trim(),
          endpointUrl: endpointUrl.trim(),
          transportType,
          authType,
        };
        if (authType === "BEARER" && bearerToken.trim()) {
          payload.bearerToken = bearerToken.trim();
        }

        const res = await fetch(`${apiUrl}/api/v1/mcp/connections`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify(payload),
        });

        const resData = await res.json();
        if (!res.ok) {
          throw new Error(resData.error?.message || "Failed to create MCP connection.");
        }

        setSuccessMessage(`Created MCP connection '${name}'.`);
      }

      setIsModalOpen(false);
      // Reload connections
      await handleSelectWorkspace(activeWorkspace);
    } catch (err: unknown) {
      setModalError((err as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Connect & Discover
  const handleConnectAndDiscover = async (connectionId: string) => {
    if (!activeWorkspace) return;
    setDiscoveringConnectionId(connectionId);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) return;

      const res = await fetch(`${apiUrl}/api/v1/mcp/connections/${connectionId}/connect`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      const resData = await res.json();
      if (!res.ok) {
        throw new Error(resData.error?.message || "Failed to connect to MCP server.");
      }

      setSuccessMessage(
        `Successfully connected! Discovered ${resData.data.discoveredToolsCount} tools.`
      );
      await handleSelectWorkspace(activeWorkspace);
    } catch (err: unknown) {
      setErrorMessage((err as Error).message);
      await handleSelectWorkspace(activeWorkspace);
    } finally {
      setDiscoveringConnectionId(null);
    }
  };

  // Test Connection
  const handleTestConnection = async (connectionId: string) => {
    setTestingConnectionId(connectionId);
    setTestResult(null);

    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) return;

      const res = await fetch(`${apiUrl}/api/v1/mcp/connections/${connectionId}/test`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      const resData = await res.json();
      if (!res.ok) {
        throw new Error(resData.error?.message || "Health test failed.");
      }

      setTestResult({ id: connectionId, result: resData.data });
    } catch (err: unknown) {
      setTestResult({
        id: connectionId,
        result: { success: false, error: (err as Error).message },
      });
    } finally {
      setTestingConnectionId(null);
    }
  };

  // Delete Connection
  const handleDeleteConnection = async () => {
    if (!deletingConnection || !activeWorkspace) return;

    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) return;

      const res = await fetch(
        `${apiUrl}/api/v1/mcp/connections/${deletingConnection.id}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${session.access_token}` },
        }
      );

      if (!res.ok) {
        const resData = await res.json();
        throw new Error(resData.error?.message || "Failed to delete connection.");
      }

      setSuccessMessage(`Removed connection '${deletingConnection.name}'.`);
      setDeletingConnection(null);
      await handleSelectWorkspace(activeWorkspace);
    } catch (err: unknown) {
      setErrorMessage((err as Error).message);
    }
  };

  const totalConnected = connections.filter((c) => c.status === "CONNECTED").length;
  const totalDiscoveredTools = connections.reduce((acc, c) => acc + (c.toolCount || 0), 0);

  return (
    <div className="flex min-h-screen bg-[#090A0F] text-[#F0F4FC]">
      <Sidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        activeTab={activeTab}
        onSelectTab={() => {}}
      />

      <div className="flex flex-1 flex-col">
        <Header onToggleSidebar={() => setSidebarOpen(true)} />

        <main className="flex-1 p-6 md:p-8">
          <div className="mx-auto max-w-7xl space-y-6">
            {/* Breadcrumb & Navigation */}
            <div className="flex items-center gap-3 text-xs font-mono text-[#64748B]">
              <Link
                href="/settings/integrations"
                className="flex items-center gap-1.5 transition-colors hover:text-[#00F0FF]"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                <span>Settings</span>
              </Link>
              <span>/</span>
              <span className="text-[#00F0FF]">Model Context Protocol (MCP)</span>
            </div>

            {/* Header Title & Actions */}
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h1 className="text-2xl font-bold tracking-tight text-[#F0F4FC] md:text-3xl">
                  MCP Connection Center
                </h1>
                <p className="mt-1 text-sm text-[#94A3B8]">
                  Connect external Model Context Protocol (2026-07-28) servers to discover tools and configure enterprise permissions.
                </p>
              </div>

              <div className="flex items-center gap-3">
                {workspaces.length > 1 && (
                  <select
                    className="rounded-lg border border-[#1E2536] bg-[#12151E] px-3 py-2 text-xs font-medium text-[#F0F4FC] focus:border-[#00F0FF] focus:outline-none"
                    value={activeWorkspace?.id || ""}
                    onChange={(e) => {
                      const ws = workspaces.find((w) => w.id === e.target.value);
                      if (ws) handleSelectWorkspace(ws);
                    }}
                  >
                    {workspaces.map((w) => (
                      <option key={w.id} value={w.id}>
                        Workspace: {w.name}
                      </option>
                    ))}
                  </select>
                )}

                <Button
                  onClick={handleOpenAddModal}
                  className="bg-[#00F0FF] text-[#090A0F] hover:bg-[#00D0DF] font-semibold"
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Connect MCP Server
                </Button>
              </div>
            </div>

            {/* Notification Banners */}
            {errorMessage && (
              <div className="flex items-center gap-3 rounded-lg border border-[#FF3366]/40 bg-[#FF3366]/10 p-4 text-sm text-[#FF3366]">
                <AlertCircle className="h-5 w-5 flex-shrink-0" />
                <span className="flex-1">{errorMessage}</span>
                <button
                  onClick={() => setErrorMessage(null)}
                  className="text-[#FF3366] hover:opacity-80"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}

            {successMessage && (
              <div className="flex items-center gap-3 rounded-lg border border-[#00FFA3]/40 bg-[#00FFA3]/10 p-4 text-sm text-[#00FFA3]">
                <CheckCircle2 className="h-5 w-5 flex-shrink-0" />
                <span className="flex-1">{successMessage}</span>
                <button
                  onClick={() => setSuccessMessage(null)}
                  className="text-[#00FFA3] hover:opacity-80"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}

            {/* Summary Metrics */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Card className="border-[#1E2536] bg-[#12151E]/60 backdrop-blur-sm">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-xs font-mono uppercase tracking-wider text-[#64748B]">
                        Active Servers
                      </span>
                      <p className="mt-1 text-2xl font-bold text-[#F0F4FC]">
                        {totalConnected} / {connections.length}
                      </p>
                    </div>
                    <div className="rounded-lg bg-[#00F0FF]/10 p-2.5 text-[#00F0FF]">
                      <Globe className="h-5 w-5" />
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-[#1E2536] bg-[#12151E]/60 backdrop-blur-sm">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-xs font-mono uppercase tracking-wider text-[#64748B]">
                        Discovered Tools
                      </span>
                      <p className="mt-1 text-2xl font-bold text-[#F0F4FC]">
                        {totalDiscoveredTools}
                      </p>
                    </div>
                    <div className="rounded-lg bg-[#00FFA3]/10 p-2.5 text-[#00FFA3]">
                      <Layers className="h-5 w-5" />
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-[#1E2536] bg-[#12151E]/60 backdrop-blur-sm">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-xs font-mono uppercase tracking-wider text-[#64748B]">
                        Security & Protocol
                      </span>
                      <p className="mt-1 text-sm font-semibold text-[#00F0FF]">
                        2026-07-28 • Deny-by-Default
                      </p>
                    </div>
                    <div className="rounded-lg bg-[#64748B]/10 p-2.5 text-[#64748B]">
                      <Shield className="h-5 w-5" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Connections List / Empty State */}
            {isLoading ? (
              <div className="flex h-64 items-center justify-center rounded-xl border border-[#1E2536] bg-[#12151E]/30">
                <div className="flex items-center gap-3 text-sm text-[#94A3B8]">
                  <RefreshCw className="h-5 w-5 animate-spin text-[#00F0FF]" />
                  <span>Loading MCP connections...</span>
                </div>
              </div>
            ) : connections.length === 0 ? (
              <Card className="border-dashed border-[#1E2536] bg-[#12151E]/30 py-16 text-center">
                <CardContent className="flex flex-col items-center justify-center space-y-4">
                  <div className="rounded-full bg-[#1E2536]/80 p-4 text-[#00F0FF]">
                    <Cpu className="h-8 w-8" />
                  </div>
                  <div className="max-w-md space-y-1">
                    <h3 className="text-lg font-semibold text-[#F0F4FC]">
                      No MCP Servers Connected
                    </h3>
                    <p className="text-xs text-[#94A3B8]">
                      Model Context Protocol (MCP) allows your Messiah agents to safely connect with internal microservices, database inspectors, and external APIs.
                    </p>
                  </div>
                  <Button
                    onClick={handleOpenAddModal}
                    className="mt-2 bg-[#00F0FF] text-[#090A0F] hover:bg-[#00D0DF] font-semibold"
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Connect Your First Server
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-4">
                {connections.map((conn) => {
                  const isTesting = testingConnectionId === conn.id;
                  const isDiscovering = discoveringConnectionId === conn.id;
                  const currentTest = testResult?.id === conn.id ? testResult.result : null;

                  return (
                    <Card
                      key={conn.id}
                      className="border-[#1E2536] bg-[#12151E]/70 transition-colors hover:border-[#1E2536]/80"
                    >
                      <CardContent className="p-5">
                        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                          {/* Left: Info */}
                          <div className="space-y-2">
                            <div className="flex flex-wrap items-center gap-2.5">
                              <h3 className="text-base font-semibold text-[#F0F4FC]">
                                {conn.name}
                              </h3>

                              {/* Status Badge */}
                              {conn.status === "CONNECTED" && (
                                <Badge className="border-[#00FFA3]/30 bg-[#00FFA3]/10 text-[#00FFA3]">
                                  <StatusDot status="online" className="mr-1.5" />
                                  CONNECTED
                                </Badge>
                              )}
                              {conn.status === "CONNECTING" && (
                                <Badge className="border-[#F59E0B]/30 bg-[#F59E0B]/10 text-[#F59E0B]">
                                  <StatusDot status="busy" className="mr-1.5" />
                                  CONNECTING
                                </Badge>
                              )}
                              {conn.status === "DISCONNECTED" && (
                                <Badge className="border-[#64748B]/30 bg-[#64748B]/10 text-[#94A3B8]">
                                  <StatusDot status="offline" className="mr-1.5" />
                                  DISCONNECTED
                                </Badge>
                              )}
                              {conn.status === "ERROR" && (
                                <Badge className="border-[#FF3366]/30 bg-[#FF3366]/10 text-[#FF3366]">
                                  <StatusDot status="error" className="mr-1.5" />
                                  ERROR
                                </Badge>
                              )}

                              {/* Transport Badge */}
                              <Badge variant="outline" className="font-mono text-[10px] text-[#00F0FF] border-[#00F0FF]/30">
                                {conn.transportType}
                              </Badge>

                              {/* Auth Badge */}
                              {conn.authenticationStatus !== "NONE" && (
                                <Badge variant="outline" className="font-mono text-[10px] text-[#A78BFA] border-[#A78BFA]/30">
                                  <Lock className="mr-1 h-2.5 w-2.5 inline" />
                                  {conn.authenticationStatus}
                                </Badge>
                              )}
                            </div>

                            {/* Endpoint URL & Server Info */}
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#94A3B8]">
                              <span className="font-mono text-[#CBD5E1]">
                                {conn.endpointUrl}
                              </span>
                              {conn.serverName && (
                                <span>
                                  Server: <strong className="text-[#F0F4FC]">{conn.serverName}</strong> (v{conn.serverVersion || "unknown"})
                                </span>
                              )}
                              {conn.protocolVersion && (
                                <span className="font-mono text-[#64748B]">
                                  MCP {conn.protocolVersion}
                                </span>
                              )}
                            </div>

                            {/* Meta & Timestamps */}
                            <div className="flex flex-wrap items-center gap-x-4 text-[11px] text-[#64748B]">
                              <span>
                                Discovered Tools:{" "}
                                <strong className="text-[#00FFA3]">
                                  {conn.toolCount || 0}
                                </strong>
                              </span>
                              {conn.lastConnectedAt && (
                                <span>
                                  Connected: {new Date(conn.lastConnectedAt).toLocaleString()}
                                </span>
                              )}
                              {conn.lastErrorCode && (
                                <span className="text-[#FF3366]">
                                  Error: {conn.lastErrorCode}
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Right: Actions */}
                          <div className="flex flex-wrap items-center gap-2">
                            {/* Connect & Discover */}
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={isDiscovering}
                              onClick={() => handleConnectAndDiscover(conn.id)}
                              className="border-[#1E2536] bg-[#090A0F] text-[#F0F4FC] hover:border-[#00F0FF] hover:text-[#00F0FF]"
                            >
                              <RefreshCw
                                className={`mr-1.5 h-3.5 w-3.5 ${
                                  isDiscovering ? "animate-spin text-[#00F0FF]" : ""
                                }`}
                              />
                              {conn.status === "CONNECTED" ? "Refresh" : "Connect & Discover"}
                            </Button>

                            {/* Health Test */}
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={isTesting}
                              onClick={() => handleTestConnection(conn.id)}
                              className="border-[#1E2536] bg-[#090A0F] text-[#94A3B8] hover:text-[#F0F4FC]"
                            >
                              <Activity
                                className={`mr-1.5 h-3.5 w-3.5 ${
                                  isTesting ? "animate-pulse text-[#00FFA3]" : ""
                                }`}
                              />
                              Test Health
                            </Button>

                            {/* Inspect Tools Link */}
                            <Link href={`/settings/mcp/${conn.id}`}>
                              <Button
                                size="sm"
                                className="bg-[#1E2536] text-[#F0F4FC] hover:bg-[#2A344A]"
                              >
                                <Sliders className="mr-1.5 h-3.5 w-3.5 text-[#00F0FF]" />
                                Inspect Tools ({conn.toolCount || 0})
                              </Button>
                            </Link>

                            {/* Edit */}
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleOpenEditModal(conn)}
                              className="border-[#1E2536] bg-[#090A0F] text-[#94A3B8] hover:text-[#F0F4FC]"
                            >
                              <Edit3 className="h-3.5 w-3.5" />
                            </Button>

                            {/* Delete */}
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setDeletingConnection(conn)}
                              className="border-[#1E2536] bg-[#090A0F] text-[#94A3B8] hover:border-[#FF3366] hover:text-[#FF3366]"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>

                        {/* Health Test Live Output Banner */}
                        {currentTest && (
                          <div
                            className={`mt-3 rounded-lg border p-3 text-xs font-mono ${
                              currentTest.success
                                ? "border-[#00FFA3]/30 bg-[#00FFA3]/5 text-[#00FFA3]"
                                : "border-[#FF3366]/30 bg-[#FF3366]/5 text-[#FF3366]"
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-semibold">
                                {currentTest.success
                                  ? `Health Probe OK (${currentTest.latencyMs}ms)`
                                  : "Health Probe Failed"}
                              </span>
                              <button
                                onClick={() => setTestResult(null)}
                                className="text-current opacity-70 hover:opacity-100"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </div>
                            {currentTest.success ? (
                              <p className="mt-1 text-[#94A3B8]">
                                Protocol: {currentTest.protocolVersion} | Tools Found: {currentTest.discoveredToolsCount} | Server: {currentTest.serverName || "Ready"}
                              </p>
                            ) : (
                              <p className="mt-1">{currentTest.error}</p>
                            )}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>
        </main>
      </div>

      {/* Add / Edit Connection Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-xl border border-[#1E2536] bg-[#0F121B] shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between border-b border-[#1E2536] px-6 py-4">
              <div className="flex items-center gap-2.5">
                <div className="rounded-md bg-[#00F0FF]/10 p-2 text-[#00F0FF]">
                  <Cpu className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-[#F0F4FC]">
                    {editingConnectionId ? "Edit MCP Server Connection" : "Connect Remote MCP Server"}
                  </h3>
                  <p className="text-xs text-[#64748B]">
                    Model Context Protocol 2026-07-28 Remote Transport
                  </p>
                </div>
              </div>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-[#64748B] hover:text-[#F0F4FC]"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSubmitConnection} className="p-6 space-y-4">
              {modalError && (
                <div className="rounded-lg border border-[#FF3366]/40 bg-[#FF3366]/10 p-3 text-xs text-[#FF3366]">
                  {modalError}
                </div>
              )}

              {/* Name */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[#94A3B8] mb-1.5">
                  Connection Name
                </label>
                <input
                  type="text"
                  placeholder="e.g. Analytics MCP Server"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-lg border border-[#1E2536] bg-[#12151E] px-3.5 py-2.5 text-sm text-[#F0F4FC] placeholder-[#64748B] focus:border-[#00F0FF] focus:outline-none"
                  required
                />
              </div>

              {/* Endpoint URL */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[#94A3B8] mb-1.5">
                  Remote Endpoint URL
                </label>
                <input
                  type="url"
                  placeholder="https://mcp.internal.acme.com/mcp"
                  value={endpointUrl}
                  onChange={(e) => setEndpointUrl(e.target.value)}
                  className="w-full rounded-lg border border-[#1E2536] bg-[#12151E] px-3.5 py-2.5 text-sm font-mono text-[#F0F4FC] placeholder-[#64748B] focus:border-[#00F0FF] focus:outline-none"
                  required
                />
                <p className="mt-1.5 text-[11px] text-[#64748B]">
                  Enterprise SSRF Defense: Private IPv4/IPv6, loopback (127.0.0.1), and cloud metadata (169.254.169.254) are strictly blocked in production.
                </p>
              </div>

              {/* Transport Type */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-[#94A3B8] mb-1.5">
                    Transport Type
                  </label>
                  <select
                    value={transportType}
                    onChange={(e) => setTransportType(e.target.value as McpTransportType)}
                    className="w-full rounded-lg border border-[#1E2536] bg-[#12151E] px-3 py-2 text-xs font-medium text-[#F0F4FC] focus:border-[#00F0FF] focus:outline-none"
                  >
                    <option value="STREAMABLE_HTTP">Streamable HTTP (Modern)</option>
                    <option value="SSE">SSE (Legacy Fallback)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-[#94A3B8] mb-1.5">
                    Authentication
                  </label>
                  <select
                    value={authType}
                    onChange={(e) => setAuthType(e.target.value as McpAuthType)}
                    className="w-full rounded-lg border border-[#1E2536] bg-[#12151E] px-3 py-2 text-xs font-medium text-[#F0F4FC] focus:border-[#00F0FF] focus:outline-none"
                  >
                    <option value="NONE">None (Public / Internal)</option>
                    <option value="BEARER">Bearer Token (Vault v2)</option>
                    <option value="OAUTH">OAuth 2.0 (RFC 9728)</option>
                  </select>
                </div>
              </div>

              {/* Bearer Token */}
              {authType === "BEARER" && (
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-[#94A3B8] mb-1.5">
                    Bearer Token / API Key
                  </label>
                  <div className="relative">
                    <input
                      type={showBearerToken ? "text" : "password"}
                      placeholder={
                        editingConnectionId
                          ? "Leave blank to keep existing encrypted token"
                          : "Enter Bearer token"
                      }
                      value={bearerToken}
                      onChange={(e) => setBearerToken(e.target.value)}
                      className="w-full rounded-lg border border-[#1E2536] bg-[#12151E] px-3.5 py-2.5 pr-10 text-sm font-mono text-[#F0F4FC] placeholder-[#64748B] focus:border-[#00F0FF] focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setShowBearerToken(!showBearerToken)}
                      className="absolute right-3 top-3 text-[#64748B] hover:text-[#F0F4FC]"
                    >
                      {showBearerToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  <p className="mt-1 text-[11px] text-[#64748B]">
                    Encrypted with AES-256-GCM v2 AAD cryptographically bound to this workspace and connection.
                  </p>
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-4 border-t border-[#1E2536]">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsModalOpen(false)}
                  className="border-[#1E2536] bg-transparent text-[#94A3B8] hover:text-[#F0F4FC]"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={isSubmitting}
                  className="bg-[#00F0FF] text-[#090A0F] hover:bg-[#00D0DF] font-semibold"
                >
                  {isSubmitting ? (
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                  )}
                  {editingConnectionId ? "Update Connection" : "Save & Register"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      {deletingConnection && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-xl border border-[#FF3366]/40 bg-[#0F121B] p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3 text-[#FF3366]">
              <AlertCircle className="h-6 w-6" />
              <h3 className="text-lg font-semibold text-[#F0F4FC]">
                Remove MCP Connection
              </h3>
            </div>
            <p className="text-sm text-[#94A3B8]">
              Are you sure you want to disconnect and delete{" "}
              <strong className="text-[#F0F4FC]">{deletingConnection.name}</strong>?
              Discovered tools and configured permissions will be permanently removed.
            </p>
            <div className="flex items-center justify-end gap-3 pt-2">
              <Button
                variant="outline"
                onClick={() => setDeletingConnection(null)}
                className="border-[#1E2536] bg-transparent text-[#94A3B8] hover:text-[#F0F4FC]"
              >
                Cancel
              </Button>
              <Button
                onClick={handleDeleteConnection}
                className="bg-[#FF3366] text-[#F0F4FC] hover:bg-[#E02454] font-semibold"
              >
                Delete Server
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
