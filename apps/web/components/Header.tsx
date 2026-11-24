"use client";

import React, { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  ShieldCheck,
  Terminal,
  Layers,
  LogOut,
  User as UserIcon,
  Briefcase,
  ChevronDown,
} from "lucide-react";
import { Badge, StatusDot, Button } from "@messiah/ui";
import type { UserProfile, WorkspaceInfo } from "@messiah/shared";
import { createClient } from "@/lib/supabase/client";

interface HeaderProps {
  onToggleSidebar?: () => void;
  activeWorkspace?: WorkspaceInfo | null;
  onWorkspaceChange?: (workspace: WorkspaceInfo) => void;
}

export function Header({
  onToggleSidebar,
  activeWorkspace: initialActiveWorkspace,
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
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false);
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
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

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
    const interval = setInterval(checkHealth, 15000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  // Fetch authenticated user profile & workspaces from Messiah Fastify Backend
  useEffect(() => {
    let isMounted = true;

    async function loadUserData() {
      try {
        const supabase = createClient();
        const {
          data: { session },
        } = await supabase.auth.getSession();

        if (!session?.access_token) {
          return;
        }

        const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

        // 1. Fetch user profile (which idempotently creates user + personal workspace)
        const meRes = await fetch(`${apiUrl}/api/v1/me`, {
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        });

        if (meRes.ok && isMounted) {
          const profileData: UserProfile = await meRes.json();
          setUserProfile(profileData);
        }

        // 2. Fetch accessible workspaces
        const wsRes = await fetch(`${apiUrl}/api/v1/workspaces`, {
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        });

        if (wsRes.ok && isMounted) {
          const wsData: WorkspaceInfo[] = await wsRes.json();
          setWorkspaces(wsData);
          if (wsData.length > 0 && !currentWorkspace && wsData[0]) {
            setCurrentWorkspace(wsData[0]);
          }
        }
      } catch {
        // Backend or network error handling
      }
    }

    loadUserData();

    return () => {
      isMounted = false;
    };
  }, [currentWorkspace]);

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

  return (
    <header className="sticky top-0 z-40 flex h-16 w-full items-center justify-between border-b border-[#1E2536] bg-[#090A0F]/80 px-4 md:px-6 backdrop-blur-xl">
      <div className="flex items-center gap-3">
        {onToggleSidebar && (
          <button
            onClick={onToggleSidebar}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#1E2536] bg-[#12151E] text-[#94A3B8] hover:text-[#F0F4FC] md:hidden"
            aria-label="Toggle navigation menu"
          >
            <Layers className="h-4 w-4" />
          </button>
        )}
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-[#00F0FF] to-[#0080FF] shadow-[0_0_15px_rgba(0,240,255,0.3)]">
            <Terminal className="h-4 w-4 text-[#090A0F]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-bold tracking-widest text-[#F0F4FC]">
                MESSIAH
              </span>
              <span className="rounded bg-[#00F0FF]/10 px-1.5 py-0.2 text-[10px] font-mono text-[#00F0FF]">
                PHASE 1B
              </span>
            </div>
            <p className="hidden text-[11px] text-[#64748B] sm:block">
              Universal AI Agent Workspace
            </p>
          </div>
        </div>

        {/* Workspace Indicator Badge */}
        {currentWorkspace && (
          <div className="hidden md:flex items-center gap-2 ml-4 pl-4 border-l border-[#1E2536]">
            <div className="flex items-center gap-1.5 rounded-md border border-[#1E2536] bg-[#12151E] px-2.5 py-1 text-xs text-[#F0F4FC]">
              <Briefcase className="h-3.5 w-3.5 text-[#00F0FF]" />
              <span className="font-medium max-w-[140px] truncate">
                {currentWorkspace.name}
              </span>
              <span className="ml-1 rounded bg-[#00FFA3]/10 px-1.5 py-0.2 text-[10px] font-mono text-[#00FFA3]">
                {currentWorkspace.role}
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 sm:gap-4">
        {/* Backend Connectivity Telemetry */}
        <div className="hidden sm:flex items-center gap-2 rounded-lg border border-[#1E2536] bg-[#12151E]/90 px-3 py-1.5">
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
              ? `Gateway Online ${latencyMs !== null ? `(${latencyMs}ms)` : ""}`
              : backendStatus === "checking"
                ? "Probing Gateway..."
                : "Gateway Offline"}
          </span>
        </div>

        {/* Security Baseline Badge */}
        <div className="hidden lg:flex items-center gap-1.5 rounded-lg border border-[#00FFA3]/20 bg-[#00FFA3]/5 px-3 py-1.5">
          <ShieldCheck className="h-3.5 w-3.5 text-[#00FFA3]" />
          <span className="text-xs font-mono text-[#00FFA3]">
            Zero-Trust Enforced
          </span>
        </div>

        {/* User Account / Profile Dropdown Menu */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            className="flex items-center gap-2 rounded-lg border border-[#1E2536] bg-[#12151E] p-1.5 hover:border-[#2A344D] hover:bg-[#181C28] transition-colors"
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
              {/* User summary */}
              <div className="border-b border-[#1E2536] p-2.5">
                <div className="flex items-center gap-2">
                  <UserIcon className="h-4 w-4 text-[#00F0FF]" />
                  <span className="text-xs font-semibold text-[#F0F4FC] truncate">
                    {userProfile?.fullName || "Messiah User"}
                  </span>
                </div>
                <p className="text-[11px] font-mono text-[#64748B] truncate mt-0.5">
                  {userProfile?.email || "No email"}
                </p>
                {currentWorkspace?.role && (
                  <div className="mt-2">
                    <Badge variant="cyan">
                      {currentWorkspace.role}
                    </Badge>
                  </div>
                )}
              </div>

              {/* Workspace details */}
              <div className="p-2.5 border-b border-[#1E2536]">
                <p className="text-[10px] font-mono uppercase tracking-wider text-[#64748B] mb-1.5">
                  Workspaces ({workspaces.length})
                </p>
                <div className="space-y-1">
                  {workspaces.map((ws) => (
                    <button
                      key={ws.id}
                      onClick={() => {
                        setCurrentWorkspace(ws);
                        setIsMenuOpen(false);
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

              {/* Actions */}
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
