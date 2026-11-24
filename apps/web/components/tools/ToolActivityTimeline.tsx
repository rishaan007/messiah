"use client";

import React, { useState } from "react";
import {
  Wrench,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  AlertCircle,
  Clock,
  Loader2,
  Copy,
  Check,
  Terminal,
  ShieldAlert,
} from "lucide-react";
import type { ToolCallInfo, ToolCallStatus } from "@messiah/shared";

export interface ToolActivityTimelineProps {
  toolCalls: ToolCallInfo[];
}

export function ToolActivityTimeline({ toolCalls }: ToolActivityTimelineProps) {
  const [expandedCallIds, setExpandedCallIds] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  if (!toolCalls || toolCalls.length === 0) {
    return null;
  }

  const toggleExpand = (id: string) => {
    setExpandedCallIds((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  const copyToClipboard = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const getStatusBadge = (status: ToolCallStatus, durationMs?: number | null) => {
    switch (status) {
      case "EXECUTING":
        return (
          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-cyan-500/10 text-cyan-400 border border-cyan-500/30">
            <Loader2 className="w-2.5 h-2.5 animate-spin" />
            <span>running</span>
          </span>
        );
      case "AWAITING_APPROVAL":
        return (
          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-amber-500/10 text-amber-400 border border-amber-500/30">
            <ShieldAlert className="w-2.5 h-2.5" />
            <span>approval required</span>
          </span>
        );
      case "SUCCEEDED":
        return (
          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
            <CheckCircle2 className="w-2.5 h-2.5" />
            <span>{durationMs !== undefined && durationMs !== null ? `${durationMs}ms` : "done"}</span>
          </span>
        );
      case "FAILED":
        return (
          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-rose-500/10 text-rose-400 border border-rose-500/30">
            <AlertCircle className="w-2.5 h-2.5" />
            <span>failed</span>
          </span>
        );
      case "DENIED":
        return (
          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-rose-500/10 text-rose-400 border border-rose-500/30">
            <AlertCircle className="w-2.5 h-2.5" />
            <span>denied</span>
          </span>
        );
      case "EXPIRED":
        return (
          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-slate-500/10 text-slate-400 border border-slate-500/30">
            <Clock className="w-2.5 h-2.5" />
            <span>expired</span>
          </span>
        );
      default:
        return (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-slate-500/10 text-slate-400 border border-slate-500/30">
            {status.toLowerCase()}
          </span>
        );
    }
  };

  return (
    <div className="my-2.5 rounded-lg border border-[#1E2536] bg-[#0A0D14] overflow-hidden text-xs max-w-2xl">
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#0E121B] border-b border-[#1E2536] text-[11px] text-[#94A3B8]">
        <div className="flex items-center gap-1.5 font-medium">
          <Wrench className="w-3.5 h-3.5 text-[#00E5FF]" />
          <span>MCP Tool Activity ({toolCalls.length})</span>
        </div>
        <span className="text-[10px] text-[#64748B]">Sanitized & Audited</span>
      </div>

      {/* Tool Call Items */}
      <div className="divide-y divide-[#1E2536]/60">
        {toolCalls.map((tc) => {
          const isExpanded = !!expandedCallIds[tc.id];
          const hasResult = tc.result !== undefined && tc.result !== null;
          const resultString =
            typeof tc.result === "string" ? tc.result : JSON.stringify(tc.result, null, 2);

          return (
            <div key={tc.id} className="transition-colors hover:bg-[#0E121B]/40">
              {/* Row header */}
              <div
                onClick={() => toggleExpand(tc.id)}
                className="flex items-center justify-between px-3 py-2 cursor-pointer select-none"
              >
                <div className="flex items-center gap-2 overflow-hidden mr-2">
                  <div className="text-[#64748B]">
                    {isExpanded ? (
                      <ChevronDown className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5" />
                    )}
                  </div>
                  <Terminal className="w-3.5 h-3.5 text-[#64748B] flex-shrink-0" />
                  <span className="font-mono text-[11px] text-[#F0F4FC] truncate">
                    {tc.providerToolAlias || tc.toolName}
                  </span>
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                  {getStatusBadge(tc.status, tc.durationMs)}
                </div>
              </div>

              {/* Collapsible Details */}
              {isExpanded && (
                <div className="px-3 pb-3 pt-1 space-y-2 border-t border-[#1E2536]/40 bg-[#07090F]">
                  {/* Arguments */}
                  <div>
                    <div className="flex items-center justify-between text-[10px] font-semibold text-[#64748B] uppercase tracking-wider mb-1">
                      <span>Arguments</span>
                      <button
                        type="button"
                        onClick={() =>
                          copyToClipboard(
                            `args-${tc.id}`,
                            JSON.stringify(tc.argumentsPreview || {}, null, 2)
                          )
                        }
                        className="hover:text-[#F0F4FC] flex items-center gap-1"
                      >
                        {copiedId === `args-${tc.id}` ? (
                          <Check className="w-2.5 h-2.5 text-emerald-400" />
                        ) : (
                          <Copy className="w-2.5 h-2.5" />
                        )}
                        <span>{copiedId === `args-${tc.id}` ? "Copied" : "Copy"}</span>
                      </button>
                    </div>
                    <pre className="p-2 rounded bg-[#0E121B] border border-[#1E2536] text-[11px] font-mono text-[#94A3B8] overflow-x-auto max-h-36 scrollbar-thin">
                      {JSON.stringify(tc.argumentsPreview || {}, null, 2)}
                    </pre>
                  </div>

                  {/* Output or Error */}
                  {tc.isError && (
                    <div>
                      <div className="text-[10px] font-semibold text-rose-400 uppercase tracking-wider mb-1">
                        Execution Error
                      </div>
                      <div className="p-2 rounded bg-rose-950/30 border border-rose-500/30 text-[11px] font-mono text-rose-300">
                        {tc.errorMessage || "Unknown tool execution failure"}
                      </div>
                    </div>
                  )}

                  {hasResult && !tc.isError && (
                    <div>
                      <div className="flex items-center justify-between text-[10px] font-semibold text-[#64748B] uppercase tracking-wider mb-1">
                        <span>Sanitized Result Output</span>
                        <button
                          type="button"
                          onClick={() => copyToClipboard(`result-${tc.id}`, resultString)}
                          className="hover:text-[#F0F4FC] flex items-center gap-1"
                        >
                          {copiedId === `result-${tc.id}` ? (
                            <Check className="w-2.5 h-2.5 text-emerald-400" />
                          ) : (
                            <Copy className="w-2.5 h-2.5" />
                          )}
                          <span>{copiedId === `result-${tc.id}` ? "Copied" : "Copy"}</span>
                        </button>
                      </div>
                      <pre className="p-2 rounded bg-[#0E121B] border border-[#1E2536] text-[11px] font-mono text-emerald-300/90 overflow-x-auto max-h-48 scrollbar-thin">
                        {resultString}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
