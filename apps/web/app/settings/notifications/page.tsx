"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bell,
  Smartphone,
  ShieldCheck,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Cpu,
} from "lucide-react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@messiah/ui";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { createClient } from "@/lib/supabase/client";
import { pickPreferredWorkspace } from "@/lib/desktopBridge";
import { subscribeToWebPush } from "@/lib/pwa";
import {
  PLATFORM_CAPABILITY_MATRIX,
  type NotificationDeviceInfo,
  type NotificationPreferenceInfo,
  type WorkspaceInfo,
} from "@messiah/shared";

export default function NotificationSettingsPage() {
  const router = useRouter();
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [prefs, setPrefs] = useState<NotificationPreferenceInfo | null>(null);
  const [devices, setDevices] = useState<NotificationDeviceInfo[]>([]);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const loadSettings = useCallback(async () => {
    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) {
        router.push("/login?redirect=/settings/notifications");
        return;
      }
      setAuthToken(session.access_token);

      const wsRes = await fetch(`${apiUrl}/api/v1/workspaces`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!wsRes.ok) return;
      const rawWs = await wsRes.json();
      const wsList: WorkspaceInfo[] = Array.isArray(rawWs) ? rawWs : rawWs.data || [];
      const ws = workspace || pickPreferredWorkspace(wsList);
      if (!ws) return;
      setWorkspace(ws);

      const [prefRes, devRes] = await Promise.all([
        fetch(`${apiUrl}/api/v1/notifications/preferences?workspaceId=${ws.id}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        }),
        fetch(`${apiUrl}/api/v1/notifications/devices`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        }),
      ]);

      if (prefRes.ok) setPrefs((await prefRes.json()).data);
      if (devRes.ok) setDevices((await devRes.json()).data || []);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed loading settings.");
    }
  }, [apiUrl, router, workspace]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const togglePref = async (key: keyof NotificationPreferenceInfo, value: boolean) => {
    if (!authToken || !workspace || !prefs) return;
    setIsSaving(true);
    setErrorMsg(null);
    try {
      const res = await fetch(`${apiUrl}/api/v1/notifications/preferences`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workspaceId: workspace.id,
          [key]: value,
        }),
      });
      if (res.ok) {
        setPrefs((await res.json()).data);
        setStatusMsg("Notification preferences updated.");
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleEnableWebPush = async () => {
    if (!authToken || !workspace) return;
    setErrorMsg(null);
    setStatusMsg(null);
    const res = await subscribeToWebPush({
      apiUrl,
      authToken,
      workspaceId: workspace.id,
    });
    if (res.registered) {
      setStatusMsg("Web Push enabled and registered on this device.");
      await loadSettings();
    } else {
      setErrorMsg(res.reason || "Unable to register Web Push.");
    }
  };

  const handleRevokeDevice = async (deviceId: string) => {
    if (!authToken) return;
    await fetch(`${apiUrl}/api/v1/notifications/devices/${deviceId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    await loadSettings();
  };

  return (
    <div className="flex h-screen flex-col bg-[#090A0F] text-[#F0F4FC]">
      <Header
        onToggleSidebar={() => setSidebarOpen((p) => !p)}
        onWorkspaceChange={(ws) => setWorkspace(ws)}
      />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          activeTab="notifications"
          onSelectTab={() => {}}
        />

        <main className="flex-1 overflow-y-auto p-4 md:p-8 space-y-6">
          <div className="mx-auto max-w-5xl space-y-6">
            <div>
              <h1 className="text-xl font-semibold flex items-center gap-2">
                <Bell className="h-5 w-5 text-[#00F0FF]" />
                Notifications, Multi-Device Sync & Security Matrix
              </h1>
              <p className="text-xs text-[#94A3B8] mt-1">
                Control cross-device approval alerts, privacy-scrubbed push subscriptions, and review platform sandboxing guarantees.
              </p>
            </div>

            {statusMsg && (
              <div className="flex items-center gap-2 rounded-xl border border-[#00FFA3]/30 bg-[#00FFA3]/10 p-3 text-xs text-[#00FFA3]">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>{statusMsg}</span>
              </div>
            )}

            {errorMsg && (
              <div className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}

            {/* Channel & Category Preferences */}
            {prefs && (
              <Card className="border-[#1E2536] bg-[#0E121B]">
                <CardHeader>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="text-sm font-semibold">Workspace Delivery Preferences</CardTitle>
                    <Button size="sm" variant="cyan" onClick={handleEnableWebPush} className="text-xs font-mono">
                      Enable Browser Web Push
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  {(
                    [
                      ["inAppEnabled", "In-App & WebSocket Alerts"],
                      ["webPushEnabled", "Web Push Notifications (PWA)"],
                      ["desktopEnabled", "Native Desktop Notifications (Tauri)"],
                      ["mobilePushEnabled", "Mobile Push Alerts (APNs / FCM)"],
                      ["notifyApprovals", "Approval Required Alerts"],
                      ["notifyCompletions", "Agent & Workflow Completion Alerts"],
                      ["notifyFailures", "Execution Failure Alerts"],
                      ["notifyDeviceStatus", "Local Bridge Online/Offline Alerts"],
                    ] as Array<[keyof NotificationPreferenceInfo, string]>
                  ).map(([field, label]) => (
                    <label
                      key={String(field)}
                      className="flex items-center justify-between rounded-lg border border-[#1E2536] bg-[#12151E] p-3 cursor-pointer"
                    >
                      <span className="text-[#CBD5E1]">{label}</span>
                      <input
                        type="checkbox"
                        checked={Boolean(prefs[field])}
                        disabled={isSaving}
                        onChange={(e) => togglePref(field, e.target.checked)}
                        className="h-4 w-4 accent-[#00F0FF]"
                      />
                    </label>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Registered Client Notification Devices */}
            <Card className="border-[#1E2536] bg-[#0E121B]">
              <CardHeader>
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Smartphone className="h-4 w-4 text-[#00FFA3]" />
                  Registered Client Endpoints ({devices.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2.5 text-xs">
                {devices.length === 0 ? (
                  <p className="text-[#64748B]">No push devices registered yet for this account.</p>
                ) : (
                  devices.map((d) => (
                    <div
                      key={d.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#1E2536] bg-[#12151E] p-3"
                    >
                      <div>
                        <div className="font-semibold text-[#F0F4FC] flex items-center gap-2">
                          <span>{d.deviceLabel}</span>
                          <Badge variant="outline">{d.platform}</Badge>
                          <Badge variant={d.isActive ? "emerald" : "outline"}>
                            {d.isActive ? "Active" : "Revoked"}
                          </Badge>
                        </div>
                        <div className="mt-1 font-mono text-[10px] text-[#64748B]">
                          Provider: {d.pushProvider} · Last seen {new Date(d.lastSeenAt).toLocaleString()}
                        </div>
                      </div>
                      {d.isActive && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRevokeDevice(d.id)}
                          className="text-rose-400 hover:bg-rose-500/10 text-xs"
                        >
                          <Trash2 className="h-3.5 w-3.5 mr-1" />
                          Revoke
                        </Button>
                      )}
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            {/* Cross-Platform Security & Capability Matrix */}
            <Card className="border-[#1E2536] bg-[#0E121B]">
              <CardHeader>
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-[#00F0FF]" />
                  Platform Sandboxing & Credential Storage Matrix
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-xs">
                {PLATFORM_CAPABILITY_MATRIX.map((entry) => (
                  <div
                    key={entry.platform}
                    className="rounded-lg border border-[#1E2536] bg-[#12151E]/80 p-3.5 space-y-1.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-[#F0F4FC] flex items-center gap-2">
                        <Cpu className="h-3.5 w-3.5 text-[#00F0FF]" />
                        {entry.label}
                      </span>
                      <Badge variant={entry.sandboxSupported ? "emerald" : "amber"}>
                        {entry.sandboxProvider}
                      </Badge>
                    </div>
                    <div className="text-[11px] font-mono text-[#94A3B8]">
                      Keystore: {entry.keystoreEngine}
                    </div>
                    <p className="text-[11px] text-[#64748B]">{entry.notes}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </main>
      </div>
    </div>
  );
}
