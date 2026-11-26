"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  Play,
  Save,
  Rocket,
  Plus,
} from "lucide-react";
import { Button, Badge } from "@messiah/ui";
import { createClient } from "@/lib/supabase/client";
import { WorkflowCanvas, getNodeVisualMeta } from "@/components/workflows/WorkflowCanvas";
import { NodeInspector } from "@/components/workflows/NodeInspector";
import {
  WORKFLOW_NODE_TYPES,
  type AgentDefinitionInfo,
  type BridgeDeviceInfo,
  type McpToolDefinitionInfo,
  type WorkflowDefinitionInfo,
  type WorkflowEdgeSpec,
  type WorkflowGraphDefinition,
  type WorkflowNodeSpec,
  type WorkflowNodeType,
  type WorkflowValidationResult,
  type WorkspaceInfo,
} from "@messiah/shared";

const DEFAULT_CONFIG_BY_TYPE: Record<WorkflowNodeType, Record<string, unknown>> = {
  manual_trigger: { defaultPayload: {} },
  schedule_trigger: {
    cronExpression: "0 9 * * *",
    timezone: "UTC",
    misfirePolicy: "FIRE_ONCE",
    concurrencyPolicy: "SKIP_IF_RUNNING",
  },
  event_trigger: { eventType: "swarm.completed", cooldownSeconds: 5, filterRules: {} },
  run_agent: { promptTemplate: "Analyze upstream input: {{steps}}", useMemoryRetrieval: true },
  run_swarm: { objectiveTemplate: "{{trigger.payload.objective}}", maxConcurrency: 3 },
  mcp_tool: { arguments: {} },
  bridge_capability: { capability: "filesystem.list", resourceScopes: [], parameters: {} },
  condition: { expression: "true" },
  approval_gate: {
    title: "Human Approval Required",
    summaryTemplate: "Confirm proceeding past this workflow checkpoint.",
  },
  transform: { mode: "template", template: "{{steps}}" },
  merge: { joinMode: "ALL" },
  store_result: {
    saveToMemory: true,
    memoryScope: "WORKSPACE",
    memoryTitleTemplate: "Workflow Insight",
    outputTemplate: "{{steps}}",
  },
  completion: { summaryTemplate: "Workflow completed cleanly." },
};

export default function WorkflowBuilderStudioPage() {
  const params = useParams();
  const workflowId = String(params?.workflowId || "");
  const router = useRouter();
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

  const [authToken, setAuthToken] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowDefinitionInfo | null>(null);
  const [graph, setGraph] = useState<WorkflowGraphDefinition>({ nodes: [], edges: [] });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [validation, setValidation] = useState<WorkflowValidationResult | null>(null);

  const [agents, setAgents] = useState<AgentDefinitionInfo[]>([]);
  const [mcpTools, setMcpTools] = useState<McpToolDefinitionInfo[]>([]);
  const [devices, setDevices] = useState<BridgeDeviceInfo[]>([]);

  const [notice, setNotice] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const loadAll = useCallback(async () => {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token) {
      router.push("/login");
      return;
    }
    setAuthToken(session.access_token);

    const wsRes = await fetch(`${apiUrl}/api/v1/workspaces`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (!wsRes.ok) return;
    const ws: WorkspaceInfo | undefined = ((await wsRes.json()).data || [])[0];
    if (!ws) return;
    setWorkspace(ws);

    const [wfRes, agRes, toolRes, devRes] = await Promise.all([
      fetch(`${apiUrl}/api/v1/workflows/${workflowId}?workspaceId=${ws.id}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      }),
      fetch(`${apiUrl}/api/v1/agents?workspaceId=${ws.id}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      }),
      fetch(`${apiUrl}/api/v1/mcp/tools?workspaceId=${ws.id}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      }),
      fetch(`${apiUrl}/api/v1/devices?workspaceId=${ws.id}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      }),
    ]);

    if (wfRes.ok) {
      const wfData: WorkflowDefinitionInfo = (await wfRes.json()).data;
      setWorkflow(wfData);
      setGraph(wfData.draftGraph || { nodes: [], edges: [] });
    }
    if (agRes.ok) setAgents((await agRes.json()).data || []);
    if (toolRes.ok) setMcpTools((await toolRes.json()).data || []);
    if (devRes.ok) setDevices((await devRes.json()).data || []);
  }, [apiUrl, router, workflowId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleValidate = async (): Promise<boolean> => {
    if (!authToken || !workspace) return false;
    const res = await fetch(`${apiUrl}/api/v1/workflows/validate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ workspaceId: workspace.id, graph }),
    });
    const json = await res.json();
    if (res.ok) {
      setValidation(json.data);
      return Boolean(json.data?.valid);
    }
    return false;
  };

  const handleSaveDraft = async () => {
    if (!authToken || !workspace || !workflow) return;
    setIsSaving(true);
    setErrorMsg(null);
    setNotice(null);
    try {
      const res = await fetch(`${apiUrl}/api/v1/workflows/${workflow.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          workspaceId: workspace.id,
          draftGraph: graph,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErrorMsg(json.error?.message || "Failed to save draft.");
        return;
      }
      setWorkflow(json.data);
      setNotice("Draft saved cleanly.");
      await handleValidate();
    } finally {
      setIsSaving(false);
    }
  };

  const handlePublish = async () => {
    if (!authToken || !workspace || !workflow) return;
    setIsSaving(true);
    setErrorMsg(null);
    setNotice(null);
    try {
      // Save draft first
      await fetch(`${apiUrl}/api/v1/workflows/${workflow.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ workspaceId: workspace.id, draftGraph: graph }),
      });

      const res = await fetch(`${apiUrl}/api/v1/workflows/${workflow.id}/publish`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ workspaceId: workspace.id, activate: true }),
      });
      const json = await res.json();
      if (!res.ok) {
        if (json.error?.details) setValidation(json.error.details);
        setErrorMsg(json.error?.message || "Publish failed DAG validation.");
        return;
      }
      setWorkflow(json.data);
      setNotice(`Published immutable version v${json.data.activeVersionNumber} & activated triggers.`);
      await handleValidate();
    } finally {
      setIsSaving(false);
    }
  };

  const handleRunNow = async () => {
    if (!authToken || !workspace || !workflow) return;
    await handleSaveDraft();
    const res = await fetch(`${apiUrl}/api/v1/workflows/${workflow.id}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ workspaceId: workspace.id, triggerPayload: {} }),
    });
    const json = await res.json();
    if (!res.ok) {
      setErrorMsg(json.error?.message || "Failed to start workflow run.");
      return;
    }
    router.push(`/workflows/runs/${json.data.id}`);
  };

  const addNodeFromPalette = (nodeType: WorkflowNodeType) => {
    const id = `${nodeType.slice(0, 6)}_${Date.now().toString(36).slice(-4)}`;
    const maxX = graph.nodes.reduce((acc, n) => Math.max(acc, n.position.x), 80);
    const newNode: WorkflowNodeSpec = {
      id,
      type: nodeType,
      title: nodeType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      position: { x: Math.min(maxX + 120, 1100), y: 180 + (graph.nodes.length % 3) * 90 },
      config: { ...DEFAULT_CONFIG_BY_TYPE[nodeType] },
    };

    const nextEdges = [...graph.edges];
    if (selectedNodeId && !nodeType.endsWith("_trigger")) {
      nextEdges.push({
        id: `e_${selectedNodeId}_${id}`,
        source: selectedNodeId,
        target: id,
      });
    }

    setGraph({ nodes: [...graph.nodes, newNode], edges: nextEdges });
    setSelectedNodeId(id);
  };

  const selectedNode = graph.nodes.find((n) => n.id === selectedNodeId) || null;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#090A0F] text-[#F0F4FC]">
      {/* Studio Top Bar */}
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
              <h1 className="text-sm font-semibold">{workflow?.name || "Workflow Studio"}</h1>
              {workflow && (
                <Badge variant="outline" className="border-[#00FFA3]/40 text-[10px] text-[#00FFA3]">
                  {workflow.status} · v{workflow.activeVersionNumber ?? "draft"}
                </Badge>
              )}
            </div>
            {notice && <p className="text-[11px] text-[#00FFA3]">{notice}</p>}
            {errorMsg && <p className="text-[11px] text-rose-400">{errorMsg}</p>}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleValidate} className="border-[#1E2536] text-xs">
            <CheckCircle2 className="mr-1.5 h-3.5 w-3.5 text-[#00FFA3]" /> Validate DAG
          </Button>
          <Button
            variant="outline"
            disabled={isSaving}
            onClick={handleSaveDraft}
            className="border-[#1E2536] text-xs"
          >
            <Save className="mr-1.5 h-3.5 w-3.5" /> Save Draft
          </Button>
          <Button
            variant="outline"
            disabled={isSaving}
            onClick={handlePublish}
            className="border-[#00F0FF]/40 bg-[#00F0FF]/10 text-xs text-[#00F0FF]"
          >
            <Rocket className="mr-1.5 h-3.5 w-3.5" /> Publish Version
          </Button>
          <Button
            onClick={handleRunNow}
            className="bg-[#00FFA3] text-xs font-semibold text-[#090A0F]"
          >
            <Play className="mr-1.5 h-3.5 w-3.5" /> Execute Workflow
          </Button>
        </div>
      </header>

      {/* Studio 3-Pane Workspace */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Node Palette */}
        <aside className="w-56 shrink-0 overflow-y-auto border-r border-[#1E2536] bg-[#0B0D14] p-3 space-y-2">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[#8E9BB4]">
            Node Palette
          </div>
          <p className="text-[10px] text-[#64748B]">Click a block to insert & connect cleanly.</p>
          <div className="space-y-1.5 pt-1">
            {WORKFLOW_NODE_TYPES.map((nt) => {
              const meta = getNodeVisualMeta(nt);
              const Icon = meta.icon;
              return (
                <button
                  key={nt}
                  type="button"
                  onClick={() => addNodeFromPalette(nt)}
                  className="flex w-full items-center justify-between rounded-lg border border-[#1E2536] bg-[#12151E] px-2.5 py-2 text-left text-xs transition hover:border-[#00F0FF]/50"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: meta.accent }} />
                    <span className="truncate capitalize">{nt.replace(/_/g, " ")}</span>
                  </span>
                  <Plus className="h-3 w-3 text-[#64748B]" />
                </button>
              );
            })}
          </div>
        </aside>

        {/* Center Interactive DAG Canvas */}
        <main className="flex-1 p-3">
          <WorkflowCanvas
            graph={graph}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
            onChangeGraph={setGraph}
          />
        </main>

        {/* Right Node Inspector */}
        <aside className="w-80 shrink-0 overflow-y-auto border-l border-[#1E2536] bg-[#12151E] p-4">
          <div className="mb-3 border-b border-[#1E2536] pb-2 text-xs font-semibold uppercase tracking-wider text-[#8E9BB4]">
            Node Inspector
          </div>
          <NodeInspector
            node={selectedNode}
            edges={graph.edges}
            allNodes={graph.nodes}
            agents={agents}
            mcpTools={mcpTools}
            devices={devices}
            validation={validation}
            onUpdateNode={(updated) => {
              setGraph((prev) => ({
                ...prev,
                nodes: prev.nodes.map((n) => (n.id === updated.id ? updated : n)),
              }));
            }}
            onDeleteEdge={(edgeId) => {
              setGraph((prev) => ({
                ...prev,
                edges: prev.edges.filter((e) => e.id !== edgeId),
              }));
            }}
            onAddEdge={(source, target, sourceHandle) => {
              const newEdge: WorkflowEdgeSpec = {
                id: `e_${source}_${target}_${Date.now().toString(36)}`,
                source,
                target,
                ...(sourceHandle ? { sourceHandle, label: sourceHandle === "true" ? "True" : "False" } : {}),
              };
              setGraph((prev) => ({ ...prev, edges: [...prev.edges, newEdge] }));
            }}
          />
        </aside>
      </div>
    </div>
  );
}
