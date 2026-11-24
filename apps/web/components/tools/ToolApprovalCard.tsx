"use client";

import React, { useState, useEffect, useMemo } from "react";
import {
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Clock,
  Check,
  X,
  ChevronDown,
  ChevronUp,
  Terminal,
  Loader2,
  Copy,
  Eye,
  EyeOff,
  Globe,
  Server,
  AlertTriangle,
} from "lucide-react";
import { Button, cn } from "@messiah/ui";
import type { ToolApprovalStatus } from "@messiah/shared";

export interface ToolApprovalCardProps {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  providerToolAlias: string;
  connectionName?: string;
  endpointUrl?: string;
  aiProvider?: string;
  isReadOnly?: boolean;
  argumentsPreview: Record<string, unknown>;
  status: ToolApprovalStatus;
  expiresAt: string;
  onApprove: (approvalId: string) => Promise<void>;
  onDeny: (approvalId: string, reason?: string) => Promise<void>;
  disabled?: boolean;
}

export function ToolApprovalCard({
  approvalId,
  toolName,
  providerToolAlias,
  connectionName,
  endpointUrl,
  aiProvider = "AI Model Provider",
  isReadOnly = false,
  argumentsPreview,
  status,
  expiresAt,
  onApprove,
  onDeny,
  disabled = false,
}: ToolApprovalCardProps) {
  const [expanded, setExpanded] = useState(true);
  const [showDenyReason, setShowDenyReason] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState<"approve" | "deny" | null>(null);
  const [copied, setCopied] = useState(false);
  const [revealSensitive, setRevealSensitive] = useState(false);
  const [rawConfirmationChecked, setRawConfirmationChecked] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [alreadyDecidedNotice, setAlreadyDecidedNotice] = useState(false);

  // Expiration countdown
  const [timeLeftMs, setTimeLeftMs] = useState<number>(() => {
    return Math.max(0, new Date(expiresAt).getTime() - Date.now());
  });

  useEffect(() => {
    if (status !== "PENDING") return;

    const interval = setInterval(() => {
      const remaining = Math.max(0, new Date(expiresAt).getTime() - Date.now());
      setTimeLeftMs(remaining);
      if (remaining <= 0) {
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [expiresAt, status]);

  const isExpired = status === "EXPIRED" || (status === "PENDING" && timeLeftMs <= 0);

  const formatCountdown = (ms: number) => {
    const totalSecs = Math.floor(ms / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  // Detect sensitive keys matching passwords, tokens, API keys, credentials
  const hasSensitiveKeys = useMemo(() => {
    const SENSITIVE_KEY_PATTERN = /(password|secret|token|api_key|credential|private_key|auth|bearer)/i;
    function check(val: unknown): boolean {
      if (typeof val !== "object" || val === null) return false;
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        if (SENSITIVE_KEY_PATTERN.test(k)) return true;
        if (typeof v === "object" && v !== null && check(v)) return true;
      }
      return false;
    }
    return check(argumentsPreview);
  }, [argumentsPreview]);

  // Mask sensitive values unless unmasked by intentional user click
  const displayArguments = useMemo(() => {
    if (revealSensitive) return argumentsPreview;
    const SENSITIVE_KEY_PATTERN = /(password|secret|token|api_key|credential|private_key|auth|bearer)/i;

    function traverse(item: unknown): unknown {
      if (typeof item !== "object" || item === null) return item;
      if (Array.isArray(item)) return item.map(traverse);

      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
        if (SENSITIVE_KEY_PATTERN.test(k)) {
          result[k] = "•••••••••••• (sensitive argument masked)";
        } else if (typeof v === "object" && v !== null) {
          result[k] = traverse(v);
        } else {
          result[k] = v;
        }
      }
      return result;
    }

    return traverse(argumentsPreview) as Record<string, unknown>;
  }, [argumentsPreview, revealSensitive]);

  // Check if argument serialization is complex or has deeply nested properties
  const isComplexArguments = useMemo(() => {
    try {
      const json = JSON.stringify(argumentsPreview);
      return json.length > 2048;
    } catch {
      return true;
    }
  }, [argumentsPreview]);

  const handleCopyArgs = () => {
    navigator.clipboard.writeText(JSON.stringify(argumentsPreview, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleApprove = async () => {
    if (disabled || isSubmitting) return;
    setErrorMessage(null);
    setIsSubmitting("approve");
    try {
      await onApprove(approvalId);
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (msg.includes("already") || msg.includes("ALREADY_DECIDED")) {
        setAlreadyDecidedNotice(true);
      } else {
        setErrorMessage(msg);
      }
    } finally {
      setIsSubmitting(null);
    }
  };

  const handleDeny = async () => {
    if (disabled || isSubmitting) return;
    setErrorMessage(null);
    setIsSubmitting("deny");
    try {
      await onDeny(approvalId, rejectionReason.trim() || undefined);
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (msg.includes("already") || msg.includes("ALREADY_DECIDED")) {
        setAlreadyDecidedNotice(true);
      } else {
        setErrorMessage(msg);
      }
    } finally {
      setIsSubmitting(null);
    }
  };

  const canApprove = !isExpired && (!isComplexArguments || rawConfirmationChecked);

  return (
    <div
      className={cn(
        "rounded-xl border p-4 my-3 text-xs shadow-lg transition-all duration-200 max-w-2xl",
        status === "PENDING" && !isExpired
          ? "border-amber-500/40 bg-gradient-to-b from-[#1E170A] to-[#0E121B] shadow-amber-500/5"
          : status === "APPROVED"
          ? "border-emerald-500/30 bg-[#0A1612]"
          : status === "DENIED"
          ? "border-rose-500/30 bg-[#160D10]"
          : "border-[#1E2536] bg-[#0E121B]"
      )}
    >
      {/* Top Banner / Header */}
      <div className="flex items-center justify-between pb-3 border-b border-[#1E2536]/80">
        <div className="flex items-center gap-2">
          {status === "PENDING" && !isExpired ? (
            <div className="w-6 h-6 rounded-md bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400">
              <ShieldAlert className="w-3.5 h-3.5 animate-pulse" />
            </div>
          ) : status === "APPROVED" ? (
            <div className="w-6 h-6 rounded-md bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400">
              <ShieldCheck className="w-3.5 h-3.5" />
            </div>
          ) : status === "DENIED" ? (
            <div className="w-6 h-6 rounded-md bg-rose-500/20 border border-rose-500/40 flex items-center justify-center text-rose-400">
              <ShieldX className="w-3.5 h-3.5" />
            </div>
          ) : (
            <div className="w-6 h-6 rounded-md bg-slate-500/20 border border-slate-500/40 flex items-center justify-center text-slate-400">
              <Clock className="w-3.5 h-3.5" />
            </div>
          )}

          <div>
            <div className="font-semibold text-[#F0F4FC] flex items-center gap-2">
              <span>Tool Execution Approval</span>
              {status === "PENDING" && !isExpired ? (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/20 text-amber-300 border border-amber-500/30">
                  Required
                </span>
              ) : status === "APPROVED" ? (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  Approved
                </span>
              ) : status === "DENIED" ? (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-rose-500/20 text-rose-300 border border-rose-500/30">
                  Denied
                </span>
              ) : (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-500/20 text-slate-300 border border-slate-500/30">
                  Expired
                </span>
              )}
            </div>
            <p className="text-[11px] text-[#94A3B8]">
              Explicit authorization required before dispatching external tool call.
            </p>
          </div>
        </div>

        {/* Expiry countdown / status badge */}
        {status === "PENDING" && !isExpired && (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-300 font-mono text-[11px]">
            <Clock className="w-3 h-3" />
            <span>Expires in {formatCountdown(timeLeftMs)}</span>
          </div>
        )}
      </div>

      {/* Concurrent Session Notice */}
      {alreadyDecidedNotice && (
        <div className="mt-3 p-2.5 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-200 text-[11px] flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
          <span>
            This tool approval request has already been decided by another session or device.
          </span>
        </div>
      )}

      {/* Error Message Notice */}
      {errorMessage && (
        <div className="mt-3 p-2.5 rounded-lg bg-rose-500/15 border border-rose-500/30 text-rose-200 text-[11px] flex items-center gap-2">
          <ShieldX className="w-4 h-4 text-rose-400 flex-shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* External Data Disclosure Warning */}
      <div className="mt-3 p-2.5 rounded-lg bg-[#0F141F] border border-[#1E2536] text-[11px] space-y-1.5">
        <div className="flex items-center gap-1.5 font-medium text-amber-300/90">
          <Globe className="w-3.5 h-3.5 text-amber-400" />
          <span>External Data Disclosure Notice</span>
        </div>
        <p className="text-[#94A3B8] leading-relaxed">
          Executing this tool will transmit parameters outside Messiah to the remote MCP server at{" "}
          <span className="font-mono text-[#F0F4FC] font-semibold">{endpointUrl || "remote host"}</span>
          . Tool execution results will be disclosed to the active AI provider (
          <span className="text-[#00FFA3] font-medium">{aiProvider}</span>) to continue the conversation.
        </p>
      </div>

      {/* Tool Call & Server Details */}
      <div className="pt-3 space-y-2">
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div className="flex flex-col gap-0.5">
            <span className="text-[#64748B]">Target Tool:</span>
            <div className="flex items-center gap-1.5 font-mono text-[#00E5FF] bg-[#121722] px-2 py-1 rounded border border-[#1E2536]">
              <Terminal className="w-3 h-3 text-[#64748B]" />
              <span className="truncate">{providerToolAlias || toolName}</span>
            </div>
          </div>

          <div className="flex flex-col gap-0.5">
            <span className="text-[#64748B]">MCP Server / Host:</span>
            <div className="flex items-center gap-1.5 font-mono text-[#F0F4FC] bg-[#121722] px-2 py-1 rounded border border-[#1E2536]">
              <Server className="w-3 h-3 text-[#64748B]" />
              <span className="truncate">{connectionName || endpointUrl || "Remote MCP"}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between text-[11px] pt-1">
          <div className="flex items-center gap-2">
            <span className="text-[#64748B]">Operation Mode:</span>
            <span
              className={cn(
                "px-1.5 py-0.5 rounded text-[10px] font-medium border",
                isReadOnly
                  ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
                  : "bg-amber-500/10 text-amber-300 border-amber-500/30"
              )}
            >
              {isReadOnly ? "Read-Only (No side effects)" : "Mutating (Modifies external state)"}
            </span>
          </div>

          {hasSensitiveKeys && (
            <button
              type="button"
              onClick={() => setRevealSensitive(!revealSensitive)}
              className="text-[10px] text-amber-300 hover:text-amber-200 flex items-center gap-1 px-1.5 py-0.5 rounded border border-amber-500/30 bg-amber-500/10"
            >
              {revealSensitive ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
              <span>{revealSensitive ? "Mask Secrets" : "Reveal Secrets"}</span>
            </button>
          )}
        </div>

        {/* Arguments Accordion */}
        <div className="rounded-lg border border-[#1E2536] bg-[#0A0D14] overflow-hidden">
          <div
            onClick={() => setExpanded(!expanded)}
            className="flex items-center justify-between px-3 py-1.5 bg-[#121722] cursor-pointer hover:bg-[#161D2C] transition-colors select-none"
          >
            <span className="text-[11px] font-medium text-[#94A3B8]">
              Arguments ({Object.keys(argumentsPreview || {}).length} params)
              {hasSensitiveKeys && !revealSensitive && (
                <span className="ml-2 text-[10px] text-amber-400 font-normal">
                  [Sensitive fields masked]
                </span>
              )}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCopyArgs();
                }}
                className="text-[10px] text-[#64748B] hover:text-[#F0F4FC] flex items-center gap-1 px-1.5 py-0.5 rounded border border-transparent hover:border-[#1E2536]"
              >
                {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                <span>{copied ? "Copied" : "Copy"}</span>
              </button>
              {expanded ? (
                <ChevronUp className="w-3.5 h-3.5 text-[#64748B]" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5 text-[#64748B]" />
              )}
            </div>
          </div>

          {expanded && (
            <div className="p-3 text-[11px] font-mono text-[#D1D5DB] overflow-x-auto max-h-48 scrollbar-thin">
              <pre>{JSON.stringify(displayArguments, null, 2)}</pre>
            </div>
          )}
        </div>

        {/* Large / Complex payload raw confirmation */}
        {isComplexArguments && status === "PENDING" && !isExpired && (
          <label className="flex items-start gap-2 pt-1 text-[11px] text-[#94A3B8] cursor-pointer">
            <input
              type="checkbox"
              checked={rawConfirmationChecked}
              onChange={(e) => setRawConfirmationChecked(e.target.checked)}
              className="mt-0.5 rounded border-[#1E2536] bg-[#121722] text-emerald-500 focus:ring-0"
            />
            <span>
              I have reviewed this complex payload in raw JSON format and verify it is safe to execute.
            </span>
          </label>
        )}
      </div>

      {/* Action Controls for PENDING requests */}
      {status === "PENDING" && !isExpired && (
        <div className="pt-3 mt-3 border-t border-[#1E2536]/80 space-y-2">
          {showDenyReason && (
            <div className="space-y-1">
              <label className="text-[11px] text-[#94A3B8]">Rejection Reason (Optional):</label>
              <input
                type="text"
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                placeholder="e.g. Disallowed parameter or branch name"
                className="w-full h-7 px-2.5 rounded bg-[#121722] border border-[#1E2536] text-[11px] text-[#F0F4FC] placeholder-[#64748B] focus:outline-none focus:border-rose-500"
              />
            </div>
          )}

          <div className="flex items-center justify-between pt-1">
            <button
              type="button"
              onClick={() => setShowDenyReason(!showDenyReason)}
              className="text-[11px] text-[#64748B] hover:text-[#94A3B8] underline"
            >
              {showDenyReason ? "Hide reason field" : "Add rejection reason"}
            </button>

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                disabled={disabled || isSubmitting !== null}
                onClick={handleDeny}
                className="h-7 px-3 text-xs border-rose-500/40 text-rose-300 hover:bg-rose-500/10 hover:border-rose-500 flex items-center gap-1.5"
              >
                {isSubmitting === "deny" ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <X className="w-3 h-3" />
                )}
                <span>Deny</span>
              </Button>

              <Button
                disabled={disabled || isSubmitting !== null || !canApprove}
                onClick={handleApprove}
                className={cn(
                  "h-7 px-3 text-xs bg-emerald-500 text-black font-medium hover:bg-emerald-400 flex items-center gap-1.5 shadow-sm shadow-emerald-500/20",
                  !canApprove && "opacity-50 cursor-not-allowed"
                )}
              >
                {isSubmitting === "approve" ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Check className="w-3 h-3" />
                )}
                <span>Approve</span>
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Terminal State Notes */}
      {status === "APPROVED" && (
        <div className="pt-2 mt-2 border-t border-emerald-500/20 text-[11px] text-emerald-400/90 flex items-center gap-1.5">
          <Check className="w-3 h-3" />
          <span>Execution approved. The agent will continue with the output.</span>
        </div>
      )}

      {status === "DENIED" && (
        <div className="pt-2 mt-2 border-t border-rose-500/20 text-[11px] text-rose-400/90 flex items-center gap-1.5">
          <X className="w-3 h-3" />
          <span>Execution was denied by workspace member.</span>
        </div>
      )}

      {isExpired && (
        <div className="pt-2 mt-2 border-t border-slate-500/20 text-[11px] text-slate-400 flex items-center gap-1.5">
          <Clock className="w-3 h-3" />
          <span>Approval request timed out after 5 minutes and was cancelled.</span>
        </div>
      )}
    </div>
  );
}