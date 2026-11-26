"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  ShieldCheck,
  XCircle,
  Check,
  X,
  StopCircle,
  RefreshCw,
} from "lucide-react";
import { Button, Badge, Card, CardContent } from "@messiah/ui";
import { createClient } from "@/lib/supabase/client";
import { WorkflowCanvas } from "@/components/workflows/WorkflowCanvas";
import { ToolApprovalCard } from "@/components/tools/ToolApprovalCard";
import { BridgeTaskCard } from "@/components/BridgeTaskCard";
import type {
  WorkflowNodeStatus,
  WorkflowRunDetail,
  WorkspaceInfo,
} from "@messiah/shared";

export default function WorkflowRunDetailPage() {
  const params = useParams();
  const runId = String(params?.runId || "");
  const router = useRouter();
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

  const [authToken, setAuthToken] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [detail, setDetail] = useState<WorkflowRunDetail | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const loadDetail = useCallback(async () => {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token) {
      router.push("/login");
      return;
    }
    setAuthToken(session.access_token);

    let wsObj = workspace;
    if (!wsObj) {
      const wsRes = await fetch(`${apiUrl}/api/v1/workspaces`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!wsRes.ok) return;
      wsObj = ((await wsRes.json()).data || [])[0] || null;
      setWorkspace(wsObj);
    }
    if (!wsObj) return;

    const runRes = await fetch(
      `${apiUrl}/api/v1/workflows/runs/${runId}?workspaceId=${wsObj.id}`,
      { headers: { Authorization: `Bearer ${session.access_token}` } }
    );
    if (runRes.ok) {
      setDetail((await runRes.json()).data);
    } else {
      setErrorMsg("Unable to fetch workflow run detail.");
    }
  }, [apiUrl, router, runId, workspace]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  // Live WebSocket subscription + polling fallback while non-terminal
  useEffect(() => {
    if (!authToken || !workspace || !detail) return;
    const isTerminal =
      detail.status === "COMPLETED" ||
      detail.status === "PARTIAL_COMPLETED" ||
      detail.status === "FAILED" ||
      detail.status === "CANCELLED";
    if (isTerminal) return;

    const interval = setInterval(() => {
      loadDetail().catch(() => {});
    }, 3000);

    let cancelled = false;
    (async () => {
      try {
        const ticketRes = await fetch(`${apiUrl}/api/v1/realtime/ticket`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({ workspaceId: workspace.id }),
        });
        if (!ticketRes.ok || cancelled) return;
        const ticketData = (await ticketRes.json()).data;
        const wsProtoUrl = apiUrl.replace(/^http/, "ws") + "/api/v1/realtime";
        const sock = new WebSocket(wsProtoUrl);
        wsRef.current = sock;

        sock.onopen = () => {
          sock.send(JSON.stringify({ action: "auth", ticket: ticketData.ticket }));
          sock.send(JSON.stringify({ action: "workflow.subscribe", runId }));
        };
        sock.onmessage = () => {
          loadDetail().catch(() => {});
        };
      } catch {}
    })();

    return () => {
      cancelled = true;
      clearInterval(interval);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [authToken, workspace, detail?.status, apiUrl, runId, loadDetail]);

  const handleDecision = async (approvalId: string, decision: "approve" | "reject") => {
    if (!authToken || !workspace) return;
    const res = await fetch(`${apiUrl}/api/v1/workflows/approvals/${approvalId}/${decision}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ workspaceId: workspace.id }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setErrorMsg(json.error?.message || "Failed to submit approval decision.");
      return;
    }
    await loadDetail();
  };

  const handleCancel = async () => {
    if (!authToken || !workspace) return;
    await fetch(`${apiUrl}/api/v1/workflows/runs/${runId}/cancel`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ workspaceId: workspace.id }),
    });
    await loadDetail();
  };

  const handleToolApprove = async (approvalId: string) => {
    if (!authToken || !workspace) return;
    await fetch(`${apiUrl}/api/v1/tool-approvals/${approvalId}/approve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ workspaceId: workspace.id }),
    });
    await loadDetail();
  };

  const handleToolDeny = async (approvalId: string, reason?: string) => {
    if (!authToken || !workspace) return;
    await fetch(`${apiUrl}/api/v1/tool-approvals/${approvalId}/deny`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ workspaceId: workspace.id, reason }),
    });
    await loadDetail();
  };

  const handleBridgeDecision = async (
    taskId: string,
    action: "approve" | "reject" | "cancel",
    reason?: string
  ) => {
    if (!authToken || !workspace) return;
    await fetch(`${apiUrl}/api/v1/devices/tasks/${taskId}/${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ workspaceId: workspace.id, ...(reason ? { reason } : {}) }),
    });
    await loadDetail();
  };

  const nodeStatusMap: Record<string, WorkflowNodeStatus> = {};
  if (detail) {
    for (const ne of detail.nodeExecutions) {
      nodeStatusMap[ne.nodeId] = ne.status;
    }
  }

  const selectedExec =
    detail?.nodeExecutions.find((ne) => ne.nodeId === selectedNodeId) || null;
  const pendingWorkflowApprovals =
    detail?.approvals.filter((a) => a.status === "PENDING") || [];

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#090A0F] text-[#F0F4FC]">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1E2536] bg-[#12151E] px-5 py-3">
        <div className="flex items-center gap-3">
          <Link
            href="/workflows"
            className="flex items-center gap-1 rounded-lg border border-[#1E2536] px-2.5 py-1.5 text-xs text-[#8E9BB4] hover:text-[#F0F4FC]"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Workflows
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-semibold">
                {detail?.workflowName || "Workflow Execution"}
              </h1>
              {detail && (
                <Badge
                  variant="outline"
                  className={
                    detail.status === "COMPLETED"
                      ? "border-[#00FFA3]/40 text-[#00FFA3]"
                      : detail.status === "AWAITING_APPROVAL"
                      ? "border-amber-400/50 text-amber-300"
                      : detail.status === "FAILED"
                      ? "border-rose-500/50 text-rose-300"
                      : "border-[#00F0FF]/40 text-[#00F0FF]"
                  }
                >
                  {detail.status}
                </Badge>
              )}
            </div>
            <p className="text-[11px] text-[#8E9BB4]">Run ID: {runId}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={loadDetail} className="border-[#1E2536] text-xs">
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Refresh
          </Button>
          {detail &&
            detail.status !== "COMPLETED" &&
            detail.status !== "PARTIAL_COMPLETED" &&
            detail.status !== "FAILED" &&
            detail.status !== "CANCELLED" && (
              <Button
                variant="outline"
                onClick={handleCancel}
                className="border-rose-500/40 bg-rose-500/10 text-xs text-rose-300"
              >
                <StopCircle className="mr-1.5 h-3.5 w-3.5" /> Cancel Run
              </Button>
            )}
        </div>
      </header>

      {errorMsg && (
        <div className="border-b border-rose-500/40 bg-rose-500/10 px-5 py-2 text-xs text-rose-300">
          {errorMsg}
        </div>
      )}

      {/* Pending Workflow Approval Gates Banner */}
      {pendingWorkflowApprovals.length > 0 && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-5 py-3 space-y-2">
          {pendingWorkflowApprovals.map((app) => (
            <div key={app.id} className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 text-xs">
                <ShieldCheck className="h-4 w-4 text-amber-300" />
                <div>
                  <span className="font-semibold text-amber-200">{app.title}</span>
                  <span className="ml-2 text-amber-200/80">{app.summary}</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => handleDecision(app.id, "reject")}
                  variant="outline"
                  className="border-rose-500/40 text-xs text-rose-300"
                >
                  <X className="mr-1 h-3.5 w-3.5" /> Reject
                </Button>
                <Button
                  size="sm"
                  onClick={() => handleDecision(app.id, "approve")}
                  className="bg-[#00FFA3] text-xs font-semibold text-[#090A0F]"
                >
                  <Check className="mr-1 h-3.5 w-3.5" /> Approve & Continue
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Live DAG Status Canvas */}
        <main className="flex-1 p-4 flex flex-col gap-4 overflow-hidden">
          {detail?.version?.definitionJson && (
            <div className="flex-1 min-h-0">
              <WorkflowCanvas
                graph={detail.version.definitionJson}
                selectedNodeId={selectedNodeId}
                onSelectNode={setSelectedNodeId}
                nodeStatuses={nodeStatusMap}
                readOnly
              />
            </div>
          )}

          {/* Linked MCP / Bridge Approvals if paused inside workflow */}
          {detail?.pendingToolApprovals && detail.pendingToolApprovals.length > 0 && (
            <div className="max-h-60 overflow-y-auto space-y-2">
              {detail.pendingToolApprovals.map((pa) => (
                <ToolApprovalCard
                  key={pa.id}
                  approvalId={pa.id}
                  toolCallId={pa.toolCallId}
                  toolName={pa.toolCall?.toolName || "mcp_tool"}
                  providerToolAlias={pa.toolCall?.providerToolAlias || "tool"}
                  connectionName={(pa.toolCall as any)?.connection?.name}
                  endpointUrl={(pa.toolCall as any)?.connection?.endpointUrl}
                  argumentsPreview={pa.toolCall?.argumentsPreview || {}}
                  status={pa.status}
                  expiresAt={pa.expiresAt}
                  onApprove={handleToolApprove}
                  onDeny={handleToolDeny}
                />
              ))}
            </div>
          )}

          {detail?.bridgeTasks && detail.bridgeTasks.length > 0 && (
            <div className="max-h-48 overflow-y-auto space-y-2">
              {detail.bridgeTasks.map((bt) => (
                <BridgeTaskCard
                  key={bt.id}
                  task={bt}
                  onApprove={(taskId) => handleBridgeDecision(taskId, "approve")}
                  onReject={(taskId, reason) => handleBridgeDecision(taskId, "reject", reason)}
                  onCancel={(taskId) => handleBridgeDecision(taskId, "cancel")}
                />
              ))}
            </div>
          )}
        </main>

        {/* Right Node Execution & Timeline Sidebar */}
        <aside className="w-96 shrink-0 overflow-y-auto border-l border-[#1E2536] bg-[#12151E] p-4 space-y-4 text-xs">
          {detail?.finalSummary && (
            <Card className="border-[#1E2536] bg-[#090A0F]">
              <CardContent className="p-3 space-y-1">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-[#00FFA3]">
                  Final Workflow Outcome
                </div>
                <p className="whitespace-pre-wrap text-xs text-[#D3DCEB]">{detail.finalSummary}</p>
              </CardContent>
            </Card>
          )}

          {selectedExec ? (
            <Card className="border-[#00F0FF]/40 bg-[#090A0F]">
              <CardContent className="p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-[#F0F4FC]">{selectedExec.title}</span>
                  <span className="font-mono text-[10px] text-[#00F0FF]">{selectedExec.status}</span>
                </div>
                <div className="text-[11px] text-[#8E9BB4]">
                  Node ID: {selectedExec.nodeId} · Attempts: {selectedExec.attemptCount} ·{" "}
                  {selectedExec.durationMs ?? 0}ms
                </div>
                {selectedExec.errorMessage && (
                  <div className="flex items-start gap-1.5 rounded border border-rose-500/40 bg-rose-500/10 p-2 text-rose-300">
                    <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{selectedExec.errorMessage}</span>
                  </div>
                )}
                {selectedExec.outputData && (
                  <div>
                    <div className="mb-1 text-[10px] uppercase text-[#8E9BB4]">Node Output</div>
                    <pre className="max-h-56 overflow-auto rounded bg-[#12151E] p-2 font-mono text-[10px] text-[#A3B1C6]">
                      {JSON.stringify(selectedExec.outputData, null, 2)}
                    </pre>
                  </div>
                )}
              </CardContent>
            </Card>
          ) : (
            <div className="rounded-lg border border-[#1E2536] bg-[#090A0F] p-3 text-[#8E9BB4]">
              Click any node on the execution canvas to inspect inputs, outputs, and duration.
            </div>
          )}

          <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[#8E9BB4]">
              Execution Steps
            </div>
            {(detail?.nodeExecutions || []).map((ne) => (
              <button
                key={ne.id}
                onClick={() => setSelectedNodeId(ne.nodeId)}
                className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition ${
                  selectedNodeId === ne.nodeId
                    ? "border-[#00F0FF]/50 bg-[#191E2B]"
                    : "border-[#1E2536] bg-[#090A0F]"
                }`}
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{ne.title}</div>
                  <div className="text-[10px] text-[#64748B]">{ne.nodeType}</div>
                </div>
                <span className="font-mono text-[10px] text-[#00F0FF]">{ne.status}</span>
              </button>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
