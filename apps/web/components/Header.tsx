"use client";

import React, { useEffect, useState, useRef, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ShieldCheck,
  Terminal,
  Layers,
  LogOut,
  User as UserIcon,
  Briefcase,
  ChevronDown,
  Bell,
  CheckCheck,
  ShieldAlert,
  ExternalLink,
} from "lucide-react";
import { Badge, StatusDot, Button } from "@messiah/ui";
import type {
  NotificationItemInfo,
  UnifiedApprovalItem,
  UserProfile,
  WorkspaceInfo,
} from "@messiah/shared";
import { createClient } from "@/lib/supabase/client";
import {
  isTauriRuntime,
  pickPreferredWorkspace,
  setSavedActiveWorkspaceId,
} from "@/lib/desktopBridge";

interface HeaderProps {
  onToggleSidebar?: () => void;
  activeWorkspace?: WorkspaceInfo | null;
  onWorkspaceChange?: (workspace: WorkspaceInfo) => void;
}

export function Header({
  onToggleSidebar,
  activeWorkspace: initialActiveWorkspace,
  onWorkspaceChange,
}: HeaderProps) {
  const router = useRouter();
  const [backendStatus, setBackendStatus] = useState<
    "checking" | "online" | "offline"
  >("checking");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [currentWorkspace, setCurrentWorkspace] = useState<WorkspaceInfo | null>(
    initialActiveWorkspace || null
  );
  const [authToken, setAuthToken] = useState<string | null>(null);

  const [notifications, setNotifications] = useState<NotificationItemInfo[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [pendingApprovals, setPendingApprovals] = useState<UnifiedApprovalItem[]>([]);

  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isNotifOpen, setIsNotifOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [clientSurface, setClientSurface] = useState<"Web" | "PWA" | "Desktop">("Web");

  const menuRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3001/api/v1/realtime";

  useEffect(() => {
    if (isTauriRuntime()) {
      setClientSurface("Desktop");
    } else if (
      typeof window !== "undefined" &&
      (window.matchMedia?.("(display-mode: standalone)").matches ||
        (navigator as unknown as { standalone?: boolean }).standalone)
    ) {
      setClientSurface("PWA");
    }
  }, []);

  // Close menus on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false);
      }
      if (notifRef.current && !notifRef.current.contains(event.target as Node)) {
        setIsNotifOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  // Monitor Fastify gateway health
  useEffect(() => {
    let isMounted = true;
    const checkHealth = async () => {
      const start = performance.now();
      try {
        const res = await fetch(`${apiUrl}/health/live`, { cache: "no-store" });
        if (res.ok && isMounted) {
          setBackendStatus("online");
          setLatencyMs(Math.round(performance.now() - start));
        } else if (isMounted) {
          setBackendStatus("offline");
        }
      } catch {
        if (isMounted) {
          setBackendStatus("offline");
        }
      }
    };

    checkHealth();
    const interval = setInterval(checkHealth, 20000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [apiUrl]);

  // Fetch user profile & workspaces
  useEffect(() => {
    let isMounted = true;
    async function loadUserData() {
      try {
        const supabase = createClient();
        const {
          data: { session },
        } = await supabase.auth.getSession();

        if (!session?.access_token) return;
        if (isMounted) setAuthToken(session.access_token);

        const [meRes, wsRes] = await Promise.all([
          fetch(`${apiUrl}/api/v1/me`, {
            headers: { Authorization: `Bearer ${session.access_token}` },
          }),
          fetch(`${apiUrl}/api/v1/workspaces`, {
            headers: { Authorization: `Bearer ${session.access_token}` },
          }),
        ]);

        if (meRes.ok && isMounted) {
          const rawMe = await meRes.json();
          setUserProfile(rawMe.data || rawMe);
        }

        if (wsRes.ok && isMounted) {
          const rawWs = await wsRes.json();
          const wsData: WorkspaceInfo[] = Array.isArray(rawWs) ? rawWs : rawWs.data || [];
          setWorkspaces(wsData);
          if (!currentWorkspace && wsData.length > 0) {
            const preferred = pickPreferredWorkspace(wsData);
            if (preferred) {
              setCurrentWorkspace(preferred);
              setSavedActiveWorkspaceId(preferred.id);
              onWorkspaceChange?.(preferred);
            }
          }
        }
      } catch {
        // Ignore transient network errors
      }
    }

    loadUserData();
    return () => {
      isMounted = false;
    };
  }, [apiUrl, currentWorkspace, onWorkspaceChange]);

  const refreshNotifications = useCallback(async () => {
    if (!authToken || !currentWorkspace) return;
    try {
      const [notifRes, appRes] = await Promise.all([
        fetch(`${apiUrl}/api/v1/notifications?workspaceId=${currentWorkspace.id}&limit=25`, {
          headers: { Authorization: `Bearer ${authToken}` },
        }),
        fetch(`${apiUrl}/api/v1/approvals?workspaceId=${currentWorkspace.id}`, {
          headers: { Authorization: `Bearer ${authToken}` },
        }),
      ]);

      if (notifRes.ok) {
        const nb = await notifRes.json();
        const list = nb.data?.notifications || [];
        const unread = nb.data?.unreadCount || 0;
        setNotifications(list);
        setUnreadCount(unread);
      }

      if (appRes.ok) {
        const ab = await appRes.json();
        const apps: UnifiedApprovalItem[] = ab.data || [];
        setPendingApprovals(apps);
        window.dispatchEvent(
          new CustomEvent("messiah:approvals-count", { detail: { count: apps.length } })
        );
      }
    } catch {}
  }, [apiUrl, authToken, currentWorkspace]);

  useEffect(() => {
    refreshNotifications();
  }, [refreshNotifications]);

  // Realtime workspace notification stream & reconnect reconciliation
  useEffect(() => {
    if (!authToken || !currentWorkspace) return;
    let active = true;

    const connectRealtime = async () => {
      try {
        const ticketRes = await fetch(`${apiUrl}/api/v1/realtime/ticket`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ workspaceId: currentWorkspace.id }),
        });
        if (!ticketRes.ok || !active) return;
        const tb = await ticketRes.json();
        const ticket = tb.data?.ticket;
        if (!ticket || !active) return;

        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          ws.send(JSON.stringify({ action: "auth", ticket }));
        };

        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.event === "auth.success") {
              ws.send(
                JSON.stringify({
                  action: "workspace.subscribe",
                  workspaceId: currentWorkspace.id,
                })
              );
            } else if (msg.event === "workspace.snapshot") {
              const snap = msg.data;
              if (snap?.notifications) setNotifications(snap.notifications);
              if (typeof snap?.unreadCount === "number") setUnreadCount(snap.unreadCount);
              if (Array.isArray(snap?.pendingApprovals)) {
                setPendingApprovals(snap.pendingApprovals);
                window.dispatchEvent(
                  new CustomEvent("messiah:approvals-count", {
                    detail: { count: snap.pendingApprovals.length },
                  })
                );
              }
            } else if (
              msg.event === "notification.created" ||
              msg.event === "approval.resolved"
            ) {
              refreshNotifications();
            }
          } catch {}
        };
      } catch {}
    };

    connectRealtime();

    const onReconnect = () => {
      refreshNotifications();
    };
    window.addEventListener("messiah:reconnected", onReconnect);

    return () => {
      active = false;
      window.removeEventListener("messiah:reconnected", onReconnect);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [apiUrl, authToken, currentWorkspace, wsUrl, refreshNotifications]);

  const handleMarkAllRead = async () => {
    if (!authToken || !currentWorkspace) return;
    await fetch(`${apiUrl}/api/v1/notifications/read`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workspaceId: currentWorkspace.id, markAll: true }),
    });
    await refreshNotifications();
  };

  const handleSignOut = async () => {
    setIsSigningOut(true);
    try {
      const supabase = createClient();
      await supabase.auth.signOut();
      router.push("/login");
      router.refresh();
    } catch {
      setIsSigningOut(false);
    }
  };

  const userInitials = userProfile?.fullName
    ? userProfile.fullName
        .split(" ")
        .filter((part: string) => part.length > 0)
        .map((n: string) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : userProfile?.email
      ? userProfile.email.slice(0, 2).toUpperCase()
      : "ME";

  const totalAttention = unreadCount + pendingApprovals.length;

  return (
    <header className="sticky top-0 z-40 flex h-16 w-full items-center justify-between border-b border-[#1E2536] bg-[#090A0F]/85 px-3 sm:px-4 md:px-6 backdrop-blur-xl">
      <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
        {onToggleSidebar && (
          <button
            type="button"
            onClick={onToggleSidebar}
            className="flex h-10 w-10 items-center justify-center rounded-lg border border-[#1E2536] bg-[#12151E] text-[#94A3B8] hover:text-[#F0F4FC] md:hidden shrink-0"
            aria-label="Toggle navigation menu"
          >
            <Layers className="h-4 w-4" />
          </button>
        )}
        <Link href="/" className="flex items-center gap-2.5 min-w-0">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-[#00F0FF] to-[#0080FF] shadow-[0_0_15px_rgba(0,240,255,0.3)]">
            <Terminal className="h-4 w-4 text-[#090A0F]" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 sm:gap-2">
              <span className="font-mono text-sm font-bold tracking-widest text-[#F0F4FC]">
                MESSIAH
              </span>
              <span className="rounded bg-[#00F0FF]/10 px-1.5 py-0.5 text-[10px] font-mono text-[#00F0FF]">
                v1.0
              </span>
              <span className="hidden sm:inline-block rounded bg-[#1E2536] px-1.5 py-0.5 text-[10px] font-mono text-[#94A3B8]">
                {clientSurface}
              </span>
            </div>
            <p className="hidden text-[11px] text-[#64748B] sm:block">
              Universal AI Agent Workspace
            </p>
          </div>
        </Link>

        {/* Workspace Indicator Badge */}
        {currentWorkspace && (
          <div className="hidden md:flex items-center gap-2 ml-4 pl-4 border-l border-[#1E2536]">
            <div className="flex items-center gap-1.5 rounded-md border border-[#1E2536] bg-[#12151E] px-2.5 py-1 text-xs text-[#F0F4FC]">
              <Briefcase className="h-3.5 w-3.5 text-[#00F0FF]" />
              <span className="font-medium max-w-[140px] truncate">
                {currentWorkspace.name}
              </span>
              <span className="ml-1 rounded bg-[#00FFA3]/10 px-1.5 py-0.5 text-[10px] font-mono text-[#00FFA3]">
                {currentWorkspace.role}
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 sm:gap-3">
        {/* Pending Approvals Quick Chip */}
        {pendingApprovals.length > 0 && (
          <Link
            href="/approvals"
            className="hidden sm:flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs font-mono text-amber-300 hover:bg-amber-500/20 transition-colors"
          >
            <ShieldAlert className="h-3.5 w-3.5" />
            <span>{pendingApprovals.length} Approval{pendingApprovals.length === 1 ? "" : "s"}</span>
          </Link>
        )}

        {/* Backend Connectivity Telemetry */}
        <div className="hidden lg:flex items-center gap-2 rounded-lg border border-[#1E2536] bg-[#12151E]/90 px-3 py-1.5">
          <StatusDot
            status={
              backendStatus === "online"
                ? "online"
                : backendStatus === "offline"
                  ? "error"
                  : "busy"
            }
            pulse={backendStatus === "online"}
          />
          <span className="text-xs font-mono text-[#94A3B8]">
            {backendStatus === "online"
              ? `Online ${latencyMs !== null ? `(${latencyMs}ms)` : ""}`
              : backendStatus === "checking"
                ? "Probing..."
                : "Offline"}
          </span>
        </div>

        {/* Security Baseline Badge */}
        <div className="hidden xl:flex items-center gap-1.5 rounded-lg border border-[#00FFA3]/20 bg-[#00FFA3]/5 px-3 py-1.5">
          <ShieldCheck className="h-3.5 w-3.5 text-[#00FFA3]" />
          <span className="text-xs font-mono text-[#00FFA3]">
            Zero-Trust
          </span>
        </div>

        {/* Notification Bell & Cross-Device Feed Drawer */}
        <div className="relative" ref={notifRef}>
          <button
            type="button"
            onClick={() => setIsNotifOpen((prev) => !prev)}
            className="relative flex h-10 w-10 items-center justify-center rounded-lg border border-[#1E2536] bg-[#12151E] text-[#94A3B8] hover:border-[#2A344D] hover:text-[#F0F4FC]"
            aria-label="Notifications"
          >
            <Bell className="h-4 w-4" />
            {totalAttention > 0 && (
              <span className="absolute -top-1 -right-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#FFB800] px-1 font-mono text-[10px] font-bold text-[#090A0F]">
                {totalAttention > 99 ? "99+" : totalAttention}
              </span>
            )}
          </button>

          {isNotifOpen && (
            <div className="absolute right-0 mt-2 w-80 sm:w-96 rounded-xl border border-[#1E2536] bg-[#0E111A] shadow-2xl backdrop-blur-2xl z-50 overflow-hidden">
              <div className="flex items-center justify-between border-b border-[#1E2536] px-4 py-3">
                <div>
                  <h2 className="text-xs font-semibold text-[#F0F4FC]">Notifications & Approvals</h2>
                  <p className="text-[10px] text-[#64748B]">
                    {pendingApprovals.length} pending approvals · {unreadCount} unread
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {unreadCount > 0 && (
                    <button
                      type="button"
                      onClick={handleMarkAllRead}
                      className="text-[11px] font-mono text-[#00F0FF] hover:underline flex items-center gap-1"
                    >
                      <CheckCheck className="h-3 w-3" />
                      Clear unread
                    </button>
                  )}
                </div>
              </div>

              <div className="max-h-80 overflow-y-auto divide-y divide-[#1E2536]/60">
                {notifications.length === 0 && pendingApprovals.length === 0 ? (
                  <div className="p-6 text-center text-xs text-[#64748B]">
                    No pending alerts or notifications in this workspace.
                  </div>
                ) : (
                  notifications.slice(0, 10).map((n) => (
                    <Link
                      key={n.id}
                      href={n.deepLink || "/approvals"}
                      onClick={() => setIsNotifOpen(false)}
                      className={`block px-4 py-3 text-xs transition-colors hover:bg-[#12151E] ${
                        !n.readAt ? "bg-[#00F0FF]/[0.04]" : ""
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-[#F0F4FC] truncate">{n.title}</span>
                        <ExternalLink className="h-3 w-3 text-[#64748B] shrink-0" />
                      </div>
                      <p className="mt-1 text-[11px] text-[#94A3B8] line-clamp-2">{n.preview}</p>
                      <span className="mt-1 block font-mono text-[10px] text-[#64748B]">
                        {n.category} · {new Date(n.createdAt).toLocaleTimeString()}
                      </span>
                    </Link>
                  ))
                )}
              </div>

              <div className="flex items-center justify-between border-t border-[#1E2536] bg-[#090A0F]/60 px-4 py-2.5 text-[11px]">
                <Link
                  href="/approvals"
                  onClick={() => setIsNotifOpen(false)}
                  className="font-mono text-[#FFB800] hover:underline"
                >
                  Open Approval Queue ({pendingApprovals.length})
                </Link>
                <Link
                  href="/settings/notifications"
                  onClick={() => setIsNotifOpen(false)}
                  className="font-mono text-[#00F0FF] hover:underline"
                >
                  Preferences
                </Link>
              </div>
            </div>
          )}
        </div>

        {/* User Account / Profile Dropdown Menu */}
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            className="flex h-10 items-center gap-2 rounded-lg border border-[#1E2536] bg-[#12151E] px-2 hover:border-[#2A344D] hover:bg-[#181C28] transition-colors"
            aria-label="User Account Menu"
          >
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-tr from-[#1E2536] to-[#2A344D] text-[11px] font-mono font-semibold text-[#00F0FF] border border-[#00F0FF]/20">
              {userInitials}
            </div>
            <div className="hidden text-left md:block pr-1">
              <p className="text-xs font-medium text-[#F0F4FC] leading-none max-w-[120px] truncate">
                {userProfile?.fullName || "Architect"}
              </p>
              <p className="text-[10px] text-[#64748B] leading-none mt-1 max-w-[120px] truncate">
                {userProfile?.email || "Signed In"}
              </p>
            </div>
            <ChevronDown className="h-3.5 w-3.5 text-[#64748B]" />
          </button>

          {isMenuOpen && (
            <div className="absolute right-0 mt-2 w-64 rounded-xl border border-[#1E2536] bg-[#0E111A] p-2 shadow-2xl backdrop-blur-2xl z-50">
              <div className="border-b border-[#1E2536] p-2.5">
                <div className="flex items-center gap-2">
                  <UserIcon className="h-4 w-4 text-[#00F0FF]" />
                  <span className="text-xs font-semibold text-[#F0F4FC] truncate">
                    {userProfile?.fullName || "Messiah User"}
                  </span>
                </div>
                <p className="text-[11px] font-mono text-[#64748B] truncate mt-0.5">
                  {userProfile?.email || "Signed in"}
                </p>
                {currentWorkspace?.role && (
                  <div className="mt-2 flex items-center gap-2">
                    <Badge variant="cyan">{currentWorkspace.role}</Badge>
                    <Badge variant="outline">{clientSurface}</Badge>
                  </div>
                )}
              </div>

              <div className="p-2.5 border-b border-[#1E2536]">
                <p className="text-[10px] font-mono uppercase tracking-wider text-[#64748B] mb-1.5">
                  Switch Workspace ({workspaces.length})
                </p>
                <div className="space-y-1 max-h-36 overflow-y-auto">
                  {workspaces.map((ws) => (
                    <button
                      type="button"
                      key={ws.id}
                      onClick={() => {
                        setCurrentWorkspace(ws);
                        setSavedActiveWorkspaceId(ws.id);
                        onWorkspaceChange?.(ws);
                        setIsMenuOpen(false);
                        router.refresh();
                      }}
                      className={`flex w-full items-center justify-between rounded-md p-1.5 text-xs transition-colors ${
                        currentWorkspace?.id === ws.id
                          ? "bg-[#1E2536] text-[#00F0FF]"
                          : "text-[#94A3B8] hover:bg-[#12151E] hover:text-[#F0F4FC]"
                      }`}
                    >
                      <span className="truncate max-w-[140px]">{ws.name}</span>
                      <span className="text-[10px] font-mono text-[#64748B]">
                        {ws.role}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="p-1.5 space-y-1 border-b border-[#1E2536]">
                <Link
                  href="/settings/notifications"
                  onClick={() => setIsMenuOpen(false)}
                  className="block rounded-md px-2 py-1.5 text-xs text-[#94A3B8] hover:bg-[#12151E] hover:text-[#F0F4FC]"
                >
                  Notification & Security Settings
                </Link>
                <Link
                  href="/audit"
                  onClick={() => setIsMenuOpen(false)}
                  className="block rounded-md px-2 py-1.5 text-xs text-[#94A3B8] hover:bg-[#12151E] hover:text-[#F0F4FC]"
                >
                  Workspace Audit Logs
                </Link>
              </div>

              <div className="p-1 pt-1.5">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleSignOut}
                  isLoading={isSigningOut}
                  className="w-full justify-start text-xs font-mono"
                >
                  <LogOut className="h-3.5 w-3.5 mr-2" />
                  Sign Out
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
