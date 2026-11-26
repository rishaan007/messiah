"use client";

import React from "react";
import { Bot, Cpu, FileText, GitCommit, AlertTriangle } from "lucide-react";
import { Badge } from "@messiah/ui";
import { getStatusColorHex } from "./swarmTopologyModel";
import type { SwarmRunDetail } from "@messiah/shared";

interface SwarmInspectorPanelProps {
  run: SwarmRunDetail;
  selectedNodeId: string | null;
}

export function SwarmInspectorPanel({ run, selectedNodeId }: SwarmInspectorPanelProps) {
  const selectedTask =
    selectedNodeId && selectedNodeId !== "supervisor"
      ? run.tasks.find((t) => t.id === selectedNodeId) || null
      : null;

  const targetComms = selectedTask
    ? run.communications.filter((c) => c.taskId === selectedTask.id)
    : run.communications.slice(0, 12);

  const targetExecs = selectedTask
    ? run.executions.filter((e) => e.taskId === selectedTask.id)
    : run.executions.filter((e) => e.phase === "PLANNING" || e.phase === "SYNTHESIS");

  return (
    <div className="flex flex-col h-full rounded-xl border border-[#1E2536] bg-[#0E121B] overflow-hidden">
      <div className="px-4 py-3 border-b border-[#1E2536] flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <Bot className="w-4 h-4 text-[#00FFA3] shrink-0" />
          <div className="truncate">
            <h3 className="text-xs font-semibold text-[#F0F4FC] truncate">
              {selectedTask
                ? `${selectedTask.title}`
                : run.supervisorAgent?.name || "Supervisor Architect"}
            </h3>
            <p className="text-[11px] font-mono text-[#64748B] truncate">
              {selectedTask
                ? `Task [${selectedTask.taskKey}] • ${selectedTask.assignedAgent?.name || "Worker"}`
                : `Supervisor Root • ${run.tasks.length} DAG Tasks`}
            </p>
          </div>
        </div>
        <Badge
          variant="outline"
          className="text-[10px] font-mono shrink-0 border-[#1E2536]"
          style={{
            color: getStatusColorHex(selectedTask ? selectedTask.status : run.status),
          }}
        >
          {selectedTask ? selectedTask.status : run.status}
        </Badge>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
        {selectedTask ? (
          <>
            {/* Scoped Task Instructions */}
            <div className="space-y-1.5">
              <div className="text-[10px] uppercase tracking-wider font-mono text-[#64748B]">
                Assigned Instructions
              </div>
              <div className="rounded-lg border border-[#1E2536] bg-[#090A0F] p-2.5 text-[#CBD5E1] whitespace-pre-wrap">
                {selectedTask.instructions}
              </div>
            </div>

            {/* Dependencies & Telemetry */}
            <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
              <div className="rounded-lg border border-[#1E2536] bg-[#090A0F] p-2">
                <div className="text-[#64748B]">Tokens Used</div>
                <div className="text-[#F0F4FC] mt-0.5">
                  {selectedTask.inputTokens} in / {selectedTask.outputTokens} out
                </div>
              </div>
              <div className="rounded-lg border border-[#1E2536] bg-[#090A0F] p-2">
                <div className="text-[#64748B]">Model / Attempts</div>
                <div className="text-[#F0F4FC] mt-0.5 truncate">
                  {selectedTask.assignedAgent?.modelId || "default"} • #{selectedTask.attemptCount}
                </div>
              </div>
            </div>

            {selectedTask.dependsOnKeys.length > 0 && (
              <div className="space-y-1">
                <div className="text-[10px] uppercase tracking-wider font-mono text-[#64748B]">
                  Depends On
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {selectedTask.dependsOnKeys.map((k) => (
                    <Badge key={k} variant="outline" className="text-[10px] font-mono border-[#1E2536] text-[#94A3B8]">
                      <GitCommit className="w-3 h-3 mr-1" />
                      {k}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {selectedTask.errorMessage && (
              <div className="rounded-lg border border-red-500/30 bg-red-950/20 p-2.5 text-red-300 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 text-red-400 mt-0.5" />
                <div>
                  <div className="font-mono text-[10px] uppercase text-red-400">
                    {selectedTask.errorCode || "Error"}
                  </div>
                  <div>{selectedTask.errorMessage}</div>
                </div>
              </div>
            )}

            {selectedTask.outputSummary && (
              <div className="space-y-1.5">
                <div className="text-[10px] uppercase tracking-wider font-mono text-[#64748B]">
                  Worker Result Deliverable
                </div>
                <div className="rounded-lg border border-[#1E2536] bg-[#090A0F] p-2.5 text-[#E2E8F0] whitespace-pre-wrap max-h-48 overflow-y-auto font-mono text-[11px]">
                  {selectedTask.outputSummary}
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            {/* Supervisor Goal & Plan Summary */}
            <div className="space-y-1.5">
              <div className="text-[10px] uppercase tracking-wider font-mono text-[#64748B]">
                Objective
              </div>
              <div className="rounded-lg border border-[#1E2536] bg-[#090A0F] p-2.5 text-[#CBD5E1]">
                {run.objective}
              </div>
            </div>

            {run.planJson && (
              <div className="space-y-1.5">
                <div className="text-[10px] uppercase tracking-wider font-mono text-[#64748B]">
                  Compiled Plan Strategy
                </div>
                <div className="rounded-lg border border-[#1E2536] bg-[#090A0F] p-2.5 text-[#94A3B8]">
                  {run.planJson.goalSummary}
                </div>
              </div>
            )}
          </>
        )}

        {/* Executions / Tool Trace */}
        {targetExecs.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-wider font-mono text-[#64748B]">
              Execution Attempts ({targetExecs.length})
            </div>
            <div className="space-y-1.5">
              {targetExecs.map((ex) => (
                <div
                  key={ex.id}
                  className="rounded-lg border border-[#1E2536] bg-[#090A0F] px-2.5 py-2 flex items-center justify-between text-[11px] font-mono"
                >
                  <div className="truncate pr-2">
                    <span className="text-[#F0F4FC]">{ex.phase}</span>
                    <span className="text-[#64748B]"> • {ex.iterationsUsed} iter • {ex.durationMs ?? "..."}ms</span>
                  </div>
                  <span style={{ color: getStatusColorHex(ex.status) }}>{ex.status}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Scoped Agent Communications */}
        {targetComms.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-wider font-mono text-[#64748B]">
              Scoped Message Handoffs ({targetComms.length})
            </div>
            <div className="space-y-1.5">
              {targetComms.map((comm) => (
                <div
                  key={comm.id}
                  className="rounded-lg border border-[#1E2536] bg-[#090A0F] p-2 text-[11px]"
                >
                  <div className="flex items-center justify-between text-[10px] font-mono text-[#64748B] mb-1">
                    <span>{comm.messageType}</span>
                    <span>sha:{comm.payloadDigest.slice(0, 8)}</span>
                  </div>
                  <div className="text-[#CBD5E1] line-clamp-3 font-mono text-[10px]">
                    {comm.summary}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Artifacts */}
        {run.artifacts.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-wider font-mono text-[#64748B]">
              Generated Artifacts ({run.artifacts.length})
            </div>
            <div className="space-y-1.5">
              {run.artifacts.map((art) => (
                <div
                  key={art.id}
                  className="rounded-lg border border-[#1E2536] bg-[#090A0F] p-2.5 text-[11px]"
                >
                  <div className="flex items-center gap-1.5 font-medium text-[#00FFA3] mb-1">
                    <FileText className="w-3.5 h-3.5" />
                    <span>{art.title}</span>
                    <span className="text-[10px] font-mono text-[#64748B] ml-auto">{art.artifactType}</span>
                  </div>
                  <div className="text-[#94A3B8] line-clamp-4 whitespace-pre-wrap">{art.content}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Budget Meter */}
        <div className="rounded-lg border border-[#1E2536] bg-[#090A0F] p-2.5 text-[11px] font-mono space-y-1">
          <div className="flex items-center justify-between text-[#64748B]">
            <span className="flex items-center gap-1">
              <Cpu className="w-3 h-3" /> Budget Ceiling
            </span>
            <span className="text-[#F0F4FC]">
              {run.inputTokens + run.outputTokens} / {run.maxTotalTokens} tokens
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-[#1E2536] overflow-hidden">
            <div
              className="h-full bg-[#00FFA3] transition-all"
              style={{
                width: `${Math.min(
                  100,
                  Math.round(((run.inputTokens + run.outputTokens) / Math.max(run.maxTotalTokens, 1)) * 100)
                )}%`,
              }}
            />
          </div>
          <div className="flex justify-between text-[10px] text-[#64748B]">
            <span>Est. Cost: ${run.estimatedCostUsd.toFixed(4)}</span>
            <span>Max: ${run.maxCostUsd.toFixed(2)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
