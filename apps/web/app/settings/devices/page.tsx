"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  Laptop2,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Plus,
  X,
  Shield,
  Copy,
  Check,
  PauseCircle,
  PlayCircle,
  Trash2,
  Edit2,
  Clock,
  Terminal,
  Info,
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
  BridgeDeviceInfo,
  DevicePairingChallengeInfo,
  CreatePairingChallengeResponse,
  WorkspaceInfo,
} from "@messiah/shared";

export default function DevicesSettingsPage() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeTab] = useState("devices");

  const [, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceInfo | null>(null);

  const [devices, setDevices] = useState<BridgeDeviceInfo[]>([]);
  const [pendingChallenges, setPendingChallenges] = useState<DevicePairingChallengeInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Pairing Modal States
  const [isPairModalOpen, setIsPairModalOpen] = useState(false);
  const [isGeneratingPairing, setIsGeneratingPairing] = useState(false);
  const [pairingData, setPairingData] = useState<CreatePairingChallengeResponse | null>(null);
  const [timeRemainingSeconds, setTimeRemainingSeconds] = useState(300);
  const [copiedCode, setCopiedCode] = useState(false);

  // Device Detail & Rename Modal States
  const [selectedDevice, setSelectedDevice] = useState<BridgeDeviceInfo | null>(null);
  const [deviceSessions, setDeviceSessions] = useState<Array<{
    id: string;
    ipAddress?: string;
    userAgent?: string;
    connectedAt: string;
    lastHeartbeatAt: string;
    disconnectedAt?: string | null;
    disconnectReason?: string | null;
  }>>([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);

  const [renameDeviceId, setRenameDeviceId] = useState<string | null>(null);
  const [renameDisplayName, setRenameDisplayName] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);

  // Confirmation Modals
  const [revokingDevice, setRevokingDevice] = useState<BridgeDeviceInfo | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

  // 1. Load Initial Data (Session, Workspaces, Devices, Pending Approvals)
  const loadData = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        setErrorMessage("Please sign in to access device management.");
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

      const wsJson = await wsRes.json();
      const availableWorkspaces: WorkspaceInfo[] = wsJson.data || [];
      setWorkspaces(availableWorkspaces);

      const targetWs = activeWorkspace || availableWorkspaces[0] || null;
      setActiveWorkspace(targetWs);

      if (targetWs) {
        // Fetch Devices
        const devRes = await fetch(`${apiUrl}/api/v1/devices?workspaceId=${targetWs.id}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });

        if (devRes.ok) {
          const devJson = await devRes.json();
          setDevices(devJson.data || []);
        }

        // Fetch Pending Approvals (if OWNER / ADMIN)
        if (targetWs.role === "OWNER" || targetWs.role === "ADMIN") {
          const pendingRes = await fetch(`${apiUrl}/api/v1/devices/pair/pending?workspaceId=${targetWs.id}`, {
            headers: { Authorization: `Bearer ${session.access_token}` },
          });

          if (pendingRes.ok) {
            const pendingJson = await pendingRes.json();
            setPendingChallenges(pendingJson.data || []);
          }
        } else {
          setPendingChallenges([]);
        }
      }
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Error loading devices.");
    } finally {
      setIsLoading(false);
    }
  }, [apiUrl, activeWorkspace]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Pairing code countdown timer
  useEffect(() => {
    if (!isPairModalOpen || !pairingData) return;

    const timer = setInterval(() => {
      const expiresAtMs = new Date(pairingData.expiresAt).getTime();
      const diffSecs = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
      setTimeRemainingSeconds(diffSecs);

      if (diffSecs <= 0) {
        clearInterval(timer);
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [isPairModalOpen, pairingData]);

  // Periodic poll for pending registrations when pair modal is open
  useEffect(() => {
    if (!isPairModalOpen || !activeWorkspace) return;

    const pollTimer = setInterval(async () => {
      try {
        const supabase = createClient();
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) return;

        const res = await fetch(`${apiUrl}/api/v1/devices/pair/pending?workspaceId=${activeWorkspace.id}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });

        if (res.ok) {
          const json = await res.json();
          setPendingChallenges(json.data || []);
        }
      } catch {}
    }, 3000);

    return () => clearInterval(pollTimer);
  }, [isPairModalOpen, activeWorkspace, apiUrl]);

  // Initiate Pairing Challenge
  const handleInitiatePairing = async () => {
    if (!activeWorkspace) return;
    setIsGeneratingPairing(true);
    setErrorMessage(null);

    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Not authenticated");

      const res = await fetch(`${apiUrl}/api/v1/devices/pair/challenge`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ workspaceId: activeWorkspace.id }),
      });

      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error?.message || "Failed to generate pairing code.");
      }

      setPairingData(json.data);
      setIsPairModalOpen(true);
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Pairing generation failed.");
    } finally {
      setIsGeneratingPairing(false);
    }
  };

  // Approve Pending Device
  const handleApproveDevice = async (challengeId: string) => {
    if (!activeWorkspace) return;
    setErrorMessage(null);

    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Not authenticated");

      const res = await fetch(`${apiUrl}/api/v1/devices/pair/${challengeId}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ workspaceId: activeWorkspace.id }),
      });

      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error?.message || "Approval failed.");
      }

      setSuccessMessage("Device approved successfully and activated!");
      setIsPairModalOpen(false);
      loadData();
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Approval failed.");
    }
  };

  // Reject Pending Device
  const handleRejectDevice = async (challengeId: string) => {
    if (!activeWorkspace) return;
    setErrorMessage(null);

    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Not authenticated");

      const res = await fetch(`${apiUrl}/api/v1/devices/pair/${challengeId}/reject`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ workspaceId: activeWorkspace.id }),
      });

      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error?.message || "Rejection failed.");
      }

      setSuccessMessage("Device pairing rejected.");
      loadData();
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Rejection failed.");
    }
  };

  // Pause / Resume Device
  const handleTogglePauseDevice = async (device: BridgeDeviceInfo) => {
    if (!activeWorkspace) return;
    setErrorMessage(null);

    const action = device.status === "PAUSED" ? "resume" : "pause";

    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Not authenticated");

      const res = await fetch(`${apiUrl}/api/v1/devices/${device.id}/${action}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ workspaceId: activeWorkspace.id }),
      });

      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error?.message || `Failed to ${action} device.`);
      }

      setSuccessMessage(`Device ${device.displayName} ${action === "pause" ? "paused" : "resumed"}.`);
      loadData();
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : `Failed to ${action} device.`);
    }
  };

  // Revoke Device
  const handleRevokeDevice = async () => {
    if (!activeWorkspace || !revokingDevice) return;
    setIsRevoking(true);
    setErrorMessage(null);

    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Not authenticated");

      const res = await fetch(`${apiUrl}/api/v1/devices/${revokingDevice.id}/revoke`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ workspaceId: activeWorkspace.id }),
      });

      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error?.message || "Failed to revoke device.");
      }

      setSuccessMessage(`Device ${revokingDevice.displayName} permanently revoked.`);
      setRevokingDevice(null);
      loadData();
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to revoke device.");
    } finally {
      setIsRevoking(false);
    }
  };

  // Rename Device
  const handleRenameDevice = async () => {
    if (!activeWorkspace || !renameDeviceId || !renameDisplayName.trim()) return;
    setIsRenaming(true);
    setErrorMessage(null);

    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Not authenticated");

      const res = await fetch(`${apiUrl}/api/v1/devices/${renameDeviceId}/rename`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          workspaceId: activeWorkspace.id,
          displayName: renameDisplayName.trim(),
        }),
      });

      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error?.message || "Failed to rename device.");
      }

      setSuccessMessage("Device renamed successfully.");
      setRenameDeviceId(null);
      loadData();
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to rename device.");
    } finally {
      setIsRenaming(false);
    }
  };

  // View Device Detail & Connection History
  const handleViewDetails = async (device: BridgeDeviceInfo) => {
    setSelectedDevice(device);
    setDeviceSessions([]);
    setIsLoadingSessions(true);

    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return;

      const res = await fetch(`${apiUrl}/api/v1/devices/${device.id}?workspaceId=${device.workspaceId}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (res.ok) {
        const json = await res.json();
        setDeviceSessions(json.data.sessions || []);
      }
    } catch {} finally {
      setIsLoadingSessions(false);
    }
  };

  // Copy code helper
  const handleCopyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const isOwnerOrAdmin = activeWorkspace?.role === "OWNER" || activeWorkspace?.role === "ADMIN";

  const totalDevices = devices.length;
  const onlineDevices = devices.filter((d) => d.isOnline).length;
  const pausedDevices = devices.filter((d) => d.status === "PAUSED").length;
  const pendingCount = pendingChallenges.length;

  return (
    <div className="flex min-h-screen bg-[#07080B] text-[#ECEFF4] font-sans antialiased">
      {/* Sidebar */}
      <Sidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        activeTab={activeTab}
        onSelectTab={() => {}}
      />

      {/* Main Content Area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header
          onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
          activeWorkspace={activeWorkspace}
          onWorkspaceChange={(ws) => setActiveWorkspace(ws)}
        />

        <main className="flex-1 overflow-y-auto px-4 py-8 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-7xl space-y-8">
            {/* Page Header */}
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
                    <Laptop2 className="h-5 w-5" />
                  </div>
                  <div>
                    <h1 className="text-2xl font-semibold tracking-tight text-white">
                      Local Agent Bridges & Devices
                    </h1>
                    <p className="text-xs text-[#94A3B8]">
                      Secure outbound-only WebSocket connections to user computers. No open inbound ports.
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={loadData}
                  disabled={isLoading}
                  className="border-[#1E2536] bg-[#0C0E14] text-[#CBD5E1] hover:bg-[#151822] hover:text-white"
                >
                  <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
                  Refresh
                </Button>

                {isOwnerOrAdmin && (
                  <Button
                    size="sm"
                    onClick={handleInitiatePairing}
                    disabled={isGeneratingPairing || !activeWorkspace}
                    className="bg-cyan-600 hover:bg-cyan-500 text-white font-medium shadow-lg shadow-cyan-950/40"
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Pair New Device
                  </Button>
                )}
              </div>
            </div>

            {/* Notification Messages */}
            {errorMessage && (
              <div className="flex items-center gap-3 rounded-lg border border-red-500/30 bg-red-950/20 p-4 text-sm text-red-400">
                <AlertCircle className="h-5 w-5 shrink-0" />
                <span>{errorMessage}</span>
                <button onClick={() => setErrorMessage(null)} className="ml-auto text-red-400 hover:text-white">
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}

            {successMessage && (
              <div className="flex items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-950/20 p-4 text-sm text-emerald-400">
                <CheckCircle2 className="h-5 w-5 shrink-0" />
                <span>{successMessage}</span>
                <button onClick={() => setSuccessMessage(null)} className="ml-auto text-emerald-400 hover:text-white">
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}

            {/* Metrics Overview Cards */}
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Card className="border-[#1E2536] bg-[#0C0E14]">
                <CardContent className="p-5">
                  <div className="flex items-center justify-between text-xs text-[#94A3B8]">
                    <span>Total Registered</span>
                    <Laptop2 className="h-4 w-4 text-[#64748B]" />
                  </div>
                  <div className="mt-2 text-2xl font-bold text-white">{totalDevices}</div>
                </CardContent>
              </Card>

              <Card className="border-[#1E2536] bg-[#0C0E14]">
                <CardContent className="p-5">
                  <div className="flex items-center justify-between text-xs text-[#94A3B8]">
                    <span>Online Now</span>
                    <StatusDot status="online" />
                  </div>
                  <div className="mt-2 text-2xl font-bold text-emerald-400">{onlineDevices}</div>
                </CardContent>
              </Card>

              <Card className="border-[#1E2536] bg-[#0C0E14]">
                <CardContent className="p-5">
                  <div className="flex items-center justify-between text-xs text-[#94A3B8]">
                    <span>Paused</span>
                    <PauseCircle className="h-4 w-4 text-amber-500/80" />
                  </div>
                  <div className="mt-2 text-2xl font-bold text-amber-400">{pausedDevices}</div>
                </CardContent>
              </Card>

              <Card className="border-[#1E2536] bg-[#0C0E14]">
                <CardContent className="p-5">
                  <div className="flex items-center justify-between text-xs text-[#94A3B8]">
                    <span>Pending Approval</span>
                    <Shield className="h-4 w-4 text-cyan-400" />
                  </div>
                  <div className="mt-2 text-2xl font-bold text-cyan-400">{pendingCount}</div>
                </CardContent>
              </Card>
            </div>

            {/* Pending Approvals Section */}
            {pendingChallenges.length > 0 && (
              <div className="rounded-xl border border-cyan-500/30 bg-[#0C121D] p-6 shadow-xl">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-500/20 text-cyan-400">
                    <Shield className="h-4 w-4" />
                  </div>
                  <div>
                    <h2 className="text-base font-semibold text-white">
                      Pending Device Approvals ({pendingChallenges.length})
                    </h2>
                    <p className="text-xs text-[#94A3B8]">
                      A local bridge is requesting authorization to pair with this workspace. Verify the fingerprint before approving.
                    </p>
                  </div>
                </div>

                <div className="mt-5 space-y-3">
                  {pendingChallenges.map((challenge) => (
                    <div
                      key={challenge.id}
                      className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-lg border border-[#1E2536] bg-[#07080B] p-4"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-white">{challenge.claimedDeviceName || "Unnamed Computer"}</span>
                          <Badge variant="outline" className="border-cyan-500/30 text-cyan-400 text-[10px]">
                            {challenge.claimedPlatform || "unknown"} / {challenge.claimedArchitecture || "unknown"}
                          </Badge>
                          <span className="text-xs text-[#64748B]">v{challenge.claimedBridgeVersion || "0.1.0"}</span>
                        </div>
                        <div className="font-mono text-xs text-[#94A3B8]">
                          Fingerprint: <span className="text-[#E2E8F0]">{challenge.claimedFingerprint || "N/A"}</span>
                        </div>
                        <div className="text-[11px] text-[#64748B]">
                          Claimed: {new Date(challenge.createdAt).toLocaleTimeString()} · Expires: {new Date(challenge.expiresAt).toLocaleTimeString()}
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleRejectDevice(challenge.id)}
                          className="border-red-500/30 bg-red-950/20 text-red-400 hover:bg-red-950/40 text-xs"
                        >
                          Reject
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => handleApproveDevice(challenge.id)}
                          className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium"
                        >
                          <Check className="mr-1.5 h-3.5 w-3.5" />
                          Approve Device
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Paired Devices List */}
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-white">Paired Computers</h2>

              {devices.length === 0 ? (
                <Card className="border-[#1E2536] bg-[#0C0E14] text-center p-12">
                  <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[#151822] text-[#64748B]">
                    <Laptop2 className="h-7 w-7" />
                  </div>
                  <h3 className="mt-4 text-base font-medium text-white">No paired computers yet</h3>
                  <p className="mx-auto mt-1 max-w-sm text-xs text-[#94A3B8]">
                    Install the Messiah Local Agent Bridge on your Mac, Windows, or Linux computer to connect local agents.
                  </p>
                  {isOwnerOrAdmin && (
                    <Button
                      size="sm"
                      onClick={handleInitiatePairing}
                      className="mt-6 bg-cyan-600 hover:bg-cyan-500 text-white"
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Pair This Computer
                    </Button>
                  )}
                </Card>
              ) : (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {devices.map((device) => {
                    const isOnline = device.isOnline;
                    const isPaused = device.status === "PAUSED";
                    const isRevoked = device.status === "REVOKED";

                    return (
                      <Card
                        key={device.id}
                        className={`border-[#1E2536] bg-[#0C0E14] transition-colors hover:border-[#2D3748] ${
                          isPaused ? "opacity-75" : ""
                        }`}
                      >
                        <CardContent className="p-5 space-y-4">
                          {/* Card Header */}
                          <div className="flex items-start justify-between">
                            <div className="flex items-center gap-3">
                              <div
                                className={`flex h-10 w-10 items-center justify-center rounded-xl border ${
                                  isOnline
                                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                                    : isPaused
                                    ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
                                    : "border-[#1E2536] bg-[#151822] text-[#64748B]"
                                }`}
                              >
                                <Laptop2 className="h-5 w-5" />
                              </div>
                              <div>
                                <h3 className="font-medium text-white text-sm flex items-center gap-2">
                                  {device.displayName}
                                  {isOwnerOrAdmin && (
                                    <button
                                      onClick={() => {
                                        setRenameDeviceId(device.id);
                                        setRenameDisplayName(device.displayName);
                                      }}
                                      className="text-[#64748B] hover:text-[#CBD5E1]"
                                      title="Rename device"
                                    >
                                      <Edit2 className="h-3 w-3" />
                                    </button>
                                  )}
                                </h3>
                                <div className="flex items-center gap-2 text-xs text-[#94A3B8]">
                                  <span>{device.platform}</span>
                                  <span>·</span>
                                  <span>{device.architecture}</span>
                                  <span>·</span>
                                  <span>v{device.bridgeVersion}</span>
                                </div>
                              </div>
                            </div>

                            {/* Status Badge */}
                            <div>
                              {isOnline && (
                                <Badge variant="outline" className="border-emerald-500/30 bg-emerald-950/20 text-emerald-400 text-[10px]">
                                  <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                                  Online
                                </Badge>
                              )}
                              {!isOnline && !isPaused && !isRevoked && (
                                <Badge variant="outline" className="border-[#1E2536] bg-[#151822] text-[#94A3B8] text-[10px]">
                                  Offline
                                </Badge>
                              )}
                              {isPaused && (
                                <Badge variant="outline" className="border-amber-500/30 bg-amber-950/20 text-amber-400 text-[10px]">
                                  Paused
                                </Badge>
                              )}
                              {isRevoked && (
                                <Badge variant="outline" className="border-red-500/30 bg-red-950/20 text-red-400 text-[10px]">
                                  Revoked
                                </Badge>
                              )}
                            </div>
                          </div>

                          {/* Fingerprint & Security Info */}
                          <div className="rounded-lg bg-[#07080B] p-3 text-xs space-y-1.5 border border-[#1E2536]/60">
                            <div className="flex items-center justify-between text-[#64748B]">
                              <span>Fingerprint</span>
                              <button
                                onClick={() => handleCopyCode(device.publicKeyFingerprint)}
                                className="hover:text-white"
                                title="Copy fingerprint"
                              >
                                <Copy className="h-3 w-3" />
                              </button>
                            </div>
                            <div className="font-mono text-[11px] text-[#CBD5E1] truncate">
                              {device.publicKeyFingerprint}
                            </div>
                            <div className="flex items-center justify-between text-[11px] text-[#64748B] pt-1 border-t border-[#1E2536]/40">
                              <span>Protocol</span>
                              <span className="font-mono text-[#94A3B8]">{device.protocolVersion}</span>
                            </div>
                            <div className="flex items-center justify-between text-[11px] text-[#64748B]">
                              <span>Last Seen</span>
                              <span>
                                {device.lastSeenAt
                                  ? new Date(device.lastSeenAt).toLocaleString()
                                  : "Never"}
                              </span>
                            </div>
                          </div>

                          {/* Card Actions */}
                          <div className="flex items-center justify-between pt-1">
                            <div className="flex items-center gap-1.5">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleViewDetails(device)}
                                className="text-xs text-[#94A3B8] hover:text-white hover:bg-[#151822] px-2 h-7"
                              >
                                <Info className="mr-1.5 h-3.5 w-3.5" />
                                Sessions & Keys
                              </Button>

                              <Link href={`/settings/devices/${device.id}/capabilities?workspaceId=${activeWorkspace?.id}`}>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="text-xs text-indigo-400 hover:text-indigo-300 hover:bg-indigo-950/20 px-2 h-7"
                                >
                                  <Shield className="mr-1.5 h-3.5 w-3.5" />
                                  Capabilities
                                </Button>
                              </Link>
                            </div>

                            {isOwnerOrAdmin && !isRevoked && (
                              <div className="flex items-center gap-1.5">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleTogglePauseDevice(device)}
                                  className={`text-xs px-2 h-7 ${
                                    isPaused
                                      ? "text-emerald-400 hover:text-emerald-300 hover:bg-emerald-950/20"
                                      : "text-amber-400 hover:text-amber-300 hover:bg-amber-950/20"
                                  }`}
                                  title={isPaused ? "Resume connection" : "Pause connection"}
                                >
                                  {isPaused ? (
                                    <>
                                      <PlayCircle className="mr-1 h-3.5 w-3.5" />
                                      Resume
                                    </>
                                  ) : (
                                    <>
                                      <PauseCircle className="mr-1 h-3.5 w-3.5" />
                                      Pause
                                    </>
                                  )}
                                </Button>

                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setRevokingDevice(device)}
                                  className="text-xs text-red-400 hover:text-red-300 hover:bg-red-950/20 px-2 h-7"
                                  title="Revoke device access"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </main>
      </div>

      {/* 1. PAIR NEW DEVICE MODAL */}
      {isPairModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl border border-[#1E2536] bg-[#0C0E14] p-6 shadow-2xl space-y-6">
            <div className="flex items-center justify-between border-b border-[#1E2536] pb-4">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-500/10 text-cyan-400">
                  <Laptop2 className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-semibold text-white">Pair New Computer</h3>
                  <p className="text-xs text-[#94A3B8]">Workspace: {activeWorkspace?.name}</p>
                </div>
              </div>
              <button
                onClick={() => setIsPairModalOpen(false)}
                className="text-[#64748B] hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {pairingData && (
              <div className="space-y-5">
                <div className="rounded-xl border border-cyan-500/30 bg-cyan-950/10 p-5 text-center space-y-3">
                  <div className="text-xs uppercase tracking-wider text-cyan-400 font-medium">
                    One-Time 256-Bit Pairing Code
                  </div>
                  <div className="flex items-center justify-center gap-3">
                    <span className="font-mono text-2xl font-bold tracking-widest text-white">
                      {pairingData.pairingCode}
                    </span>
                    <button
                      onClick={() => handleCopyCode(pairingData.pairingCode)}
                      className="rounded-lg border border-[#1E2536] bg-[#151822] p-2 text-[#CBD5E1] hover:text-white"
                      title="Copy code"
                    >
                      {copiedCode ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                    </button>
                  </div>
                  <div className="flex items-center justify-center gap-1.5 text-xs text-[#94A3B8]">
                    <Clock className="h-3.5 w-3.5 text-amber-400" />
                    <span>
                      Expires in:{" "}
                      <span className="font-mono font-medium text-white">
                        {Math.floor(timeRemainingSeconds / 60)}:
                        {String(timeRemainingSeconds % 60).padStart(2, "0")}
                      </span>
                    </span>
                  </div>
                </div>

                <div className="space-y-3 text-xs text-[#CBD5E1]">
                  <div className="font-medium text-white flex items-center gap-2">
                    <Terminal className="h-4 w-4 text-cyan-400" />
                    Instructions:
                  </div>
                  <ol className="list-decimal list-inside space-y-2 text-[#94A3B8] leading-relaxed">
                    <li>Open Terminal / Command Prompt on your computer.</li>
                    <li>
                      Run the pairing command:
                      <div className="mt-1.5 flex items-center justify-between rounded-lg bg-[#07080B] p-2.5 font-mono text-cyan-300 border border-[#1E2536]">
                        <span>messiah-bridge pair</span>
                        <button
                          onClick={() => handleCopyCode("messiah-bridge pair")}
                          className="text-[#64748B] hover:text-white"
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </li>
                    <li>Enter the code above when prompted.</li>
                    <li>Once registered, this dialog will update for your approval.</li>
                  </ol>
                </div>

                {pendingChallenges.length > 0 && (
                  <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/20 p-4 space-y-2">
                    <div className="flex items-center gap-2 text-xs font-semibold text-emerald-400">
                      <CheckCircle2 className="h-4 w-4" />
                      Device Detected!
                    </div>
                    <p className="text-xs text-[#CBD5E1]">
                      {pendingChallenges[0]?.claimedDeviceName} ({pendingChallenges[0]?.claimedPlatform}) is ready for approval.
                    </p>
                    <Button
                      size="sm"
                      onClick={() => handleApproveDevice(pendingChallenges[0]!.id)}
                      className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
                    >
                      Approve & Finish Pairing
                    </Button>
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-end pt-2 border-t border-[#1E2536]">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsPairModalOpen(false)}
                className="border-[#1E2536] bg-[#151822] text-[#CBD5E1]"
              >
                Done
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 2. RENAME DEVICE MODAL */}
      {renameDeviceId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-[#1E2536] bg-[#0C0E14] p-6 shadow-2xl space-y-4">
            <h3 className="font-semibold text-white">Rename Device</h3>
            <div className="space-y-1.5">
              <label className="text-xs text-[#94A3B8]">Display Name</label>
              <input
                type="text"
                value={renameDisplayName}
                onChange={(e) => setRenameDisplayName(e.target.value)}
                className="w-full rounded-lg border border-[#1E2536] bg-[#07080B] px-3 py-2 text-sm text-white focus:border-cyan-500 focus:outline-none"
                placeholder="e.g. Work MacBook Pro"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRenameDeviceId(null)}
                className="border-[#1E2536] bg-[#151822] text-[#CBD5E1]"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleRenameDevice}
                disabled={isRenaming || !renameDisplayName.trim()}
                className="bg-cyan-600 hover:bg-cyan-500 text-white"
              >
                {isRenaming ? "Saving..." : "Save Name"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 3. REVOKE CONFIRMATION MODAL */}
      {revokingDevice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-red-500/30 bg-[#0C0E14] p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3 text-red-400">
              <AlertCircle className="h-6 w-6" />
              <h3 className="font-semibold text-white">Revoke Device?</h3>
            </div>
            <p className="text-xs text-[#94A3B8] leading-relaxed">
              Are you sure you want to permanently revoke <span className="text-white font-medium">{revokingDevice.displayName}</span>?
              Its cryptographic keys will be invalidated and its connection terminated immediately.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRevokingDevice(null)}
                className="border-[#1E2536] bg-[#151822] text-[#CBD5E1]"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleRevokeDevice}
                disabled={isRevoking}
                className="bg-red-600 hover:bg-red-500 text-white font-medium"
              >
                {isRevoking ? "Revoking..." : "Permanently Revoke"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 4. DEVICE DETAILS & SESSIONS MODAL */}
      {selectedDevice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl border border-[#1E2536] bg-[#0C0E14] p-6 shadow-2xl space-y-6">
            <div className="flex items-center justify-between border-b border-[#1E2536] pb-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-500/10 text-cyan-400">
                  <Laptop2 className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-semibold text-white">{selectedDevice.displayName}</h3>
                  <p className="text-xs text-[#94A3B8]">Device ID: {selectedDevice.id}</p>
                </div>
              </div>
              <button
                onClick={() => setSelectedDevice(null)}
                className="text-[#64748B] hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Cryptographic Identity Section */}
            <div className="space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-[#94A3B8]">
                Cryptographic Identity
              </h4>
              <div className="rounded-xl border border-[#1E2536] bg-[#07080B] p-4 space-y-3 text-xs">
                <div>
                  <div className="text-[#64748B] mb-1">Public Key Fingerprint (SHA-256)</div>
                  <div className="font-mono text-[#CBD5E1] break-all">{selectedDevice.publicKeyFingerprint}</div>
                </div>
                <div>
                  <div className="text-[#64748B] mb-1">Ed25519 Public Key (SPKI PEM)</div>
                  <pre className="font-mono text-[11px] text-[#94A3B8] bg-[#040507] p-2.5 rounded border border-[#1E2536] overflow-x-auto">
                    {selectedDevice.publicKey}
                  </pre>
                </div>
              </div>
            </div>

            {/* Connection History Section */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-[#94A3B8]">
                  Recent Connection Sessions
                </h4>
                {isLoadingSessions && <RefreshCw className="h-3.5 w-3.5 animate-spin text-cyan-400" />}
              </div>

              {deviceSessions.length === 0 ? (
                <div className="rounded-xl border border-[#1E2536] bg-[#07080B] p-6 text-center text-xs text-[#64748B]">
                  No connection sessions recorded yet.
                </div>
              ) : (
                <div className="rounded-xl border border-[#1E2536] bg-[#07080B] overflow-hidden text-xs">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-[#1E2536] text-[#64748B] bg-[#0C0E14]">
                        <th className="p-3">Connected At</th>
                        <th className="p-3">Last Heartbeat</th>
                        <th className="p-3">IP Address</th>
                        <th className="p-3">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1E2536]/60">
                      {deviceSessions.map((session) => (
                        <tr key={session.id} className="text-[#CBD5E1]">
                          <td className="p-3">{new Date(session.connectedAt).toLocaleString()}</td>
                          <td className="p-3">{new Date(session.lastHeartbeatAt).toLocaleTimeString()}</td>
                          <td className="p-3 font-mono">{session.ipAddress || "local"}</td>
                          <td className="p-3">
                            {session.disconnectedAt ? (
                              <span className="text-[#64748B]">
                                Ended ({session.disconnectReason || "normal"})
                              </span>
                            ) : (
                              <span className="text-emerald-400 font-medium">Active</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="flex justify-end pt-2 border-t border-[#1E2536]">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSelectedDevice(null)}
                className="border-[#1E2536] bg-[#151822] text-[#CBD5E1]"
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
