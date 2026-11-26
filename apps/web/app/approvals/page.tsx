"use client";

import React, { useCallback, useEffect, useState, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ShieldAlert,
  ShieldCheck,
  Check,
  X,
  Clock,
  ExternalLink,
  RefreshCw,
  Laptop2,
  Cpu,
  Workflow,
  GitFork,
} from "lucide-react";
import { Badge, Button, Card, CardContent } from "@messiah/ui";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { createClient } from "@/lib/supabase/client";
import { pickPreferredWorkspace } from "@/lib/desktopBridge";
import type { UnifiedApprovalItem, WorkspaceInfo } from "@messiah/shared";

function ApprovalsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const focusedId = searchParams.get("id");

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [items, setItems] = useState<UnifiedApprovalItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const loadApprovals = useCallback(async () => {
    setIsLoading(true);
    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) {
        router.push("/login?redirect=/approvals");
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

      const appRes = await fetch(`${apiUrl}/api/v1/approvals?workspaceId=${ws.id}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (appRes.ok) {
        const body = await appRes.json();
        const nextItems: UnifiedApprovalItem[] = body.data || [];
        setItems(nextItems);
        window.dispatchEvent(
          new CustomEvent("messiah:approvals-count", { detail: { count: nextItems.length } })
        );
      }
    } catch (err) {
      setFeedback({
        kind: "err",
        text: err instanceof Error ? err.message : "Failed to load approval queue.",
      });
    } finally {
      setIsLoading(false);
    }
  }, [apiUrl, router, workspace]);

  useEffect(() => {
    loadApprovals();
    const onReconnect = () => loadApprovals();
    const onWsChange = () => {
      setWorkspace(null);
      loadApprovals();
    };
    window.addEventListener("messiah:reconnected", onReconnect);
    window.addEventListener("messiah:workspace-changed", onWsChange);
    return () => {
      window.removeEventListener("messiah:reconnected", onReconnect);
      window.removeEventListener("messiah:workspace-changed", onWsChange);
    };
  }, [loadApprovals]);

  const decideItem = async (item: UnifiedApprovalItem, decision: "approve" | "reject") => {
    if (!authToken || !workspace) return;
    setBusyId(item.id);
    setFeedback(null);

    try {
      let url = "";
      let body: Record<string, unknown> = { workspaceId: workspace.id };

      if (item.kind === "MCP_TOOL") {
        url = `${apiUrl}/api/v1/tool-approvals/${item.resourceId}/${
          decision === "approve" ? "approve" : "deny"
        }`;
        if (decision === "reject") body.reason = "Denied from cross-device approval center.";
      } else if (item.kind === "BRIDGE_TASK") {
        url = `${apiUrl}/api/v1/devices/tasks/${item.resourceId}/${
          decision === "approve" ? "approve" : "reject"
        }`;
        if (decision === "reject") body.reason = "Rejected from cross-device approval center.";
      } else if (item.kind === "WORKFLOW_GATE") {
        url = `${apiUrl}/api/v1/workflows/approvals/${item.resourceId}/${
          decision === "approve" ? "approve" : "reject"
        }`;
        if (decision === "reject") body.reason = "Rejected at workflow gate.";
      } else if (item.kind === "SWARM_PLAN") {
        url = `${apiUrl}/api/v1/swarms/${item.resourceId}/approve-plan`;
        body = {
          workspaceId: workspace.id,
          action: decision === "approve" ? "approve" : "reject",
          ...(decision === "reject" ? { rejectionReason: "Plan rejected by administrator." } : {}),
        };
      }

      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const json = await res.json();

      if (!res.ok) {
        setFeedback({
          kind: "err",
          text: json.error?.message || "This request may have already been decided or expired.",
        });
      } else {
        setFeedback({
          kind: "ok",
          text: `${item.title} ${decision === "approve" ? "approved" : "denied"} and resumed cleanly.`,
        });
      }
      await loadApprovals();
    } catch (err) {
      setFeedback({
        kind: "err",
        text: err instanceof Error ? err.message : "Network error while submitting decision.",
      });
    } finally {
      setBusyId(null);
    }
  };

  const renderIcon = (kind: UnifiedApprovalItem["kind"]) => {
    switch (kind) {
      case "BRIDGE_TASK":
        return <Laptop2 className="h-4 w-4 text-[#38BDF8]" />;
      case "WORKFLOW_GATE":
        return <Workflow className="h-4 w-4 text-amber-400" />;
      case "SWARM_PLAN":
        return <GitFork className="h-4 w-4 text-indigo-400" />;
      default:
        return <Cpu className="h-4 w-4 text-[#00F0FF]" />;
    }
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
          activeTab="approvals"
          onSelectTab={() => {}}
        />

        <main className="flex-1 overflow-y-auto p-4 md:p-8 space-y-6">
          <div className="mx-auto max-w-4xl space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-xl font-semibold text-[#F0F4FC] flex items-center gap-2">
                  <ShieldAlert className="h-5 w-5 text-amber-400" />
                  Cross-Device Approval Queue
                </h1>
                <p className="text-xs text-[#94A3B8] mt-1">
                  Inspect parameters before approving MCP tools, Workstation commands, Swarm plans, or Workflow gates. Nothing is ever approved automatically on notification open.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={loadApprovals} isLoading={isLoading} className="font-mono text-xs">
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                Reconcile
              </Button>
            </div>

            {feedback && (
              <div
                className={`rounded-xl border p-3 text-xs ${
                  feedback.kind === "ok"
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                    : "border-rose-500/40 bg-rose-500/10 text-rose-200"
                }`}
              >
                {feedback.text}
              </div>
            )}

            {isLoading && items.length === 0 ? (
              <div className="py-16 text-center text-xs text-[#64748B] font-mono">
                Synchronizing authoritative approvals with backend...
              </div>
            ) : items.length === 0 ? (
              <Card className="border-[#1E2536] bg-[#0E121B]">
                <CardContent className="p-10 text-center space-y-3">
                  <ShieldCheck className="h-10 w-10 text-[#00FFA3] mx-auto" />
                  <h2 className="text-sm font-semibold">All Caught Up</h2>
                  <p className="text-xs text-[#94A3B8] max-w-md mx-auto">
                    There are zero pending approvals in {workspace?.name || "this workspace"}. Any new request pushed to web, desktop, or mobile will appear here immediately.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-4">
                {items.map((item) => {
                  const isFocused = focusedId && (item.id === focusedId || item.resourceId === focusedId);
                  return (
                    <Card
                      key={`${item.kind}-${item.id}`}
                      className={`border bg-[#0E121B] transition-all ${
                        isFocused
                          ? "border-[#00F0FF] shadow-[0_0_25px_rgba(0,240,255,0.18)]"
                          : "border-amber-500/35"
                      }`}
                    >
                      <CardContent className="p-4 sm:p-5 space-y-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="flex items-start gap-3">
                            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#1E2536] bg-[#12151E]">
                              {renderIcon(item.kind)}
                            </div>
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-semibold text-[#F0F4FC]">
                                  {item.title}
                                </span>
                                <Badge variant="outline">{item.kind}</Badge>
                              </div>
                              <p className="mt-1 text-xs text-[#94A3B8]">{item.summary}</p>
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            {item.expiresAt && (
                              <span className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] text-amber-300">
                                <Clock className="h-3 w-3" />
                                Exp {new Date(item.expiresAt).toLocaleTimeString()}
                              </span>
                            )}
                            <Link
                              href={item.deepLink}
                              className="inline-flex items-center gap-1 rounded border border-[#1E2536] bg-[#12151E] px-2 py-1 text-[11px] font-mono text-[#00F0FF] hover:border-[#00F0FF]/50"
                            >
                              Inspect <ExternalLink className="h-3 w-3" />
                            </Link>
                          </div>
                        </div>

                        <div className="rounded-lg border border-[#1E2536] bg-[#090A0F] p-3 font-mono text-[11px] text-[#CBD5E1] overflow-x-auto max-h-44">
                          <pre>{JSON.stringify(item.previewDetails, null, 2)}</pre>
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                          <span className="font-mono text-[10px] text-[#64748B]">
                            Queued {new Date(item.createdAt).toLocaleString()}
                            {item.deviceName ? ` · Device: ${item.deviceName}` : ""}
                          </span>
                          <div className="flex items-center gap-2 w-full sm:w-auto">
                            <Button
                              variant="outline"
                              disabled={busyId === item.id}
                              onClick={() => decideItem(item, "reject")}
                              className="flex-1 sm:flex-initial min-h-[42px] border-rose-500/40 text-rose-300 hover:bg-rose-500/10 text-xs"
                            >
                              <X className="h-3.5 w-3.5 mr-1.5" />
                              Reject
                            </Button>
                            <Button
                              disabled={busyId === item.id}
                              onClick={() => decideItem(item, "approve")}
                              className="flex-1 sm:flex-initial min-h-[42px] bg-[#00FFA3] text-black hover:bg-[#00FFA3]/90 font-semibold text-xs"
                            >
                              <Check className="h-3.5 w-3.5 mr-1.5" />
                              {busyId === item.id ? "Applying..." : "Approve Execution"}
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

export default function ApprovalsPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#090A0F]" />}>
      <ApprovalsContent />
    </Suspense>
  );
}
