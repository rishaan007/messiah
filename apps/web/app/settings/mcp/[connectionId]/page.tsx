"use client";

import React, { useState, useEffect, useCallback, use } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Shield,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Code2,
  Lock,
  Activity,
  X,
  FileCode,
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
  McpToolDefinitionInfo,
  McpPermissionMode,
  McpTestConnectionResult,
} from "@messiah/shared";

interface PageProps {
  params: Promise<{ connectionId: string }>;
}

export default function McpConnectionDetailPage({ params }: PageProps) {
  const { connectionId } = use(params);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeTab] = useState("mcp");

  const [connection, setConnection] = useState<McpServerConnectionInfo | null>(null);
  const [tools, setTools] = useState<McpToolDefinitionInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Filter States
  const [searchQuery, setSearchQuery] = useState("");
  const [filterMode, setFilterMode] = useState<string>("ALL");

  // Expanded Schema Accordions (toolId -> boolean)
  const [expandedInputs, setExpandedInputs] = useState<Record<string, boolean>>({});
  const [expandedOutputs, setExpandedOutputs] = useState<Record<string, boolean>>({});

  // Action States
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<McpTestConnectionResult | null>(null);
  const [updatingToolId, setUpdatingToolId] = useState<string | null>(null);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

  // Load Connection and Tools
  const loadConnectionDetails = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        setErrorMessage("Please sign in to inspect MCP server connection.");
        setIsLoading(false);
        return;
      }

      const res = await fetch(`${apiUrl}/api/v1/mcp/connections/${connectionId}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (!res.ok) {
        const resData = await res.json();
        throw new Error(resData.error?.message || "Failed to load connection details.");
      }

      const data = await res.json();
      setConnection(data.data.connection);
      setTools(data.data.tools || []);
    } catch (err: unknown) {
      setErrorMessage((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  }, [apiUrl, connectionId]);

  useEffect(() => {
    loadConnectionDetails();
  }, [loadConnectionDetails]);

  // Refresh Discovery
  const handleRefreshDiscovery = async () => {
    setIsRefreshing(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) return;

      const res = await fetch(`${apiUrl}/api/v1/mcp/connections/${connectionId}/refresh`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      const resData = await res.json();
      if (!res.ok) {
        throw new Error(resData.error?.message || "Failed to refresh discovery.");
      }

      setConnection(resData.data.connection);
      setTools(resData.data.tools || []);
      setSuccessMessage(
        `Discovery refreshed successfully! Found ${resData.data.discoveredToolsCount} tools.`
      );
    } catch (err: unknown) {
      setErrorMessage((err as Error).message);
    } finally {
      setIsRefreshing(false);
    }
  };

  // Test Health
  const handleTestHealth = async () => {
    setIsTesting(true);
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

      setTestResult(resData.data);
    } catch (err: unknown) {
      setTestResult({ success: false, error: (err as Error).message });
    } finally {
      setIsTesting(false);
    }
  };

  // Update Tool Permission
  const handleUpdatePermission = async (
    toolId: string,
    mode: McpPermissionMode,
    requiresApproval: boolean
  ) => {
    setUpdatingToolId(toolId);
    setErrorMessage(null);

    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) return;

      const res = await fetch(
        `${apiUrl}/api/v1/mcp/tools/${toolId}/permission`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            permissionMode: mode,
            requiresApproval,
          }),
        }
      );

      const resData = await res.json();
      if (!res.ok) {
        throw new Error(resData.error?.message || "Failed to update tool permission.");
      }

      // Update in local state
      setTools((prev) =>
        prev.map((t) =>
          t.id === toolId
            ? {
                ...t,
                permission: resData.data,
              }
            : t
        )
      );

      setSuccessMessage(`Updated permission mode to '${mode}'.`);
    } catch (err: unknown) {
      setErrorMessage((err as Error).message);
    } finally {
      setUpdatingToolId(null);
    }
  };

  // Filter Tools
  const filteredTools = tools.filter((tool) => {
    const matchesSearch =
      tool.toolName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      tool.namespacedName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (tool.description && tool.description.toLowerCase().includes(searchQuery.toLowerCase()));

    const currentMode = tool.permission?.permissionMode || "REQUIRE_APPROVAL";
    const matchesFilter = filterMode === "ALL" || currentMode === filterMode;

    return matchesSearch && matchesFilter;
  });

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
            {/* Breadcrumb */}
            <div className="flex items-center gap-3 text-xs font-mono text-[#64748B]">
              <Link
                href="/settings/mcp"
                className="flex items-center gap-1.5 transition-colors hover:text-[#00F0FF]"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                <span>MCP Connections</span>
              </Link>
              <span>/</span>
              <span className="text-[#00F0FF]">
                {connection?.name || "Server Details"}
              </span>
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

            {/* Loading Skeleton */}
            {isLoading ? (
              <div className="flex h-64 items-center justify-center rounded-xl border border-[#1E2536] bg-[#12151E]/30">
                <div className="flex items-center gap-3 text-sm text-[#94A3B8]">
                  <RefreshCw className="h-5 w-5 animate-spin text-[#00F0FF]" />
                  <span>Loading server inspection details...</span>
                </div>
              </div>
            ) : !connection ? (
              <div className="p-8 text-center text-sm text-[#94A3B8]">
                Server connection not found.
              </div>
            ) : (
              <>
                {/* Server Header Card */}
                <Card className="border-[#1E2536] bg-[#12151E]/80 backdrop-blur-sm">
                  <CardContent className="p-6">
                    <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-3">
                          <h1 className="text-2xl font-bold text-[#F0F4FC]">
                            {connection.name}
                          </h1>

                          {/* Status */}
                          {connection.status === "CONNECTED" && (
                            <Badge className="border-[#00FFA3]/30 bg-[#00FFA3]/10 text-[#00FFA3]">
                              <StatusDot status="online" className="mr-1.5" />
                              CONNECTED
                            </Badge>
                          )}
                          {connection.status === "CONNECTING" && (
                            <Badge className="border-[#F59E0B]/30 bg-[#F59E0B]/10 text-[#F59E0B]">
                              <StatusDot status="busy" className="mr-1.5" />
                              CONNECTING
                            </Badge>
                          )}
                          {connection.status === "DISCONNECTED" && (
                            <Badge className="border-[#64748B]/30 bg-[#64748B]/10 text-[#94A3B8]">
                              <StatusDot status="offline" className="mr-1.5" />
                              DISCONNECTED
                            </Badge>
                          )}
                          {connection.status === "ERROR" && (
                            <Badge className="border-[#FF3366]/30 bg-[#FF3366]/10 text-[#FF3366]">
                              <StatusDot status="error" className="mr-1.5" />
                              ERROR
                            </Badge>
                          )}

                          <Badge variant="outline" className="font-mono text-xs text-[#00F0FF] border-[#00F0FF]/30">
                            {connection.transportType}
                          </Badge>

                          {connection.authenticationStatus !== "NONE" && (
                            <Badge variant="outline" className="font-mono text-xs text-[#A78BFA] border-[#A78BFA]/30">
                              <Lock className="mr-1 h-3 w-3 inline" />
                              {connection.authenticationStatus}
                            </Badge>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-[#94A3B8]">
                          <span>
                            Endpoint: <strong className="font-mono text-[#CBD5E1]">{connection.endpointUrl}</strong>
                          </span>
                          {connection.serverName && (
                            <span>
                              Server Implementation: <strong className="text-[#F0F4FC]">{connection.serverName}</strong> (v{connection.serverVersion || "unknown"})
                            </span>
                          )}
                          <span>
                            Protocol Version: <strong className="font-mono text-[#00F0FF]">{connection.protocolVersion || "2026-07-28"}</strong>
                          </span>
                        </div>
                      </div>

                      {/* Header Actions */}
                      <div className="flex flex-wrap items-center gap-3">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isRefreshing}
                          onClick={handleRefreshDiscovery}
                          className="border-[#1E2536] bg-[#090A0F] text-[#F0F4FC] hover:border-[#00F0FF] hover:text-[#00F0FF]"
                        >
                          <RefreshCw
                            className={`mr-1.5 h-3.5 w-3.5 ${
                              isRefreshing ? "animate-spin text-[#00F0FF]" : ""
                            }`}
                          />
                          Refresh Discovery
                        </Button>

                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isTesting}
                          onClick={handleTestHealth}
                          className="border-[#1E2536] bg-[#090A0F] text-[#94A3B8] hover:text-[#F0F4FC]"
                        >
                          <Activity
                            className={`mr-1.5 h-3.5 w-3.5 ${
                              isTesting ? "animate-pulse text-[#00FFA3]" : ""
                            }`}
                          />
                          Test Health
                        </Button>
                      </div>
                    </div>

                    {/* Health Test Live Banner */}
                    {testResult && (
                      <div
                        className={`mt-4 rounded-lg border p-3.5 text-xs font-mono ${
                          testResult.success
                            ? "border-[#00FFA3]/30 bg-[#00FFA3]/5 text-[#00FFA3]"
                            : "border-[#FF3366]/30 bg-[#FF3366]/5 text-[#FF3366]"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-semibold">
                            {testResult.success
                              ? `Health Probe OK — Roundtrip Latency: ${testResult.latencyMs}ms`
                              : "Health Probe Failed"}
                          </span>
                          <button
                            onClick={() => setTestResult(null)}
                            className="text-current opacity-70 hover:opacity-100"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        {testResult.success ? (
                          <p className="mt-1 text-[#94A3B8]">
                            Protocol: {testResult.protocolVersion} | Discovered Tools: {testResult.discoveredToolsCount} | Server: {testResult.serverName || "Ready"}
                          </p>
                        ) : (
                          <p className="mt-1">{testResult.error}</p>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Phase 3A Execution Warning Banner */}
                <div className="flex items-start gap-3 rounded-xl border border-[#00F0FF]/30 bg-[#00F0FF]/5 p-4 text-xs text-[#94A3B8]">
                  <Shield className="h-5 w-5 flex-shrink-0 text-[#00F0FF] mt-0.5" />
                  <div className="space-y-1">
                    <p className="font-semibold text-[#F0F4FC]">
                      Phase 3A Tool Discovery & Registry Notice
                    </p>
                    <p>
                      Tools discovered below are registered and validated in the workspace registry. Model-triggered execution is strictly disabled in Phase 3A and will be activated in Phase 3B. By default, all tools require explicit approval (<code className="font-mono text-[#00F0FF]">REQUIRE_APPROVAL</code>) to prevent unauthorized invocation.
                    </p>
                  </div>
                </div>

                {/* Tools Header & Filters */}
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between pt-2">
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-bold text-[#F0F4FC]">
                      Discovered Tools
                    </h2>
                    <Badge className="border-[#1E2536] bg-[#12151E] font-mono text-xs text-[#00F0FF]">
                      {tools.length} total
                    </Badge>
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <input
                      type="text"
                      placeholder="Filter tools by name..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="rounded-lg border border-[#1E2536] bg-[#12151E] px-3 py-1.5 text-xs text-[#F0F4FC] placeholder-[#64748B] focus:border-[#00F0FF] focus:outline-none"
                    />

                    <select
                      value={filterMode}
                      onChange={(e) => setFilterMode(e.target.value)}
                      className="rounded-lg border border-[#1E2536] bg-[#12151E] px-3 py-1.5 text-xs font-medium text-[#F0F4FC] focus:border-[#00F0FF] focus:outline-none"
                    >
                      <option value="ALL">All Permission Modes</option>
                      <option value="REQUIRE_APPROVAL">Require Approval</option>
                      <option value="READ_ONLY">Read Only</option>
                      <option value="EXPLICITLY_AUTHORIZED">Explicitly Authorized</option>
                      <option value="DISABLED">Disabled</option>
                    </select>
                  </div>
                </div>

                {/* Discovered Tools List */}
                {filteredTools.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-[#1E2536] bg-[#12151E]/30 p-12 text-center">
                    <p className="text-sm text-[#94A3B8]">
                      {tools.length === 0
                        ? "No tools discovered yet. Click 'Refresh Discovery' to query tools from this server."
                        : "No tools match the selected filters."}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {filteredTools.map((tool) => {
                      const isInputExpanded = !!expandedInputs[tool.id];
                      const isOutputExpanded = !!expandedOutputs[tool.id];
                      const isUpdating = updatingToolId === tool.id;
                      const currentMode = tool.permission?.permissionMode || "REQUIRE_APPROVAL";
                      const requiresApproval = tool.permission?.requiresApproval ?? true;

                      return (
                        <Card
                          key={tool.id}
                          className="border-[#1E2536] bg-[#12151E]/60 transition-colors hover:border-[#1E2536]/80"
                        >
                          <CardContent className="p-5 space-y-4">
                            {/* Tool Header & Permission Control */}
                            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                              <div className="space-y-1.5">
                                <div className="flex flex-wrap items-center gap-2.5">
                                  <span className="font-mono text-sm font-semibold text-[#00F0FF]">
                                    {tool.namespacedName}
                                  </span>

                                  {tool.isAvailable ? (
                                    <Badge className="border-[#00FFA3]/30 bg-[#00FFA3]/10 text-[10px] text-[#00FFA3]">
                                      Available
                                    </Badge>
                                  ) : (
                                    <Badge className="border-[#FF3366]/30 bg-[#FF3366]/10 text-[10px] text-[#FF3366]">
                                      Unavailable
                                    </Badge>
                                  )}

                                  <span className="font-mono text-[10px] text-[#64748B]">
                                    Hash: {tool.schemaHash.slice(0, 10)}...
                                  </span>
                                </div>

                                {tool.description ? (
                                  <p className="text-xs text-[#94A3B8] max-w-3xl">
                                    {tool.description}
                                  </p>
                                ) : (
                                  <p className="text-xs italic text-[#64748B]">
                                    No description provided by server.
                                  </p>
                                )}
                              </div>

                              {/* Permission Mode Selector */}
                              <div className="flex flex-wrap items-center gap-3">
                                <div className="flex items-center gap-2">
                                  <span className="text-[11px] font-semibold uppercase tracking-wider text-[#64748B]">
                                    Permission:
                                  </span>
                                  <select
                                    disabled={isUpdating}
                                    value={currentMode}
                                    onChange={(e) => {
                                      const newMode = e.target.value as McpPermissionMode;
                                      handleUpdatePermission(
                                        tool.id,
                                        newMode,
                                        newMode === "REQUIRE_APPROVAL" ? true : requiresApproval
                                      );
                                    }}
                                    className="rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-1.5 text-xs font-medium text-[#F0F4FC] focus:border-[#00F0FF] focus:outline-none"
                                  >
                                    <option value="REQUIRE_APPROVAL">Require Approval (Default)</option>
                                    <option value="READ_ONLY">Read-Only Operations</option>
                                    <option value="EXPLICITLY_AUTHORIZED">Explicitly Authorized</option>
                                    <option value="DISABLED">Disabled (Blocked)</option>
                                  </select>
                                </div>

                                {isUpdating && (
                                  <RefreshCw className="h-4 w-4 animate-spin text-[#00F0FF]" />
                                )}
                              </div>
                            </div>

                            {/* Schema Accordions */}
                            <div className="space-y-2 border-t border-[#1E2536]/60 pt-3">
                              {/* Input Schema Accordion */}
                              <div className="rounded-lg border border-[#1E2536]/80 bg-[#090A0F]/60 overflow-hidden">
                                <button
                                  type="button"
                                  onClick={() =>
                                    setExpandedInputs((prev) => ({
                                      ...prev,
                                      [tool.id]: !prev[tool.id],
                                    }))
                                  }
                                  className="flex w-full items-center justify-between px-3.5 py-2 text-xs font-mono text-[#94A3B8] hover:bg-[#12151E]/40"
                                >
                                  <div className="flex items-center gap-2">
                                    <Code2 className="h-3.5 w-3.5 text-[#00F0FF]" />
                                    <span>Input Schema (JSON Schema)</span>
                                  </div>
                                  {isInputExpanded ? (
                                    <ChevronDown className="h-3.5 w-3.5" />
                                  ) : (
                                    <ChevronRight className="h-3.5 w-3.5" />
                                  )}
                                </button>

                                {isInputExpanded && (
                                  <div className="border-t border-[#1E2536] p-3 text-[11px] font-mono text-[#CBD5E1] bg-[#06080C] overflow-x-auto">
                                    <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                                  </div>
                                )}
                              </div>

                              {/* Output Schema Accordion */}
                              {tool.outputSchema && (
                                <div className="rounded-lg border border-[#1E2536]/80 bg-[#090A0F]/60 overflow-hidden">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setExpandedOutputs((prev) => ({
                                        ...prev,
                                        [tool.id]: !prev[tool.id],
                                      }))
                                    }
                                    className="flex w-full items-center justify-between px-3.5 py-2 text-xs font-mono text-[#94A3B8] hover:bg-[#12151E]/40"
                                  >
                                    <div className="flex items-center gap-2">
                                      <FileCode className="h-3.5 w-3.5 text-[#00FFA3]" />
                                      <span>Output Schema</span>
                                    </div>
                                    {isOutputExpanded ? (
                                      <ChevronDown className="h-3.5 w-3.5" />
                                    ) : (
                                      <ChevronRight className="h-3.5 w-3.5" />
                                    )}
                                  </button>

                                  {isOutputExpanded && (
                                    <div className="border-t border-[#1E2536] p-3 text-[11px] font-mono text-[#CBD5E1] bg-[#06080C] overflow-x-auto">
                                      <pre>{JSON.stringify(tool.outputSchema, null, 2)}</pre>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </CardContent>
                        </Card>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
