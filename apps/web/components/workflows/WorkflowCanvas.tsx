"use client";

import React, { useState, useRef, useCallback } from "react";
import {
  Play,
  Clock,
  Zap,
  Bot,
  GitFork,
  Cpu,
  Laptop2,
  GitBranch,
  ShieldCheck,
  Wand2,
  GitMerge,
  Database,
  Flag,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Trash2,
} from "lucide-react";
import type {
  WorkflowEdgeSpec,
  WorkflowGraphDefinition,
  WorkflowNodeSpec,
  WorkflowNodeStatus,
  WorkflowNodeType,
} from "@messiah/shared";

interface WorkflowCanvasProps {
  graph: WorkflowGraphDefinition;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
  onChangeGraph?: (next: WorkflowGraphDefinition) => void;
  nodeStatuses?: Record<string, WorkflowNodeStatus>;
  readOnly?: boolean;
}

const NODE_WIDTH = 224;
const NODE_HEIGHT = 82;

export function getNodeVisualMeta(type: WorkflowNodeType) {
  switch (type) {
    case "manual_trigger":
      return { icon: Play, accent: "#00F0FF", category: "Trigger", badge: "Manual" };
    case "schedule_trigger":
      return { icon: Clock, accent: "#00F0FF", category: "Trigger", badge: "Cron" };
    case "event_trigger":
      return { icon: Zap, accent: "#00F0FF", category: "Trigger", badge: "Event" };
    case "run_agent":
      return { icon: Bot, accent: "#818CF8", category: "AI Agent", badge: "Agent" };
    case "run_swarm":
      return { icon: GitFork, accent: "#A78BFA", category: "Swarm", badge: "Swarm" };
    case "mcp_tool":
      return { icon: Cpu, accent: "#38BDF8", category: "MCP", badge: "Tool" };
    case "bridge_capability":
      return { icon: Laptop2, accent: "#38BDF8", category: "Bridge", badge: "Device" };
    case "condition":
      return { icon: GitBranch, accent: "#FBBF24", category: "Control", badge: "Branch" };
    case "approval_gate":
      return { icon: ShieldCheck, accent: "#F59E0B", category: "Safety", badge: "Approval" };
    case "transform":
      return { icon: Wand2, accent: "#FBBF24", category: "Transform", badge: "Map" };
    case "merge":
      return { icon: GitMerge, accent: "#FBBF24", category: "Control", badge: "Join" };
    case "store_result":
      return { icon: Database, accent: "#00FFA3", category: "Memory", badge: "Store" };
    case "completion":
    default:
      return { icon: Flag, accent: "#00FFA3", category: "Output", badge: "End" };
  }
}

function statusClasses(status?: WorkflowNodeStatus): string {
  switch (status) {
    case "RUNNING":
      return "border-[#00F0FF] shadow-[0_0_20px_rgba(0,240,255,0.22)]";
    case "AWAITING_APPROVAL":
      return "border-amber-400 shadow-[0_0_20px_rgba(251,191,36,0.22)]";
    case "COMPLETED":
      return "border-[#00FFA3]/70 shadow-[0_0_16px_rgba(0,255,163,0.16)]";
    case "FAILED":
    case "UNKNOWN_OUTCOME":
      return "border-rose-500/80 shadow-[0_0_16px_rgba(244,63,94,0.2)]";
    case "SKIPPED":
      return "border-[#1E2536] border-dashed opacity-50";
    default:
      return "border-[#1E2536]";
  }
}

export function WorkflowCanvas({
  graph,
  selectedNodeId,
  onSelectNode,
  onChangeGraph,
  nodeStatuses,
  readOnly = false,
}: WorkflowCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(0.95);
  const [pan, setPan] = useState({ x: 32, y: 32 });

  const [draggingNode, setDraggingNode] = useState<{
    id: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);
  const [panning, setPanning] = useState<{
    startX: number;
    startY: number;
    origPanX: number;
    origPanY: number;
  } | null>(null);
  const [connectingFrom, setConnectingFrom] = useState<{
    sourceId: string;
    sourceHandle?: string;
    cursorX: number;
    cursorY: number;
  } | null>(null);

  const screenToCanvas = useCallback(
    (clientX: number, clientY: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return {
        x: (clientX - rect.left - pan.x) / zoom,
        y: (clientY - rect.top - pan.y) / zoom,
      };
    },
    [pan, zoom]
  );

  const handleMouseMove = (e: React.MouseEvent) => {
    if (draggingNode && !readOnly && onChangeGraph) {
      const dx = (e.clientX - draggingNode.startX) / zoom;
      const dy = (e.clientY - draggingNode.startY) / zoom;
      const nextNodes = graph.nodes.map((n) =>
        n.id === draggingNode.id
          ? {
              ...n,
              position: {
                x: Math.round((draggingNode.origX + dx) / 10) * 10,
                y: Math.round((draggingNode.origY + dy) / 10) * 10,
              },
            }
          : n
      );
      onChangeGraph({ ...graph, nodes: nextNodes });
      return;
    }

    if (panning) {
      setPan({
        x: panning.origPanX + (e.clientX - panning.startX),
        y: panning.origPanY + (e.clientY - panning.startY),
      });
      return;
    }

    if (connectingFrom) {
      const pos = screenToCanvas(e.clientX, e.clientY);
      setConnectingFrom((prev) =>
        prev ? { ...prev, cursorX: pos.x, cursorY: pos.y } : null
      );
    }
  };

  const handleMouseUp = () => {
    setDraggingNode(null);
    setPanning(null);
    setConnectingFrom(null);
  };

  const completeConnection = (targetId: string) => {
    if (readOnly || !onChangeGraph || !connectingFrom) return;
    if (connectingFrom.sourceId === targetId) {
      setConnectingFrom(null);
      return;
    }

    const exists = graph.edges.some(
      (e) =>
        e.source === connectingFrom.sourceId &&
        e.target === targetId &&
        (e.sourceHandle || "") === (connectingFrom.sourceHandle || "")
    );
    if (!exists) {
      const newEdge: WorkflowEdgeSpec = {
        id: `e_${connectingFrom.sourceId}_${targetId}_${Date.now().toString(36)}`,
        source: connectingFrom.sourceId,
        target: targetId,
        ...(connectingFrom.sourceHandle ? { sourceHandle: connectingFrom.sourceHandle } : {}),
        ...(connectingFrom.sourceHandle === "true"
          ? { label: "True" }
          : connectingFrom.sourceHandle === "false"
          ? { label: "False" }
          : {}),
      };
      onChangeGraph({
        ...graph,
        edges: [...graph.edges, newEdge],
      });
    }
    setConnectingFrom(null);
  };

  const removeEdge = (edgeId: string) => {
    if (readOnly || !onChangeGraph) return;
    onChangeGraph({
      ...graph,
      edges: graph.edges.filter((e) => e.id !== edgeId),
    });
  };

  const nodeMap = new Map<string, WorkflowNodeSpec>();
  for (const n of graph.nodes) nodeMap.set(n.id, n);

  const getPortOut = (node: WorkflowNodeSpec, handle?: string) => {
    const x = node.position.x + NODE_WIDTH;
    if (node.type === "condition") {
      return {
        x,
        y: node.position.y + (handle === "false" ? NODE_HEIGHT * 0.72 : NODE_HEIGHT * 0.28),
      };
    }
    return { x, y: node.position.y + NODE_HEIGHT / 2 };
  };

  const getPortIn = (node: WorkflowNodeSpec) => ({
    x: node.position.x,
    y: node.position.y + NODE_HEIGHT / 2,
  });

  const makeBezier = (x1: number, y1: number, x2: number, y2: number) => {
    const ctrl = Math.max(50, Math.abs(x2 - x1) * 0.48);
    return `M ${x1} ${y1} C ${x1 + ctrl} ${y1}, ${x2 - ctrl} ${y2}, ${x2} ${y2}`;
  };

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseDown={(e) => {
        if (e.target === containerRef.current || (e.target as HTMLElement).dataset.canvasBg === "true") {
          onSelectNode(null);
          setPanning({
            startX: e.clientX,
            startY: e.clientY,
            origPanX: pan.x,
            origPanY: pan.y,
          });
        }
      }}
      className="relative h-full w-full select-none overflow-hidden rounded-xl border border-[#1E2536] bg-[#090A0F]"
      style={{
        backgroundImage:
          "radial-gradient(circle at 1px 1px, rgba(142,155,180,0.16) 1px, transparent 0)",
        backgroundSize: `${24 * zoom}px ${24 * zoom}px`,
        backgroundPosition: `${pan.x}px ${pan.y}px`,
      }}
    >
      {/* Zoom & View Toolbar */}
      <div className="absolute bottom-3 right-3 z-20 flex items-center gap-1 rounded-lg border border-[#1E2536] bg-[#12151E]/95 p-1 backdrop-blur">
        <button
          type="button"
          onClick={() => setZoom((z) => Math.max(0.45, Number((z - 0.1).toFixed(2))))}
          className="rounded p-1.5 text-[#8E9BB4] hover:bg-[#1E2536] hover:text-[#F0F4FC]"
          title="Zoom out"
        >
          <ZoomOut className="h-3.5 w-3.5" />
        </button>
        <span className="min-w-[42px] text-center font-mono text-[11px] text-[#8E9BB4]">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.min(1.6, Number((z + 0.1).toFixed(2))))}
          className="rounded p-1.5 text-[#8E9BB4] hover:bg-[#1E2536] hover:text-[#F0F4FC]"
          title="Zoom in"
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => {
            setZoom(0.95);
            setPan({ x: 32, y: 32 });
          }}
          className="rounded p-1.5 text-[#8E9BB4] hover:bg-[#1E2536] hover:text-[#F0F4FC]"
          title="Reset viewport"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Transformed Canvas Layer */}
      <div
        data-canvas-bg="true"
        className="absolute inset-0 origin-top-left"
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        }}
      >
        {/* SVG Edges Layer */}
        <svg className="pointer-events-none h-[3000px] w-[4000px] overflow-visible">
          {graph.edges.map((edge) => {
            const src = nodeMap.get(edge.source);
            const dst = nodeMap.get(edge.target);
            if (!src || !dst) return null;
            const p1 = getPortOut(src, edge.sourceHandle);
            const p2 = getPortIn(dst);
            const path = makeBezier(p1.x, p1.y, p2.x, p2.y);
            const srcStatus = nodeStatuses?.[src.id];
            const isHighlighted = selectedNodeId === edge.source || selectedNodeId === edge.target;
            const strokeColor =
              srcStatus === "COMPLETED"
                ? "#00FFA3"
                : isHighlighted
                ? "#00F0FF"
                : edge.sourceHandle === "false"
                ? "#F59E0B"
                : "#475569";

            const midX = (p1.x + p2.x) / 2;
            const midY = (p1.y + p2.y) / 2;

            return (
              <g key={edge.id} className="pointer-events-auto group">
                <path
                  d={path}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={14}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    if (!readOnly) removeEdge(edge.id);
                  }}
                  className={readOnly ? "" : "cursor-pointer"}
                />
                <path
                  d={path}
                  fill="none"
                  stroke={strokeColor}
                  strokeWidth={isHighlighted ? 2.5 : 2}
                  strokeDasharray={srcStatus === "RUNNING" ? "6 4" : undefined}
                />
                {(edge.label || !readOnly) && (
                  <g
                    transform={`translate(${midX}, ${midY})`}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      if (!readOnly) removeEdge(edge.id);
                    }}
                    className={readOnly ? "" : "cursor-pointer"}
                  >
                    {edge.label && (
                      <>
                        <rect
                          x={-28}
                          y={-10}
                          width={56}
                          height={20}
                          rx={5}
                          fill="#12151E"
                          stroke="#1E2536"
                        />
                        <text
                          textAnchor="middle"
                          dominantBaseline="central"
                          fill="#94A3B8"
                          fontSize={10}
                        >
                          {edge.label}
                        </text>
                      </>
                    )}
                    {!readOnly && (
                      <circle
                        cx={edge.label ? 34 : 0}
                        cy={0}
                        r={7}
                        fill="#1E2536"
                        className="opacity-0 transition group-hover:opacity-100"
                      />
                    )}
                  </g>
                )}
              </g>
            );
          })}

          {connectingFrom &&
            (() => {
              const src = nodeMap.get(connectingFrom.sourceId);
              if (!src) return null;
              const p1 = getPortOut(src, connectingFrom.sourceHandle);
              return (
                <path
                  d={makeBezier(p1.x, p1.y, connectingFrom.cursorX, connectingFrom.cursorY)}
                  fill="none"
                  stroke="#00F0FF"
                  strokeWidth={2}
                  strokeDasharray="5 4"
                />
              );
            })()}
        </svg>

        {/* Nodes Layer */}
        {graph.nodes.map((node) => {
          const meta = getNodeVisualMeta(node.type);
          const Icon = meta.icon;
          const isSelected = selectedNodeId === node.id;
          const liveStatus = nodeStatuses?.[node.id];
          const isTrigger = node.type.endsWith("_trigger");

          return (
            <div
              key={node.id}
              data-testid={`workflow-node-${node.id}`}
              onClick={(e) => {
                e.stopPropagation();
                onSelectNode(node.id);
              }}
              onMouseDown={(e) => {
                e.stopPropagation();
                onSelectNode(node.id);
                if (!readOnly) {
                  setDraggingNode({
                    id: node.id,
                    startX: e.clientX,
                    startY: e.clientY,
                    origX: node.position.x,
                    origY: node.position.y,
                  });
                }
              }}
              style={{
                left: node.position.x,
                top: node.position.y,
                width: NODE_WIDTH,
                height: NODE_HEIGHT,
              }}
              className={`group absolute rounded-xl border bg-[#12151E] px-3.5 py-2.5 transition-shadow ${
                liveStatus
                  ? statusClasses(liveStatus)
                  : isSelected
                  ? "border-[#00F0FF] shadow-[0_0_24px_rgba(0,240,255,0.22)]"
                  : "border-[#1E2536] hover:border-[#33415C]"
              }`}
            >
              {/* Input Port */}
              {!isTrigger && (
                <button
                  type="button"
                  title="Connect edge here"
                  onMouseUp={(e) => {
                    e.stopPropagation();
                    completeConnection(node.id);
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    completeConnection(node.id);
                  }}
                  className="absolute -left-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-2 border-[#00F0FF]/60 bg-[#090A0F] transition hover:scale-125 hover:bg-[#00F0FF]"
                />
              )}

              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <div
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border"
                    style={{
                      borderColor: `${meta.accent}44`,
                      backgroundColor: `${meta.accent}15`,
                      color: meta.accent,
                    }}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-xs font-semibold text-[#F0F4FC]">{node.title}</div>
                    <div className="flex items-center gap-1.5 text-[10px] text-[#8E9BB4]">
                      <span>{meta.badge}</span>
                      {liveStatus && (
                        <span className="rounded bg-[#090A0F] px-1 text-[9px] font-mono text-[#00F0FF]">
                          {liveStatus}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                {!readOnly && graph.nodes.length > 1 && isSelected && onChangeGraph && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onChangeGraph({
                        nodes: graph.nodes.filter((n) => n.id !== node.id),
                        edges: graph.edges.filter(
                          (ed) => ed.source !== node.id && ed.target !== node.id
                        ),
                      });
                      onSelectNode(null);
                    }}
                    className="rounded p-1 text-rose-400 hover:bg-rose-500/10"
                    title="Delete node"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>

              <div className="mt-2 truncate font-mono text-[10px] text-[#64748B]">
                id: {node.id}
              </div>

              {/* Output Port(s) */}
              {node.type !== "completion" &&
                (node.type === "condition" ? (
                  <>
                    <button
                      type="button"
                      title="Drag/Click to wire TRUE branch"
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        const pos = screenToCanvas(e.clientX, e.clientY);
                        setConnectingFrom({
                          sourceId: node.id,
                          sourceHandle: "true",
                          cursorX: pos.x,
                          cursorY: pos.y,
                        });
                      }}
                      className="absolute -right-2.5 top-[28%] flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full border-2 border-[#00FFA3] bg-[#090A0F] text-[8px] font-bold text-[#00FFA3] hover:scale-125"
                    >
                      T
                    </button>
                    <button
                      type="button"
                      title="Drag/Click to wire FALSE branch"
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        const pos = screenToCanvas(e.clientX, e.clientY);
                        setConnectingFrom({
                          sourceId: node.id,
                          sourceHandle: "false",
                          cursorX: pos.x,
                          cursorY: pos.y,
                        });
                      }}
                      className="absolute -right-2.5 top-[72%] flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full border-2 border-amber-400 bg-[#090A0F] text-[8px] font-bold text-amber-400 hover:scale-125"
                    >
                      F
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    title="Drag from here to target input port"
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      const pos = screenToCanvas(e.clientX, e.clientY);
                      setConnectingFrom({
                        sourceId: node.id,
                        cursorX: pos.x,
                        cursorY: pos.y,
                      });
                    }}
                    className="absolute -right-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-2 border-[#00FFA3]/70 bg-[#090A0F] transition hover:scale-125 hover:bg-[#00FFA3]"
                  />
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
