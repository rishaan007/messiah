"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  Key,
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
} from "lucide-react";
import {
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Badge,
  StatusDot,
} from "@messiah/ui";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { createClient } from "@/lib/supabase/client";
import type {
  ProviderMetadataInfo,
  ProviderConnectionInfo,
  ModelInfo,
  WorkspaceInfo,
  SupportedProviderId,
} from "@messiah/shared";

export default function IntegrationsPage() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("settings");

  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceInfo | null>(null);

  const [providers, setProviders] = useState<ProviderMetadataInfo[]>([]);
  const [connections, setConnections] = useState<ProviderConnectionInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Modal States
  const [connectModalProvider, setConnectModalProvider] = useState<SupportedProviderId | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  // Action States
  const [testingConnectionId, setTestingConnectionId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; message: string; success: boolean } | null>(null);

  // Rename States
  const [renamingConnection, setRenamingConnection] = useState<ProviderConnectionInfo | null>(null);
  const [newDisplayName, setNewDisplayName] = useState("");

  // Remove States
  const [deletingConnection, setDeletingConnection] = useState<ProviderConnectionInfo | null>(null);

  // Models Drawer States
  const [viewingModelsProvider, setViewingModelsProvider] = useState<SupportedProviderId | null>(null);
  const [modelsList, setModelsList] = useState<ModelInfo[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

  // 1. Load Initial Data (Session, Workspaces, Providers)
  const loadData = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        setErrorMessage("Please sign in to access integrations.");
        setIsLoading(false);
        return;
      }

      // Fetch Workspaces
      const wsRes = await fetch(`${apiUrl}/api/v1/workspaces`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!wsRes.ok) throw new Error("Failed to load workspaces.");
      const wsData: WorkspaceInfo[] = await wsRes.json();
      setWorkspaces(wsData);

      const targetWorkspace = activeWorkspace || (wsData.length > 0 ? wsData[0] : null);
      if (targetWorkspace) {
        setActiveWorkspace(targetWorkspace);

        // Fetch Providers
        const provRes = await fetch(`${apiUrl}/api/v1/providers`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (provRes.ok) {
          const provJson = await provRes.json();
          setProviders(provJson.data || []);
        }

        // Fetch Connections for Active Workspace
        const connRes = await fetch(
          `${apiUrl}/api/v1/provider-connections?workspaceId=${targetWorkspace.id}`,
          {
            headers: { Authorization: `Bearer ${session.access_token}` },
          }
        );
        if (connRes.ok) {
          const connJson = await connRes.json();
          setConnections(connJson.data || []);
        }
      }
    } catch (err: unknown) {
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to communicate with Messiah API."
      );
    } finally {
      setIsLoading(false);
    }
  }, [activeWorkspace, apiUrl]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Handle Connect Provider Form Submit
  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!connectModalProvider || !activeWorkspace) return;

    setIsValidating(true);
    setModalError(null);

    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Authentication expired.");

      const res = await fetch(`${apiUrl}/api/v1/provider-connections`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          workspaceId: activeWorkspace.id,
          provider: connectModalProvider,
          displayName: displayName.trim() || `${connectModalProvider.toUpperCase()} Connection`,
          apiKey: apiKey.trim(),
        }),
      });

      const body = await res.json();

      if (!res.ok) {
        throw new Error(body.error?.message || "Validation failed for provider key.");
      }

      // Success: Close modal, reset state, reload connections
      setConnectModalProvider(null);
      setApiKey("");
      setDisplayName("");
      await loadData();
    } catch (err: unknown) {
      setModalError(
        err instanceof Error ? err.message : "Failed to validate credentials."
      );
    } finally {
      setIsValidating(false);
    }
  };

  // Handle Test Connection
  const handleTestConnection = async (connId: string) => {
    if (!activeWorkspace) return;
    setTestingConnectionId(connId);
    setTestResult(null);

    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) return;

      const res = await fetch(`${apiUrl}/api/v1/provider-connections/${connId}/test`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ workspaceId: activeWorkspace.id }),
      });

      const body = await res.json();
      if (res.ok && body.success) {
        setTestResult({
          id: connId,
          success: true,
          message: body.data.message || "Connection validated successfully.",
        });
        await loadData();
      } else {
        setTestResult({
          id: connId,
          success: false,
          message: body.error?.message || "Connection validation failed.",
        });
      }
    } catch {
      setTestResult({
        id: connId,
        success: false,
        message: "Failed to connect to backend server.",
      });
    } finally {
      setTestingConnectionId(null);
    }
  };

  // Handle Rename Connection
  const handleRename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renamingConnection || !activeWorkspace || !newDisplayName.trim()) return;

    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) return;

      const res = await fetch(
        `${apiUrl}/api/v1/provider-connections/${renamingConnection.id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            workspaceId: activeWorkspace.id,
            displayName: newDisplayName.trim(),
          }),
        }
      );

      if (res.ok) {
        setRenamingConnection(null);
        setNewDisplayName("");
        await loadData();
      }
    } catch {
      // Handle error
    }
  };

  // Handle Remove Connection
  const handleRemove = async () => {
    if (!deletingConnection || !activeWorkspace) return;

    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) return;

      const res = await fetch(
        `${apiUrl}/api/v1/provider-connections/${deletingConnection.id}?workspaceId=${activeWorkspace.id}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${session.access_token}` },
        }
      );

      if (res.ok) {
        setDeletingConnection(null);
        await loadData();
      }
    } catch {
      // Handle error
    }
  };

  // Handle View Models
  const handleViewModels = async (providerId: SupportedProviderId) => {
    if (!activeWorkspace) return;
    setViewingModelsProvider(providerId);
    setIsLoadingModels(true);
    setModelsList([]);

    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) return;

      const res = await fetch(
        `${apiUrl}/api/v1/providers/${providerId}/models?workspaceId=${activeWorkspace.id}`,
        {
          headers: { Authorization: `Bearer ${session.access_token}` },
        }
      );

      const body = await res.json();
      if (res.ok && body.success) {
        setModelsList(body.data || []);
      }
    } catch {
      // Handle error
    } finally {
      setIsLoadingModels(false);
    }
  };

  const isAuthorizedRole =
    activeWorkspace?.role === "OWNER" || activeWorkspace?.role === "ADMIN";

  return (
    <div className="flex h-screen flex-col bg-[#090A0F] text-[#F0F4FC]">
      <Header onToggleSidebar={() => setSidebarOpen((prev) => !prev)} />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          activeTab={activeTab}
          onSelectTab={setActiveTab}
        />

        <main className="flex-1 overflow-y-auto p-4 md:p-8">
          <div className="mx-auto max-w-6xl space-y-8">
            {/* Breadcrumb & Navigation */}
            <div className="flex items-center gap-2 text-xs font-mono text-[#64748B]">
              <Link href="/" className="hover:text-[#00F0FF] flex items-center gap-1">
                <ArrowLeft className="h-3 w-3" />
                Command Center
              </Link>
              <span>/</span>
              <span className="text-[#94A3B8]">Workspace Settings</span>
              <span>/</span>
              <span className="text-[#00F0FF]">AI Integrations</span>
            </div>

            {/* Page Header */}
            <div className="flex flex-col justify-between gap-4 border-b border-[#1E2536] pb-6 sm:flex-row sm:items-center">
              <div>
                <div className="flex items-center gap-2.5 mb-1">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#00F0FF]/10 text-[#00F0FF] border border-[#00F0FF]/20">
                    <Key className="h-4 w-4" />
                  </div>
                  <h1 className="text-xl md:text-2xl font-bold tracking-tight text-[#F0F4FC]">
                    AI Provider Connectors & Vault
                  </h1>
                  <Badge variant="cyan">Phase 2A</Badge>
                </div>
                <p className="text-xs text-[#94A3B8]">
                  Zero-knowledge credential vault with AES-256-GCM envelope encryption and non-generation metadata validation.
                </p>
              </div>

              {/* Workspace Selector */}
              {workspaces.length > 0 && activeWorkspace && (
                <div className="flex items-center gap-2 rounded-lg border border-[#1E2536] bg-[#12151E] p-1.5">
                  <span className="text-[11px] font-mono text-[#64748B] pl-2">
                    Scope:
                  </span>
                  <select
                    value={activeWorkspace.id}
                    onChange={(e) => {
                      const selected = workspaces.find((w) => w.id === e.target.value);
                      if (selected) setActiveWorkspace(selected);
                    }}
                    className="bg-[#0E111A] border border-[#1E2536] text-xs font-medium text-[#F0F4FC] rounded px-2.5 py-1 focus:border-[#00F0FF] focus:outline-none"
                  >
                    {workspaces.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name} ({w.role})
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {/* Security Architecture Banner */}
            <div className="rounded-xl border border-[#00FFA3]/20 bg-[#00FFA3]/5 p-4 text-xs text-[#94A3B8] flex items-start gap-3">
              <Shield className="h-5 w-5 text-[#00FFA3] shrink-0 mt-0.5" />
              <div className="space-y-1">
                <span className="font-semibold text-[#F0F4FC] font-mono">
                  AES-256-GCM Vault Active & Non-Billable Validation
                </span>
                <p className="leading-relaxed">
                  Submitted provider keys are tested against models-metadata endpoints before encryption. API keys are never stored in plaintext, never persisted in browser storage, and never returned to the frontend.
                </p>
              </div>
            </div>

            {/* Role Limitation Notice if not OWNER or ADMIN */}
            {!isAuthorizedRole && (
              <div className="rounded-xl border border-[#FFB800]/20 bg-[#FFB800]/5 p-4 text-xs text-[#FFB800] flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>
                  You are viewing this workspace as a <strong>{activeWorkspace?.role}</strong>. Only Workspace Owners and Admins can connect or modify provider credentials.
                </span>
              </div>
            )}

            {/* Global Error Notice */}
            {errorMessage && (
              <div className="rounded-xl border border-[#FF3366]/30 bg-[#FF3366]/10 p-4 text-xs text-[#FF3366] flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{errorMessage}</span>
              </div>
            )}

            {/* Provider Cards Section */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-mono uppercase tracking-wider text-[#64748B]">
                  Official Intelligence Providers ({providers.length})
                </h2>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={loadData}
                  isLoading={isLoading}
                  className="font-mono text-xs"
                >
                  <RefreshCw className="h-3 w-3 mr-1" />
                  Refresh
                </Button>
              </div>

              <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
                {providers.map((prov) => {
                  const conn = connections.find((c) => c.provider === prov.id);
                  const isConnected = !!conn;
                  const isTesting = testingConnectionId === conn?.id;

                  return (
                    <Card
                      key={prov.id}
                      className={`flex flex-col justify-between transition-all ${
                        isConnected
                          ? "border-[#00F0FF]/30 bg-[#0E111A]"
                          : "border-[#1E2536] bg-[#0E111A]/60"
                      }`}
                    >
                      <CardHeader className="pb-3">
                        <div className="flex items-start justify-between">
                          <div className="space-y-1">
                            <CardTitle className="text-base font-semibold text-[#F0F4FC] flex items-center gap-2">
                              <span>{prov.name}</span>
                              {isConnected && (
                                <StatusDot
                                  status={
                                    conn.status === "ACTIVE"
                                      ? "online"
                                      : conn.status === "INVALID"
                                        ? "error"
                                        : "busy"
                                  }
                                  pulse={conn.status === "ACTIVE"}
                                />
                              )}
                            </CardTitle>
                            <CardDescription className="text-xs text-[#94A3B8] line-clamp-2">
                              {prov.description}
                            </CardDescription>
                          </div>
                        </div>
                      </CardHeader>

                      <CardContent className="space-y-4 flex-1">
                        {/* Capabilities Grid */}
                        <div className="space-y-1.5 pt-1 border-t border-[#1E2536]">
                          <span className="text-[10px] font-mono uppercase text-[#64748B]">
                            Capabilities:
                          </span>
                          <div className="flex flex-wrap gap-1">
                            <span className="rounded bg-[#1E2536] px-1.5 py-0.5 text-[10px] font-mono text-[#94A3B8]">
                              Streaming
                            </span>
                            <span className="rounded bg-[#1E2536] px-1.5 py-0.5 text-[10px] font-mono text-[#94A3B8]">
                              Tool Calling
                            </span>
                            <span className="rounded bg-[#1E2536] px-1.5 py-0.5 text-[10px] font-mono text-[#94A3B8]">
                              Multimodal Vision
                            </span>
                            {prov.id === "gemini" && (
                              <span className="rounded bg-[#00F0FF]/10 px-1.5 py-0.5 text-[10px] font-mono text-[#00F0FF]">
                                2M Tokens
                              </span>
                            )}
                            {prov.id === "anthropic" && (
                              <span className="rounded bg-[#00F0FF]/10 px-1.5 py-0.5 text-[10px] font-mono text-[#00F0FF]">
                                200k Context
                              </span>
                            )}
                            {prov.id === "openai" && (
                              <span className="rounded bg-[#00F0FF]/10 px-1.5 py-0.5 text-[10px] font-mono text-[#00F0FF]">
                                o1/o3 Reasoning
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Connection Status Box */}
                        {isConnected ? (
                          <div className="rounded-lg border border-[#1E2536] bg-[#12151E] p-3 space-y-2">
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-[#64748B] font-mono">Status:</span>
                              <Badge
                                variant={
                                  conn.status === "ACTIVE"
                                    ? "emerald"
                                    : conn.status === "INVALID"
                                      ? "crimson"
                                      : "outline"
                                }
                              >
                                {conn.status === "ACTIVE"
                                  ? "Authenticated & Ready"
                                  : conn.status}
                              </Badge>
                            </div>

                            <div className="flex items-center justify-between text-xs font-mono">
                              <span className="text-[#64748B]">Connection:</span>
                              <span className="text-[#F0F4FC] truncate max-w-[130px]">
                                {conn.displayName}
                              </span>
                            </div>

                            <div className="flex items-center justify-between text-xs font-mono">
                              <span className="text-[#64748B]">Validated:</span>
                              <span className="text-[#94A3B8]">
                                {conn.lastValidatedAt
                                  ? new Date(conn.lastValidatedAt).toLocaleTimeString()
                                  : "Never"}
                              </span>
                            </div>

                            {/* Test Result Message */}
                            {testResult && testResult.id === conn.id && (
                              <div
                                className={`text-[11px] p-2 rounded border mt-2 ${
                                  testResult.success
                                    ? "bg-[#00FFA3]/10 text-[#00FFA3] border-[#00FFA3]/30"
                                    : "bg-[#FF3366]/10 text-[#FF3366] border-[#FF3366]/30"
                                }`}
                              >
                                {testResult.message}
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="rounded-lg border border-dashed border-[#1E2536] bg-[#12151E]/40 p-4 text-center space-y-1">
                            <span className="text-xs font-semibold text-[#94A3B8]">
                              No Connection Configured
                            </span>
                            <p className="text-[11px] text-[#64748B]">
                              Connect your {prov.name} API key to enable agent execution.
                            </p>
                          </div>
                        )}

                        {/* Action Buttons */}
                        <div className="pt-2 border-t border-[#1E2536] space-y-2">
                          {isConnected ? (
                            <div className="space-y-2">
                              <div className="grid grid-cols-2 gap-2">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => handleTestConnection(conn.id)}
                                  isLoading={isTesting}
                                  disabled={!isAuthorizedRole}
                                  className="font-mono text-xs w-full"
                                >
                                  <RefreshCw className="h-3 w-3 mr-1" />
                                  Test Probe
                                </Button>

                                <Button
                                  variant="secondary"
                                  size="sm"
                                  onClick={() => handleViewModels(prov.id)}
                                  className="font-mono text-xs w-full"
                                >
                                  <Layers className="h-3 w-3 mr-1" />
                                  View Models
                                </Button>
                              </div>

                              {isAuthorizedRole && (
                                <div className="flex items-center gap-2">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => {
                                      setRenamingConnection(conn);
                                      setNewDisplayName(conn.displayName);
                                    }}
                                    className="font-mono text-xs text-[#94A3B8] hover:text-[#F0F4FC] flex-1"
                                  >
                                    <Edit3 className="h-3 w-3 mr-1" />
                                    Rename
                                  </Button>

                                  <Button
                                    variant="destructive"
                                    size="sm"
                                    onClick={() => setDeletingConnection(conn)}
                                    className="font-mono text-xs flex-1"
                                  >
                                    <Trash2 className="h-3 w-3 mr-1" />
                                    Remove
                                  </Button>
                                </div>
                              )}
                            </div>
                          ) : (
                            <Button
                              variant="cyan"
                              size="sm"
                              onClick={() => {
                                setConnectModalProvider(prov.id);
                                setDisplayName(`${prov.name} Default`);
                                setApiKey("");
                                setModalError(null);
                              }}
                              disabled={!isAuthorizedRole}
                              className="w-full font-semibold font-mono text-xs"
                            >
                              <Plus className="h-3.5 w-3.5 mr-1" />
                              Connect {prov.name}
                            </Button>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </div>
          </div>
        </main>
      </div>

      {/* 1. CONNECT MODAL DIALOG */}
      {connectModalProvider && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
          <div className="w-full max-w-lg rounded-xl border border-[#1E2536] bg-[#0E111A] p-6 shadow-2xl space-y-5 animate-in fade-in zoom-in-95">
            <div className="flex items-center justify-between border-b border-[#1E2536] pb-4">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#00F0FF]/10 text-[#00F0FF] border border-[#00F0FF]/20">
                  <Lock className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-[#F0F4FC]">
                    Connect {connectModalProvider.toUpperCase()} Key
                  </h3>
                  <p className="text-[11px] text-[#64748B]">
                    Securely vaulted under workspace: {activeWorkspace?.name}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setConnectModalProvider(null)}
                className="text-[#64748B] hover:text-[#F0F4FC]"
                aria-label="Close dialog"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {modalError && (
              <div className="rounded-lg border border-[#FF3366]/30 bg-[#FF3366]/10 p-3 text-xs text-[#FF3366] flex items-start gap-2">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{modalError}</span>
              </div>
            )}

            <form onSubmit={handleConnect} className="space-y-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-[#94A3B8]">
                  Connection Display Name
                </label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="e.g. Production GPT-4o Key"
                  required
                  disabled={isValidating}
                  className="w-full rounded-lg border border-[#1E2536] bg-[#12151E] px-3 py-2 text-xs text-[#F0F4FC] placeholder-[#64748B] focus:border-[#00F0FF] focus:outline-none"
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="block text-xs font-medium text-[#94A3B8]">
                    Provider API Secret Key
                  </label>
                  <span className="text-[10px] font-mono text-[#00FFA3]">
                    AES-256-GCM Encrypted
                  </span>
                </div>
                <div className="relative">
                  <input
                    type={showApiKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={
                      connectModalProvider === "openai"
                        ? "sk-proj-..."
                        : connectModalProvider === "anthropic"
                          ? "sk-ant-..."
                          : "AIzaSy..."
                    }
                    required
                    disabled={isValidating}
                    className="w-full rounded-lg border border-[#1E2536] bg-[#12151E] px-3 py-2 pr-10 text-xs font-mono text-[#F0F4FC] placeholder-[#64748B] focus:border-[#00F0FF] focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey(!showApiKey)}
                    className="absolute inset-y-0 right-0 flex items-center pr-3 text-[#64748B] hover:text-[#94A3B8]"
                    aria-label="Toggle password view"
                  >
                    {showApiKey ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>

              <div className="rounded-lg border border-[#1E2536] bg-[#12151E]/60 p-3 text-[11px] text-[#64748B] space-y-1">
                <div className="flex items-center gap-1.5 text-[#94A3B8]">
                  <CheckCircle2 className="h-3.5 w-3.5 text-[#00FFA3]" />
                  <span className="font-semibold">Non-Billable Verification</span>
                </div>
                <p>
                  Messiah tests credentials using official non-generation model list endpoints without consuming token credits.
                </p>
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-[#1E2536]">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setConnectModalProvider(null)}
                  disabled={isValidating}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="cyan"
                  size="sm"
                  isLoading={isValidating}
                  className="font-semibold font-mono"
                >
                  Validate & Save Credential
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 2. RENAME MODAL */}
      {renamingConnection && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
          <div className="w-full max-w-md rounded-xl border border-[#1E2536] bg-[#0E111A] p-6 shadow-2xl space-y-4">
            <h3 className="text-base font-bold text-[#F0F4FC]">
              Rename Connection
            </h3>
            <form onSubmit={handleRename} className="space-y-4">
              <input
                type="text"
                value={newDisplayName}
                onChange={(e) => setNewDisplayName(e.target.value)}
                required
                className="w-full rounded-lg border border-[#1E2536] bg-[#12151E] px-3 py-2 text-xs text-[#F0F4FC] focus:border-[#00F0FF] focus:outline-none"
              />
              <div className="flex justify-end gap-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setRenamingConnection(null)}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="cyan" size="sm">
                  Save Name
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 3. REMOVE CONFIRMATION MODAL */}
      {deletingConnection && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
          <div className="w-full max-w-md rounded-xl border border-[#FF3366]/30 bg-[#0E111A] p-6 shadow-2xl space-y-4">
            <h3 className="text-base font-bold text-[#FF3366] flex items-center gap-2">
              <Trash2 className="h-5 w-5" />
              Remove Connection
            </h3>
            <p className="text-xs text-[#94A3B8] leading-relaxed">
              Are you sure you want to delete{" "}
              <strong className="text-[#F0F4FC]">
                {deletingConnection.displayName}
              </strong>
              ? Its encrypted credentials will be purged permanently from the vault.
            </p>
            <div className="flex justify-end gap-3 pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDeletingConnection(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={handleRemove}
              >
                Delete Permanently
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 4. MODELS VIEWER DRAWER / MODAL */}
      {viewingModelsProvider && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
          <div className="w-full max-w-2xl max-h-[80vh] flex flex-col rounded-xl border border-[#1E2536] bg-[#0E111A] shadow-2xl">
            <div className="flex items-center justify-between border-b border-[#1E2536] p-4">
              <div className="flex items-center gap-2">
                <Layers className="h-5 w-5 text-[#00F0FF]" />
                <h3 className="text-base font-bold text-[#F0F4FC] capitalize">
                  {viewingModelsProvider} Discovered Models ({modelsList.length})
                </h3>
              </div>
              <button
                onClick={() => setViewingModelsProvider(null)}
                className="text-[#64748B] hover:text-[#F0F4FC]"
                aria-label="Close models dialog"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {isLoadingModels ? (
                <div className="py-12 text-center text-xs text-[#64748B] font-mono flex items-center justify-center gap-2">
                  <RefreshCw className="h-4 w-4 animate-spin text-[#00F0FF]" />
                  <span>Discovering available models from provider API...</span>
                </div>
              ) : modelsList.length === 0 ? (
                <div className="py-12 text-center text-xs text-[#64748B]">
                  No models returned by provider.
                </div>
              ) : (
                <div className="space-y-2">
                  {modelsList.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-center justify-between rounded-lg border border-[#1E2536] bg-[#12151E] p-3 text-xs"
                    >
                      <div className="space-y-0.5">
                        <span className="font-mono font-medium text-[#F0F4FC]">
                          {m.name}
                        </span>
                        <div className="flex items-center gap-2 text-[10px] text-[#64748B] font-mono">
                          {m.contextWindow && (
                            <span>Context: {m.contextWindow.toLocaleString()} tokens</span>
                          )}
                          {m.maxOutputTokens && (
                            <span>Output: {m.maxOutputTokens.toLocaleString()} tokens</span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5">
                        {m.capabilities.vision && (
                          <span className="rounded bg-[#00F0FF]/10 px-1.5 py-0.5 text-[10px] font-mono text-[#00F0FF]">
                            Vision
                          </span>
                        )}
                        {m.capabilities.toolCalling && (
                          <span className="rounded bg-[#00FFA3]/10 px-1.5 py-0.5 text-[10px] font-mono text-[#00FFA3]">
                            Tools
                          </span>
                        )}
                        {m.capabilities.reasoning && (
                          <span className="rounded bg-[#FFB800]/10 px-1.5 py-0.5 text-[10px] font-mono text-[#FFB800]">
                            Reasoning
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="border-t border-[#1E2536] p-3 text-right">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setViewingModelsProvider(null)}
              >
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
