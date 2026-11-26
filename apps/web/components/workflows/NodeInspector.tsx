"use client";

import React from "react";
import { AlertTriangle, CheckCircle2, Trash2 } from "lucide-react";
import {
  BRIDGE_CAPABILITIES,
  WORKFLOW_EVENT_TYPES,
  type AgentDefinitionInfo,
  type BridgeDeviceInfo,
  type McpToolDefinitionInfo,
  type WorkflowEdgeSpec,
  type WorkflowNodeSpec,
  type WorkflowValidationResult,
} from "@messiah/shared";

interface NodeInspectorProps {
  node: WorkflowNodeSpec | null;
  edges: WorkflowEdgeSpec[];
  allNodes: WorkflowNodeSpec[];
  agents: AgentDefinitionInfo[];
  mcpTools: McpToolDefinitionInfo[];
  devices: BridgeDeviceInfo[];
  validation: WorkflowValidationResult | null;
  onUpdateNode: (updated: WorkflowNodeSpec) => void;
  onDeleteEdge: (edgeId: string) => void;
  onAddEdge: (sourceId: string, targetId: string, sourceHandle?: string) => void;
}

const ALL_CAPS = Object.values(BRIDGE_CAPABILITIES);

export function NodeInspector({
  node,
  edges,
  allNodes,
  agents,
  mcpTools,
  devices,
  validation,
  onUpdateNode,
  onDeleteEdge,
  onAddEdge,
}: NodeInspectorProps) {
  const [connectTargetId, setConnectTargetId] = React.useState("");
  const [connectHandle, setConnectHandle] = React.useState("");

  if (!node) {
    return (
      <div className="space-y-4 text-xs">
        <div className="rounded-lg border border-[#1E2536] bg-[#090A0F] p-4 text-[#8E9BB4]">
          Click any node on the canvas to configure prompts, cron expressions, tool arguments, approval gates, or edge connections.
        </div>

        {validation && (
          <div className="space-y-2 rounded-lg border border-[#1E2536] bg-[#090A0F] p-3">
            <div className="flex items-center gap-2 font-semibold">
              {validation.valid ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-[#00FFA3]" />
                  <span className="text-[#00FFA3]">DAG Validation Passed</span>
                </>
              ) : (
                <>
                  <AlertTriangle className="h-4 w-4 text-rose-400" />
                  <span className="text-rose-300">Validation Issues ({validation.issues.length})</span>
                </>
              )}
            </div>
            {validation.issues.map((iss, idx) => (
              <div
                key={idx}
                className={`rounded border px-2.5 py-1.5 text-[11px] ${
                  iss.severity === "error"
                    ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
                    : "border-amber-500/40 bg-amber-500/10 text-amber-300"
                }`}
              >
                {iss.message}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  const cfg = (node.config || {}) as Record<string, unknown>;
  const updateConfig = (patch: Record<string, unknown>) => {
    onUpdateNode({
      ...node,
      config: { ...cfg, ...patch },
    });
  };

  const outgoingEdges = edges.filter((e) => e.source === node.id);

  return (
    <div className="space-y-4 text-xs">
      <div>
        <div className="text-[11px] uppercase tracking-wider text-[#00F0FF]">
          {node.type.replace(/_/g, " ")}
        </div>
        <label className="mt-2 mb-1 block text-[#8E9BB4]">Node Title</label>
        <input
          value={node.title}
          onChange={(e) => onUpdateNode({ ...node, title: e.target.value })}
          className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-1.5 text-xs"
        />
      </div>

      {/* Node-Type Specific Controls */}
      {node.type === "schedule_trigger" && (
        <div className="space-y-2.5">
          <div>
            <label className="mb-1 block text-[#8E9BB4]">Cron Expression (5-field)</label>
            <input
              value={String(cfg.cronExpression || "0 9 * * *")}
              onChange={(e) => updateConfig({ cronExpression: e.target.value })}
              placeholder="0 9 * * *"
              className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-1.5 font-mono text-xs"
            />
          </div>
          <div>
            <label className="mb-1 block text-[#8E9BB4]">Timezone (IANA)</label>
            <input
              value={String(cfg.timezone || "UTC")}
              onChange={(e) => updateConfig({ timezone: e.target.value })}
              placeholder="UTC"
              className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-1.5 text-xs"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-[#8E9BB4]">Misfire Policy</label>
              <select
                value={String(cfg.misfirePolicy || "FIRE_ONCE")}
                onChange={(e) => updateConfig({ misfirePolicy: e.target.value })}
                className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-2 py-1.5 text-xs"
              >
                <option value="FIRE_ONCE">Fire Once</option>
                <option value="SKIP">Skip Missed</option>
                <option value="CATCH_UP_BOUNDED">Catch Up (Max 5)</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[#8E9BB4]">Concurrency</label>
              <select
                value={String(cfg.concurrencyPolicy || "SKIP_IF_RUNNING")}
                onChange={(e) => updateConfig({ concurrencyPolicy: e.target.value })}
                className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-2 py-1.5 text-xs"
              >
                <option value="SKIP_IF_RUNNING">Skip if Active</option>
                <option value="ALLOW_CONCURRENT">Allow Concurrent</option>
                <option value="REPLACE_QUEUED">Replace Queued</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {node.type === "event_trigger" && (
        <div className="space-y-2.5">
          <div>
            <label className="mb-1 block text-[#8E9BB4]">Domain Event Type</label>
            <select
              value={String(cfg.eventType || "swarm.completed")}
              onChange={(e) => updateConfig({ eventType: e.target.value })}
              className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-2.5 py-1.5 text-xs"
            >
              {WORKFLOW_EVENT_TYPES.map((evt) => (
                <option key={evt} value={evt}>
                  {evt}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[#8E9BB4]">Cooldown (Seconds)</label>
            <input
              type="number"
              min={1}
              max={3600}
              value={Number(cfg.cooldownSeconds ?? 5)}
              onChange={(e) => updateConfig({ cooldownSeconds: Number(e.target.value) })}
              className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-1.5 text-xs"
            />
          </div>
        </div>
      )}

      {node.type === "run_agent" && (
        <div className="space-y-2.5">
          <div>
            <label className="mb-1 block text-[#8E9BB4]">Assigned Agent</label>
            <select
              value={String(cfg.agentId || "")}
              onChange={(e) => updateConfig({ agentId: e.target.value || undefined })}
              className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-2.5 py-1.5 text-xs"
            >
              <option value="">Match by Role Hint ({String(cfg.agentRoleHint || "any")})</option>
              {agents.map((ag) => (
                <option key={ag.id} value={ag.id}>
                  {ag.name} ({ag.roleTitle})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[#8E9BB4]">Prompt Template</label>
            <textarea
              rows={4}
              value={String(cfg.promptTemplate || "")}
              onChange={(e) => updateConfig({ promptTemplate: e.target.value })}
              placeholder="Use {{trigger.payload...}} or {{steps.nodeId.output.summary}}"
              className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2 text-xs"
            />
          </div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={cfg.useMemoryRetrieval !== false}
              onChange={(e) => updateConfig({ useMemoryRetrieval: e.target.checked })}
            />
            <span>Retrieve relevant Long-Term Memory</span>
          </label>
        </div>
      )}

      {node.type === "run_swarm" && (
        <div className="space-y-2.5">
          <div>
            <label className="mb-1 block text-[#8E9BB4]">Supervisor Agent</label>
            <select
              value={String(cfg.supervisorAgentId || "")}
              onChange={(e) => updateConfig({ supervisorAgentId: e.target.value || undefined })}
              className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-2.5 py-1.5 text-xs"
            >
              <option value="">Auto-select workspace supervisor</option>
              {agents
                .filter((a) => a.canSupervise)
                .map((ag) => (
                  <option key={ag.id} value={ag.id}>
                    {ag.name}
                  </option>
                ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[#8E9BB4]">Swarm Objective Template</label>
            <textarea
              rows={3}
              value={String(cfg.objectiveTemplate || "")}
              onChange={(e) => updateConfig({ objectiveTemplate: e.target.value })}
              className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2 text-xs"
            />
          </div>
        </div>
      )}

      {node.type === "mcp_tool" && (
        <div className="space-y-2.5">
          <div>
            <label className="mb-1 block text-[#8E9BB4]">Workspace MCP Tool</label>
            <select
              value={String(cfg.toolDefinitionId || "")}
              onChange={(e) => {
                const tool = mcpTools.find((t) => t.id === e.target.value);
                updateConfig({
                  toolDefinitionId: e.target.value,
                  toolName: tool?.toolName || cfg.toolName,
                });
              }}
              className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-2.5 py-1.5 text-xs"
            >
              <option value="">Select MCP tool...</option>
              {mcpTools.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.toolName}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[#8E9BB4]">Tool Arguments (JSON)</label>
            <textarea
              rows={4}
              value={JSON.stringify(cfg.arguments || {}, null, 2)}
              onChange={(e) => {
                try {
                  updateConfig({ arguments: JSON.parse(e.target.value) });
                } catch {}
              }}
              className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2 font-mono text-[11px]"
            />
          </div>
        </div>
      )}

      {node.type === "bridge_capability" && (
        <div className="space-y-2.5">
          <div>
            <label className="mb-1 block text-[#8E9BB4]">Target Bridge Device</label>
            <select
              value={String(cfg.deviceId || "")}
              onChange={(e) => updateConfig({ deviceId: e.target.value })}
              className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-2.5 py-1.5 text-xs"
            >
              <option value="">Select device...</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.displayName} ({d.platform})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[#8E9BB4]">Capability</label>
            <select
              value={String(cfg.capability || "")}
              onChange={(e) => updateConfig({ capability: e.target.value })}
              className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-2.5 py-1.5 text-xs"
            >
              <option value="">Select capability...</option>
              {ALL_CAPS.map((cap) => (
                <option key={cap} value={cap}>
                  {cap}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {node.type === "condition" && (
        <div>
          <label className="mb-1 block text-[#8E9BB4]">Safe Boolean Rule</label>
          <textarea
            rows={3}
            value={String(cfg.expression || "")}
            onChange={(e) => updateConfig({ expression: e.target.value })}
            placeholder='steps.review.output.summary contains "high"'
            className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2 font-mono text-[11px]"
          />
        </div>
      )}

      {node.type === "approval_gate" && (
        <div className="space-y-2">
          <div>
            <label className="mb-1 block text-[#8E9BB4]">Gate Prompt Title</label>
            <input
              value={String(cfg.title || "")}
              onChange={(e) => updateConfig({ title: e.target.value })}
              className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-1.5 text-xs"
            />
          </div>
          <div>
            <label className="mb-1 block text-[#8E9BB4]">Review Summary Template</label>
            <textarea
              rows={3}
              value={String(cfg.summaryTemplate || "")}
              onChange={(e) => updateConfig({ summaryTemplate: e.target.value })}
              className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2 text-xs"
            />
          </div>
        </div>
      )}

      {node.type === "transform" && (
        <div>
          <label className="mb-1 block text-[#8E9BB4]">Safe Output Template</label>
          <textarea
            rows={4}
            value={String(cfg.template || "")}
            onChange={(e) => updateConfig({ mode: "template", template: e.target.value })}
            className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2 text-xs"
          />
        </div>
      )}

      {node.type === "store_result" && (
        <div className="space-y-2.5">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={Boolean(cfg.saveToMemory)}
              onChange={(e) => updateConfig({ saveToMemory: e.target.checked })}
            />
            <span>Persist result to Long-Term Memory</span>
          </label>
          {Boolean(cfg.saveToMemory) && (
            <div className="space-y-2">
              <select
                value={String(cfg.memoryScope || "WORKSPACE")}
                onChange={(e) => updateConfig({ memoryScope: e.target.value })}
                className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-2.5 py-1.5 text-xs"
              >
                <option value="WORKSPACE">Workspace Memory</option>
                <option value="PERSONAL">Personal Memory</option>
                <option value="AGENT">Agent Memory</option>
              </select>
              <input
                value={String(cfg.memoryTitleTemplate || "")}
                onChange={(e) => updateConfig({ memoryTitleTemplate: e.target.value })}
                placeholder="Memory Title"
                className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-1.5 text-xs"
              />
            </div>
          )}
          <div>
            <label className="mb-1 block text-[#8E9BB4]">Output Value Template</label>
            <textarea
              rows={3}
              value={String(cfg.outputTemplate || "")}
              onChange={(e) => updateConfig({ outputTemplate: e.target.value })}
              className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2 text-xs"
            />
          </div>
        </div>
      )}

      {node.type === "completion" && (
        <div>
          <label className="mb-1 block text-[#8E9BB4]">Final Completion Summary Template</label>
          <textarea
            rows={3}
            value={String(cfg.summaryTemplate || "")}
            onChange={(e) => updateConfig({ summaryTemplate: e.target.value })}
            className="w-full rounded-lg border border-[#1E2536] bg-[#090A0F] px-3 py-2 text-xs"
          />
        </div>
      )}

      {/* Outgoing Connections Panel */}
      {node.type !== "completion" && (
        <div className="space-y-2 border-t border-[#1E2536] pt-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[#8E9BB4]">
            Outgoing Connections
          </div>
          {outgoingEdges.map((edge) => {
            const dst = allNodes.find((n) => n.id === edge.target);
            return (
              <div
                key={edge.id}
                className="flex items-center justify-between rounded border border-[#1E2536] bg-[#090A0F] px-2.5 py-1.5"
              >
                <span className="truncate text-[11px]">
                  {edge.sourceHandle ? `[${edge.sourceHandle}] → ` : "→ "}
                  {dst?.title || edge.target}
                </span>
                <button
                  type="button"
                  onClick={() => onDeleteEdge(edge.id)}
                  className="text-rose-400 hover:text-rose-300"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
          <div className="flex gap-1.5 pt-1">
            <select
              value={connectTargetId}
              onChange={(e) => setConnectTargetId(e.target.value)}
              className="flex-1 rounded border border-[#1E2536] bg-[#090A0F] px-2 py-1 text-[11px]"
            >
              <option value="">Connect to node...</option>
              {allNodes
                .filter((n) => n.id !== node.id && !n.type.endsWith("_trigger"))
                .map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.title}
                  </option>
                ))}
            </select>
            {node.type === "condition" && (
              <select
                value={connectHandle}
                onChange={(e) => setConnectHandle(e.target.value)}
                className="w-16 rounded border border-[#1E2536] bg-[#090A0F] px-1 py-1 text-[11px]"
              >
                <option value="true">True</option>
                <option value="false">False</option>
              </select>
            )}
            <button
              type="button"
              onClick={() => {
                if (!connectTargetId) return;
                onAddEdge(
                  node.id,
                  connectTargetId,
                  node.type === "condition" ? connectHandle || "true" : undefined
                );
                setConnectTargetId("");
              }}
              className="rounded border border-[#00F0FF]/40 bg-[#00F0FF]/10 px-2.5 py-1 text-[11px] font-medium text-[#00F0FF]"
            >
              Link
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
