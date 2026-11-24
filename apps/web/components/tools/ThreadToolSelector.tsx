"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import {
  Wrench,
  ChevronDown,
  ChevronUp,
  Server,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import { cn } from "@messiah/ui";
import type {
  McpServerConnectionInfo,
  McpToolDefinitionInfo,
  McpPermissionMode,
} from "@messiah/shared";

export interface ThreadToolSelectorProps {
  workspaceId: string;
  authToken: string;
  apiUrl: string;
}

export function ThreadToolSelector({
  workspaceId,
  authToken,
  apiUrl,
}: ThreadToolSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [connections, setConnections] = useState<McpServerConnectionInfo[]>([]);
  const [tools, setTools] = useState<McpToolDefinitionInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetchConnectionsAndTools = async () => {
    if (!workspaceId || !authToken) return;
    setIsLoading(true);
    try {
      const [connRes, toolRes] = await Promise.all([
        fetch(`${apiUrl}/api/v1/mcp/connections?workspaceId=${workspaceId}`, {
          headers: { Authorization: `Bearer ${authToken}` },
        }),
        fetch(`${apiUrl}/api/v1/mcp/tools?workspaceId=${workspaceId}`, {
          headers: { Authorization: `Bearer ${authToken}` },
        }),
      ]);

      if (connRes.ok) {
        const body = await connRes.json();
        setConnections(body.data || []);
      }
      if (toolRes.ok) {
        const body = await toolRes.json();
        setTools(body.data || []);
      }
    } catch (err) {
      console.error("Failed to load MCP tools:", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchConnectionsAndTools();
  }, [workspaceId, authToken]);

  const activeConnections = connections.filter((c) => c.status === "CONNECTED");

  const getPermissionBadge = (mode?: McpPermissionMode, requiresApproval?: boolean) => {
    if (mode === "DISABLED") {
      return (
        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-rose-500/10 text-rose-400 border border-rose-500/30">
          Disabled
        </span>
      );
    }
    if (mode === "REQUIRE_APPROVAL" || requiresApproval) {
      return (
        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-amber-500/10 text-amber-400 border border-amber-500/30 flex items-center gap-1">
          <ShieldAlert className="w-2.5 h-2.5" />
          <span>Approval</span>
        </span>
      );
    }
    if (mode === "READ_ONLY") {
      return (
        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-blue-500/10 text-blue-400 border border-blue-500/30 flex items-center gap-1">
          <Shield className="w-2.5 h-2.5" />
          <span>Read-Only</span>
        </span>
      );
    }
    return (
      <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
        <ShieldCheck className="w-2.5 h-2.5" />
        <span>Authorized</span>
      </span>
    );
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "h-7 px-2.5 rounded-lg border text-xs flex items-center gap-1.5 transition-colors",
          isOpen
            ? "border-[#00FFA3]/50 bg-[#121722] text-[#00FFA3]"
            : "border-[#1E2536] bg-[#0E121B] text-[#94A3B8] hover:text-[#F0F4FC] hover:border-[#334155]"
        )}
      >
        <Wrench className="w-3.5 h-3.5 text-[#00E5FF]" />
        <span>MCP Tools</span>
        <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-[#1E2536] text-[#00FFA3]">
          {tools.length}
        </span>
        {isOpen ? (
          <ChevronUp className="w-3 h-3 text-[#64748B]" />
        ) : (
          <ChevronDown className="w-3 h-3 text-[#64748B]" />
        )}
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-2 w-80 md:w-96 rounded-xl border border-[#1E2536] bg-[#0A0D14] p-3 shadow-2xl z-50 text-xs space-y-3">
          {/* Header */}
          <div className="flex items-center justify-between pb-2 border-b border-[#1E2536]">
            <div>
              <div className="font-semibold text-[#F0F4FC] flex items-center gap-1.5">
                <span>Available MCP Tools</span>
                <span className="text-[10px] text-[#64748B] font-mono">({tools.length})</span>
              </div>
              <p className="text-[11px] text-[#64748B]">
                Discovered tools available to AI models in this workspace.
              </p>
            </div>
            <button
              onClick={fetchConnectionsAndTools}
              disabled={isLoading}
              className="p-1 rounded text-[#64748B] hover:text-[#F0F4FC] hover:bg-[#1E2536]"
              title="Refresh tools"
            >
              <RefreshCw className={cn("w-3.5 h-3.5", isLoading && "animate-spin")} />
            </button>
          </div>

          {/* Connections & Tools List */}
          <div className="max-h-72 overflow-y-auto space-y-2.5 scrollbar-thin">
            {connections.length === 0 ? (
              <div className="p-4 text-center text-[#64748B] space-y-2">
                <p>No MCP servers connected to this workspace.</p>
                <Link
                  href="/settings/mcp"
                  className="inline-flex items-center gap-1 text-[#00FFA3] hover:underline text-[11px]"
                >
                  <span>Connect an MCP Server</span>
                  <ExternalLink className="w-3 h-3" />
                </Link>
              </div>
            ) : (
              connections.map((conn) => {
                const connTools = tools.filter((t) => t.connectionId === conn.id);
                return (
                  <div
                    key={conn.id}
                    className="rounded-lg border border-[#1E2536] bg-[#0E121B] p-2.5 space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 font-medium text-[#F0F4FC]">
                        <Server className="w-3.5 h-3.5 text-[#00E5FF]" />
                        <span>{conn.name}</span>
                      </div>
                      <span
                        className={cn(
                          "px-1.5 py-0.2 rounded text-[10px] font-mono",
                          conn.status === "CONNECTED"
                            ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                            : "bg-slate-500/10 text-slate-400 border border-slate-500/30"
                        )}
                      >
                        {conn.status.toLowerCase()}
                      </span>
                    </div>

                    {connTools.length === 0 ? (
                      <p className="text-[11px] text-[#64748B] italic pl-5">
                        No tools discovered on this server.
                      </p>
                    ) : (
                      <div className="divide-y divide-[#1E2536]/40 pl-2">
                        {connTools.map((t: McpToolDefinitionInfo) => (
                          <div
                            key={t.id}
                            className="py-1.5 flex items-start justify-between gap-2"
                          >
                            <div className="min-w-0">
                              <div className="font-mono text-[11px] text-[#00FFA3] truncate">
                                {t.toolName}
                              </div>
                              {t.description && (
                                <p className="text-[10px] text-[#64748B] line-clamp-1">
                                  {t.description}
                                </p>
                              )}
                            </div>
                            <div className="flex-shrink-0">
                              {getPermissionBadge(
                                t.permission?.permissionMode,
                                t.permission?.requiresApproval
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Footer with link to settings */}
          <div className="pt-2 border-t border-[#1E2536] flex items-center justify-between text-[11px]">
            <span className="text-[#64748B]">
              {activeConnections.length} connected server{activeConnections.length !== 1 ? "s" : ""}
            </span>
            <Link
              href="/settings/mcp"
              className="flex items-center gap-1 text-[#00E5FF] hover:underline"
            >
              <span>Manage MCP Servers</span>
              <ExternalLink className="w-3 h-3" />
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
