"use client";

import React, { useState } from "react";
import {
  Terminal,
  Clock,
  CheckCircle2,
  AlertCircle,
  ShieldAlert,
  XCircle,
  RotateCw,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Badge, Button } from "@messiah/ui";
import type { BridgeTaskInfo, BridgeTaskApprovalInfo } from "@messiah/shared";

interface BridgeTaskLogEntry {
  id?: string;
  sequence: number;
  stream: "stdout" | "stderr" | "system";
  chunk: string;
  timestamp?: string;
}

interface BridgeTaskCardProps {
  task: BridgeTaskInfo & {
    device?: { id: string; displayName: string; platform: string };
    approval?: BridgeTaskApprovalInfo | null;
  };
  logs?: BridgeTaskLogEntry[];
  onApprove?: (taskId: string) => Promise<void>;
  onReject?: (taskId: string, reason?: string) => Promise<void>;
  onCancel?: (taskId: string) => Promise<void>;
  isApproving?: boolean;
}

export function BridgeTaskCard({
  task,
  logs = [],
  onApprove,
  onReject,
  onCancel,
  isApproving = false,
}: BridgeTaskCardProps) {
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [showRejectInput, setShowRejectInput] = useState(false);

  const getStatusBadge = () => {
    switch (task.status) {
      case "SUCCEEDED":
        return (
          <Badge variant="outline" className="border-emerald-500/30 bg-emerald-950/20 text-emerald-400 text-xs">
            <CheckCircle2 className="mr-1 h-3 w-3" />
            Succeeded
          </Badge>
        );
      case "RUNNING":
        return (
          <Badge variant="outline" className="border-indigo-500/30 bg-indigo-950/20 text-indigo-400 text-xs">
            <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-indigo-400 animate-pulse" />
            Running
          </Badge>
        );
      case "AWAITING_APPROVAL":
        return (
          <Badge variant="outline" className="border-amber-500/30 bg-amber-950/20 text-amber-400 text-xs">
            <ShieldAlert className="mr-1 h-3 w-3" />
            Approval Required
          </Badge>
        );
      case "FAILED":
        return (
          <Badge variant="outline" className="border-red-500/30 bg-red-950/20 text-red-400 text-xs">
            <XCircle className="mr-1 h-3 w-3" />
            Failed
          </Badge>
        );
      case "CANCELLED":
        return (
          <Badge variant="outline" className="border-zinc-500/30 bg-zinc-950/20 text-zinc-400 text-xs">
            Cancelled
          </Badge>
        );
      case "DISPATCHED":
      case "ACCEPTED":
        return (
          <Badge variant="outline" className="border-sky-500/30 bg-sky-950/20 text-sky-400 text-xs">
            <RotateCw className="mr-1 h-3 w-3 animate-spin" />
            Dispatched
          </Badge>
        );
      default:
        return (
          <Badge variant="outline" className="border-zinc-700 bg-zinc-900 text-zinc-400 text-xs">
            {task.status}
          </Badge>
        );
    }
  };

  return (
    <div className="rounded-xl border border-[#1E2536] bg-[#0E121B] p-4 text-white space-y-3">
      {/* Top Bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
            <Terminal className="h-4 w-4" />
          </div>
          <div>
            <div className="text-xs font-semibold text-white flex items-center gap-2">
              <span>{task.capability}</span>
              {task.device && (
                <span className="text-[11px] font-normal text-[#94A3B8]">
                  on {task.device.displayName}
                </span>
              )}
            </div>
            <div className="text-[10px] text-[#64748B] font-mono">
              Task #{task.id.slice(0, 8)}
            </div>
          </div>
        </div>
        <div>{getStatusBadge()}</div>
      </div>

      {/* Target Resource Scopes */}
      {task.resourceScopes && task.resourceScopes.length > 0 && (
        <div className="rounded-lg bg-[#07080B] p-2 text-xs border border-[#1E2536]/60">
          <div className="text-[10px] uppercase font-semibold text-[#64748B] mb-1">
            Target Resource Scope
          </div>
          <div className="space-y-0.5">
            {task.resourceScopes.map((scope, idx) => (
              <div key={idx} className="font-mono text-[11px] text-[#93C5FD] truncate">
                {scope}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Human Approval Required Warning & Decision Box */}
      {task.status === "AWAITING_APPROVAL" && task.approval && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-950/20 p-3 space-y-2">
          <div className="flex items-center gap-2 text-amber-400 text-xs font-medium">
            <ShieldAlert className="h-4 w-4" />
            <span>Sensitive Workstation Action Needs Approval</span>
          </div>
          <div className="text-xs text-amber-200/90 font-medium">
            {task.approval.summary}
          </div>
          {task.approval.details && Object.keys(task.approval.details).length > 0 && (
            <pre className="rounded bg-[#07080B]/80 p-2 text-[11px] font-mono text-amber-300 overflow-x-auto border border-amber-500/20">
              {JSON.stringify(task.approval.details, null, 2)}
            </pre>
          )}

          {/* Action Buttons */}
          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              onClick={() => onApprove?.(task.id)}
              disabled={isApproving}
              className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs h-7 px-3"
            >
              <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
              Approve Operation
            </Button>
            {!showRejectInput ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowRejectInput(true)}
                className="text-red-400 hover:text-red-300 hover:bg-red-950/20 text-xs h-7 px-3"
              >
                <XCircle className="mr-1.5 h-3.5 w-3.5" />
                Reject
              </Button>
            ) : (
              <div className="flex items-center gap-2 flex-1">
                <input
                  type="text"
                  placeholder="Reason for rejection (optional)"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  className="flex-1 rounded bg-[#07080B] border border-red-500/30 px-2 py-1 text-xs text-white outline-none"
                />
                <Button
                  size="sm"
                  onClick={() => onReject?.(task.id, rejectReason)}
                  className="bg-red-600 hover:bg-red-500 text-white text-xs h-7 px-2"
                >
                  Confirm Reject
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Error Message if Failed */}
      {task.errorMessage && (
        <div className="rounded-lg border border-red-500/30 bg-red-950/20 p-2 text-xs text-red-300">
          <div className="flex items-center gap-1.5 font-semibold mb-0.5">
            <AlertCircle className="h-3.5 w-3.5" />
            Execution Error:
          </div>
          <div className="font-mono text-[11px]">{task.errorMessage}</div>
        </div>
      )}

      {/* Execution Stream Logs Collapsible */}
      {logs.length > 0 && (
        <div className="rounded-lg border border-[#1E2536] bg-[#07080B] overflow-hidden">
          <button
            onClick={() => setLogsExpanded(!logsExpanded)}
            className="flex items-center justify-between w-full px-3 py-1.5 text-xs text-[#94A3B8] hover:bg-[#151822] transition-colors"
          >
            <div className="flex items-center gap-1.5">
              <Terminal className="h-3 w-3" />
              <span>Execution Logs ({logs.length} chunks)</span>
            </div>
            {logsExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
          {logsExpanded && (
            <div className="p-2 max-h-48 overflow-y-auto space-y-1 font-mono text-[11px]">
              {logs.map((log, idx) => (
                <div
                  key={idx}
                  className={
                    log.stream === "stderr"
                      ? "text-red-400"
                      : log.stream === "system"
                      ? "text-indigo-400"
                      : "text-[#E2E8F0]"
                  }
                >
                  <span className="text-[#64748B] mr-2">[{log.stream}]</span>
                  {log.chunk}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Footer / Meta */}
      <div className="flex items-center justify-between text-[11px] text-[#64748B] pt-1 border-t border-[#1E2536]/40">
        <div className="flex items-center gap-2">
          {task.durationMs !== undefined && task.durationMs !== null && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {task.durationMs}ms
            </span>
          )}
          {task.exitCode !== undefined && task.exitCode !== null && (
            <span>exit code: {task.exitCode}</span>
          )}
        </div>
        {(task.status === "RUNNING" || task.status === "DISPATCHED") && onCancel && (
          <button
            onClick={() => onCancel(task.id)}
            className="text-red-400 hover:text-red-300 text-xs"
          >
            Cancel Task
          </button>
        )}
      </div>
    </div>
  );
}
