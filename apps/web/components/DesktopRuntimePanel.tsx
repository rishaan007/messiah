"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  Laptop2,
  Play,
  Square,
  RefreshCw,
  FolderOpen,
  ShieldCheck,
  Download,
  Terminal,
} from "lucide-react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@messiah/ui";
import {
  invokeDesktopCommand,
  isTauriRuntime,
} from "@/lib/desktopBridge";

interface NativeBridgeStatus {
  running: boolean;
  pid: number | null;
  lastError?: string | null;
  cliAvailable: boolean;
  bridgeEntryPath?: string | null;
  autostartEnabled: boolean;
  platform: string;
  arch: string;
  appVersion: string;
  allowedRoots?: string[];
  diagnosticsJson?: Record<string, unknown> | null;
}

interface UpdateCheckResult {
  available: boolean;
  currentVersion: string;
  latestVersion?: string;
  notes?: string;
  signedManifestVerified?: boolean;
  error?: string;
}

export function DesktopRuntimePanel() {
  const [inDesktop, setInDesktop] = useState(false);
  const [status, setStatus] = useState<NativeBridgeStatus | null>(null);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const refreshStatus = useCallback(async () => {
    if (!isTauriRuntime()) return;
    setBusy(true);
    try {
      const [res, recentLogs] = await Promise.all([
        invokeDesktopCommand<NativeBridgeStatus>("messiah_desktop_status"),
        invokeDesktopCommand<string[]>("messiah_bridge_logs"),
      ]);
      if (res) setStatus(res);
      if (recentLogs) setLogs(recentLogs);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const detected = isTauriRuntime();
    setInDesktop(detected);
    if (detected) {
      refreshStatus();
    }
  }, [refreshStatus]);

  if (!inDesktop) {
    return null;
  }

  const handleStartBridge = async () => {
    setBusy(true);
    try {
      await invokeDesktopCommand("messiah_bridge_start");
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  };

  const handleStopBridge = async () => {
    setBusy(true);
    try {
      await invokeDesktopCommand("messiah_bridge_stop");
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  };

  const handleToggleAutostart = async () => {
    if (!status) return;
    setBusy(true);
    try {
      await invokeDesktopCommand("messiah_set_autostart", {
        enabled: !status.autostartEnabled,
      });
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  };

  const handlePickProjectDirectory = async () => {
    const picked = await invokeDesktopCommand<string | null>("messiah_pick_workspace_directory");
    if (picked) {
      setSelectedFolder(picked);
    }
  };

  const handleCheckUpdate = async () => {
    setBusy(true);
    try {
      const res = await invokeDesktopCommand<UpdateCheckResult>("messiah_check_for_updates");
      if (res) setUpdateResult(res);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="border-[#00F0FF]/30 bg-[#0E121B]">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Laptop2 className="h-4 w-4 text-[#00F0FF]" />
            Tauri Desktop Host & Local Bridge Controls
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant={status?.running ? "emerald" : "outline"}>
              {status?.running ? `Bridge Running (PID ${status.pid ?? "?"})` : "Bridge Stopped"}
            </Badge>
            {status && (
              <Badge variant="cyan">
                {status.platform}/{status.arch} v{status.appVersion}
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          {status?.running ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={handleStopBridge}
              className="border-rose-500/40 text-rose-300"
            >
              <Square className="h-3.5 w-3.5 mr-1.5" />
              Stop Local Bridge
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={busy}
              onClick={handleStartBridge}
              className="bg-[#00FFA3] text-black font-semibold"
            >
              <Play className="h-3.5 w-3.5 mr-1.5" />
              Start Local Bridge
            </Button>
          )}

          <Button size="sm" variant="outline" disabled={busy} onClick={refreshStatus}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Refresh Host State
          </Button>

          <Button size="sm" variant="outline" onClick={handlePickProjectDirectory}>
            <FolderOpen className="h-3.5 w-3.5 mr-1.5" />
            Select Project Folder
          </Button>

          <Button size="sm" variant="outline" disabled={busy} onClick={handleToggleAutostart}>
            Launch at Login: {status?.autostartEnabled ? "ON" : "OFF"}
          </Button>

          <Button size="sm" variant="outline" disabled={busy} onClick={handleCheckUpdate}>
            <Download className="h-3.5 w-3.5 mr-1.5" />
            Check Signed Updates
          </Button>
        </div>

        {selectedFolder && (
          <div className="rounded-lg border border-[#1E2536] bg-[#12151E] p-2.5 font-mono text-[11px] text-[#00F0FF]">
            Selected directory: {selectedFolder} (explicitly authorize roots inside Device Policies below; Desktop never grants silent write access)
          </div>
        )}

        {status?.lastError && (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 text-rose-300 font-mono text-[11px]">
            {status.lastError}
          </div>
        )}

        {updateResult && (
          <div className="flex items-center gap-2 rounded-lg border border-[#1E2536] bg-[#12151E] p-2.5 text-[11px]">
            <ShieldCheck className="h-4 w-4 text-[#00FFA3] shrink-0" />
            <span>
              {updateResult.error
                ? `Update check report: ${updateResult.error}`
                : updateResult.available
                ? `Signed update v${updateResult.latestVersion} ready (${updateResult.notes || "verified signature"}).`
                : `Running latest signed version (v${updateResult.currentVersion}).`}
            </span>
          </div>
        )}

        {logs.length > 0 && (
          <div className="rounded-lg border border-[#1E2536] bg-[#090A0F] p-3">
            <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] uppercase text-[#64748B]">
              <Terminal className="h-3 w-3" />
              Desktop & Bridge Diagnostic Tail
            </div>
            <div className="max-h-36 overflow-y-auto font-mono text-[10px] text-[#94A3B8] space-y-0.5">
              {logs.map((line, i) => (
                <div key={i} className="truncate">
                  {line}
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
