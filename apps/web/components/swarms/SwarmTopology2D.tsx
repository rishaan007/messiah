"use client";

import React from "react";
import { Bot, ShieldAlert, CheckCircle2, XCircle, Clock, Loader2 } from "lucide-react";
import { cn, Badge } from "@messiah/ui";
import {
  buildConstellationGraph,
  getStatusColorHex,
  type ConstellationNode,
} from "./swarmTopologyModel";
import type { SwarmRunDetail } from "@messiah/shared";

interface SwarmTopology2DProps {
  run: SwarmRunDetail;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  fallbackReason?: string | null;
}

export function SwarmTopology2D({
  run,
  selectedNodeId,
  onSelectNode,
  fallbackReason,
}: SwarmTopology2DProps) {
  const graph = React.useMemo(() => buildConstellationGraph(run), [run]);
  const nodeMap = React.useMemo(
    () => new Map<string, ConstellationNode>(graph.nodes.map((n) => [n.id, n])),
    [graph.nodes]
  );

  const renderStatusIcon = (status: string) => {
    switch (status) {
      case "RUNNING":
      case "PLANNING":
      case "SYNTHESIZING":
        return <Loader2 className="w-3.5 h-3.5 animate-spin text-[#00FFA3]" />;
      case "AWAITING_APPROVAL":
      case "AWAITING_PLAN_APPROVAL":
        return <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />;
      case "COMPLETED":
        return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />;
      case "FAILED":
      case "UNKNOWN_OUTCOME":
        return <XCircle className="w-3.5 h-3.5 text-red-400" />;
      default:
        return <Clock className="w-3.5 h-3.5 text-slate-400" />;
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#090A0F] rounded-xl border border-[#1E2536] overflow-hidden">
      {/* Top 2D Topology Banner */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#1E2536] bg-[#0E121B]">
        <div className="flex items-center gap-2 text-xs text-[#94A3B8]">
          <span className="inline-block w-2 h-2 rounded-full bg-[#00FFA3]" />
          <span className="font-medium text-[#F0F4FC]">2D Accessible Topology View</span>
          {fallbackReason && (
            <span className="text-[11px] text-amber-300/90 border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 rounded">
              {fallbackReason}
            </span>
          )}
        </div>
        <span className="font-mono text-[11px] text-[#64748B]">
          {graph.nodes.length} nodes • {graph.edges.length} links
        </span>
      </div>

      {/* Interactive SVG DAG Canvas */}
      <div className="relative flex-1 min-h-[280px] p-4 bg-[#090A0F]">
        <svg
          className="w-full h-full min-h-[260px]"
          viewBox="0 0 100 100"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="Multi-agent swarm execution DAG graph"
        >
          <defs>
            <marker
              id="arrow-active"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="4"
              markerHeight="4"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 10 5 L 0 9 z" fill="#00FFA3" />
            </marker>
            <marker
              id="arrow-muted"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="4"
              markerHeight="4"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 10 5 L 0 9 z" fill="#334155" />
            </marker>
          </defs>

          {graph.edges.map((edge) => {
            const src = nodeMap.get(edge.sourceId);
            const tgt = nodeMap.get(edge.targetId);
            if (!src || !tgt) return null;

            const stroke = edge.attention
              ? "#FBBF24"
              : edge.active
              ? "#00FFA3"
              : edge.kind === "synthesis"
              ? "#38BDF8"
              : "#2A344D";

            const midY = (src.y2d + tgt.y2d) / 2;
            const d = `M ${src.x2d} ${src.y2d} C ${src.x2d} ${midY}, ${tgt.x2d} ${midY}, ${tgt.x2d} ${tgt.y2d}`;

            return (
              <path
                key={edge.id}
                d={d}
                fill="none"
                stroke={stroke}
                strokeWidth={edge.active || edge.attention ? 0.65 : 0.4}
                strokeDasharray={edge.kind === "synthesis" ? "1.5 1" : edge.active ? "2 1" : undefined}
                markerEnd={edge.active ? "url(#arrow-active)" : "url(#arrow-muted)"}
                opacity={edge.active || edge.attention ? 0.95 : 0.6}
              />
            );
          })}
        </svg>

        {/* Accessible HTML Node Overlay Buttons matching SVG percentage coords */}
        <div className="absolute inset-4 pointer-events-none">
          {graph.nodes.map((node) => {
            const isSelected = selectedNodeId === node.id;
            const ringHex = getStatusColorHex(node.status);
            return (
              <button
                key={node.id}
                type="button"
                onClick={() => onSelectNode(node.id)}
                style={{
                  left: `${node.x2d}%`,
                  top: `${node.y2d}%`,
                  borderColor: isSelected ? "#00FFA3" : `${ringHex}80`,
                }}
                aria-label={`${node.title} (${node.agentName}) — Status ${node.status}`}
                className={cn(
                  "pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 rounded-lg border px-2.5 py-1.5 text-left transition-colors bg-[#12151E]/95 hover:bg-[#171C28] focus:outline-none focus:ring-2 focus:ring-[#00FFA3] min-w-[132px] max-w-[190px] shadow-lg",
                  isSelected && "ring-2 ring-[#00FFA3]/50"
                )}
              >
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center gap-1.5 truncate">
                    <Bot className="w-3.5 h-3.5 shrink-0" style={{ color: node.accentColor }} />
                    <span className="text-[11px] font-medium text-[#F0F4FC] truncate">
                      {node.title}
                    </span>
                  </div>
                  {renderStatusIcon(node.status)}
                </div>
                <div className="mt-0.5 flex items-center justify-between text-[10px] text-[#8B949E] font-mono">
                  <span className="truncate max-w-[90px]">{node.agentName}</span>
                  <span>{node.inputTokens + node.outputTokens}t</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Screen-reader & Keyboard Accessible Task List Strip */}
      <div className="border-t border-[#1E2536] bg-[#0E121B] px-4 py-2.5 max-h-40 overflow-y-auto">
        <p className="text-[11px] uppercase tracking-wider text-[#64748B] font-mono mb-2">
          Execution Nodes ({graph.nodes.length})
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {graph.nodes.map((node) => (
            <button
              key={node.id}
              type="button"
              onClick={() => onSelectNode(node.id)}
              className={cn(
                "flex items-center justify-between rounded-lg border px-2.5 py-1.5 text-xs text-left transition-colors",
                selectedNodeId === node.id
                  ? "border-[#00FFA3] bg-[#00FFA3]/10 text-[#F0F4FC]"
                  : "border-[#1E2536] bg-[#090A0F] text-[#94A3B8] hover:border-[#2A344D]"
              )}
            >
              <div className="truncate pr-2">
                <div className="font-medium text-[#F0F4FC] truncate">{node.title}</div>
                <div className="text-[10px] font-mono text-[#64748B]">
                  {node.kind === "supervisor" ? "SUPERVISOR" : `Wave ${node.waveIndex}`} • {node.agentName}
                </div>
              </div>
              <Badge
                variant="outline"
                className="text-[10px] font-mono shrink-0 border-[#1E2536]"
                style={{ color: getStatusColorHex(node.status) }}
              >
                {node.status}
              </Badge>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
