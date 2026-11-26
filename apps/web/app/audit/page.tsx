"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, RefreshCw, ShieldCheck } from "lucide-react";
import { Badge, Button, Card, CardContent } from "@messiah/ui";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { createClient } from "@/lib/supabase/client";
import { pickPreferredWorkspace } from "@/lib/desktopBridge";
import type { AuditLogEntryInfo, WorkspaceInfo } from "@messiah/shared";

export default function AuditLogsPage() {
  const router = useRouter();
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [logs, setLogs] = useState<AuditLogEntryInfo[]>([]);
  const [actionFilter, setActionFilter] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadLogs = useCallback(async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) {
        router.push("/login?redirect=/audit");
        return;
      }

      const wsRes = await fetch(`${apiUrl}/api/v1/workspaces`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!wsRes.ok) return;
      const rawWs = await wsRes.json();
      const wsList: WorkspaceInfo[] = Array.isArray(rawWs) ? rawWs : rawWs.data || [];
      const ws = workspace || pickPreferredWorkspace(wsList);
      if (!ws) return;
      setWorkspace(ws);

      const url = new URL(`${apiUrl}/api/v1/audit-logs`);
      url.searchParams.set("workspaceId", ws.id);
      if (actionFilter.trim()) url.searchParams.set("action", actionFilter.trim());

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const json = await res.json();
      if (!res.ok) {
        setErrorMsg(json.error?.message || "Unable to fetch audit logs.");
      } else {
        setLogs(json.data || []);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed loading audit trail.");
    } finally {
      setIsLoading(false);
    }
  }, [apiUrl, router, workspace, actionFilter]);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

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
          activeTab="audit"
          onSelectTab={() => {}}
        />

        <main className="flex-1 overflow-y-auto p-4 md:p-8 space-y-6">
          <div className="mx-auto max-w-6xl space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h1 className="text-xl font-semibold flex items-center gap-2">
                  <FileText className="h-5 w-5 text-[#00F0FF]" />
                  Security & Governance Audit Trail
                </h1>
                <p className="text-xs text-[#94A3B8] mt-1">
                  Immutable, secret-redacted compliance log of provider connections, device pairing, approvals, workflows, and security actions.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <input
                  value={actionFilter}
                  onChange={(e) => setActionFilter(e.target.value)}
                  placeholder="Filter action (e.g. tool_approval_decided)"
                  className="h-9 rounded-lg border border-[#1E2536] bg-[#12151E] px-3 text-xs text-[#F0F4FC] placeholder-[#64748B]"
                />
                <Button variant="outline" size="sm" onClick={loadLogs} isLoading={isLoading} className="font-mono text-xs">
                  <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                  Refresh
                </Button>
              </div>
            </div>

            {errorMsg && (
              <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">
                {errorMsg}
              </div>
            )}

            <Card className="border-[#1E2536] bg-[#0E121B]">
              <CardContent className="p-0 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-[#1E2536] bg-[#12151E]/80 font-mono text-[10px] uppercase text-[#64748B]">
                    <tr>
                      <th className="px-4 py-3">Timestamp</th>
                      <th className="px-4 py-3">Action</th>
                      <th className="px-4 py-3">Resource</th>
                      <th className="px-4 py-3">Actor</th>
                      <th className="px-4 py-3">Sanitized Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1E2536]/60">
                    {logs.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-10 text-center text-[#64748B]">
                          <ShieldCheck className="h-6 w-6 text-[#00FFA3] mx-auto mb-2" />
                          No audit log entries match the current filter.
                        </td>
                      </tr>
                    ) : (
                      logs.map((entry) => (
                        <tr key={entry.id} className="hover:bg-[#12151E]/40">
                          <td className="px-4 py-3 font-mono text-[11px] text-[#94A3B8] whitespace-nowrap">
                            {new Date(entry.createdAt).toLocaleString()}
                          </td>
                          <td className="px-4 py-3">
                            <Badge variant="cyan">{entry.action}</Badge>
                          </td>
                          <td className="px-4 py-3 font-mono text-[11px] text-[#CBD5E1]">
                            {entry.resourceType}
                            {entry.resourceId ? ` (${entry.resourceId.slice(0, 8)})` : ""}
                          </td>
                          <td className="px-4 py-3 text-[11px] text-[#94A3B8]">
                            {entry.actorEmail || entry.actorName || "System"}
                          </td>
                          <td className="px-4 py-3 font-mono text-[10px] text-[#64748B] max-w-md truncate">
                            {JSON.stringify(entry.details)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </div>
        </main>
      </div>
    </div>
  );
}
