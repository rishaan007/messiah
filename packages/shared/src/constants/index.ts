export const PRODUCT_IDENTITY = {
  name: "MESSIAH",
  fullName: "MESSIAH — The Universal AI Agent Workspace",
  tagline: "One intelligence layer. Every agent. Every device.",
  version: "0.1.0",
} as const;

export const DEFAULT_PORTS = {
  web: 3000,
  server: 3001,
  postgres: 5432,
  redis: 6380,
} as const;

export const API_ROUTES = {
  healthLive: "/health/live",
  healthReady: "/health/ready",
  systemInfo: "/api/v1/system",
} as const;

export const DEVICE_CONSTANTS = {
  PROTOCOL_VERSION: "2026-08-01",
  HEARTBEAT_INTERVAL_MS: 15000,
  HEARTBEAT_TIMEOUT_MS: 45000,
  WSS_CHALLENGE_TTL_MS: 30000,
  PAIRING_CHALLENGE_TTL_SECONDS: 300, // 5 minutes
  MAX_PAIRING_FAILED_ATTEMPTS: 5,
  MAX_FRAME_SIZE_BYTES: 65536, // 64KB frame limit for device messages
  KEY_ALGORITHM: "ed25519",
  SIGNING_PREFIX: "MESSIAH_DEVICE_AUTH",
} as const;

export const BRIDGE_CAPABILITIES = {
  FILESYSTEM_LIST: "filesystem.list",
  FILESYSTEM_READ: "filesystem.read",
  FILESYSTEM_SEARCH: "filesystem.search",
  FILESYSTEM_CREATE: "filesystem.create",
  FILESYSTEM_MODIFY: "filesystem.modify",
  FILESYSTEM_DELETE: "filesystem.delete",
  MCP_DISCOVER: "mcp.discover",
  MCP_INVOKE: "mcp.invoke",
  PROCESS_RUN: "process.run",
  PROCESS_INSPECT: "process.inspect",
  AGENT_START: "agent.start",
  AGENT_STATUS: "agent.status",
  AGENT_CANCEL: "agent.cancel",
} as const;

export const TASK_CONSTANTS = {
  DEFAULT_TIMEOUT_MS: 120000, // 2 minutes
  MAX_TIMEOUT_MS: 600000, // 10 minutes
  MAX_LOG_CHUNK_BYTES: 32768, // 32KB
  SIGNING_PREFIX: "MESSIAH_TASK_AUTH",
  APPROVAL_TTL_MS: 300000, // 5 minutes
  MAX_OUTPUT_BYTES: 1048576, // 1MB output cap
  DEFAULT_MAX_PROCESSES: 5,
  DEFAULT_MAX_MEMORY_BYTES: 1073741824, // 1GB
} as const;

export const DEVICE_API_ROUTES = {
  connect: "/api/v1/devices/connect",
  list: "/api/v1/devices",
  createPairingChallenge: "/api/v1/devices/pair/challenge",
  claimPairingChallenge: "/api/v1/devices/pair/claim",
  pendingChallenges: "/api/v1/devices/pair/pending",
  approvePairing: "/api/v1/devices/pair/:challengeId/approve",
  rejectPairing: "/api/v1/devices/pair/:challengeId/reject",
  deviceDetail: "/api/v1/devices/:deviceId",
  renameDevice: "/api/v1/devices/:deviceId/rename",
  pauseDevice: "/api/v1/devices/:deviceId/pause",
  resumeDevice: "/api/v1/devices/:deviceId/resume",
  revokeDevice: "/api/v1/devices/:deviceId/revoke",
  deviceCapabilities: "/api/v1/devices/:deviceId/capabilities",
  devicePolicy: "/api/v1/devices/:deviceId/policy",
  deviceLocalMcp: "/api/v1/devices/:deviceId/mcp",
  deviceTasks: "/api/v1/devices/:deviceId/tasks",
  taskDetail: "/api/v1/devices/tasks/:taskId",
  taskApprove: "/api/v1/devices/tasks/:taskId/approve",
  taskReject: "/api/v1/devices/tasks/:taskId/reject",
  taskCancel: "/api/v1/devices/tasks/:taskId/cancel",
  taskLogs: "/api/v1/devices/tasks/:taskId/logs",
} as const;

export const SWARM_CONSTANTS = {
  MAX_AGENTS_PER_WORKSPACE: 50,
  MAX_WORKERS_PER_RUN: 8,
  MAX_TASKS_PER_RUN: 24,
  MAX_CONCURRENCY: 5,
  DEFAULT_MAX_TOTAL_TOKENS: 120000,
  DEFAULT_MAX_COST_USD: 2.0,
  DEFAULT_MAX_DURATION_MS: 300000,
  DEFAULT_MAX_DELEGATION_DEPTH: 2,
  DEFAULT_MAX_REPLAN_ROUNDS: 1,
} as const;

export const AGENT_API_ROUTES = {
  agents: "/api/v1/agents",
  agentDetail: "/api/v1/agents/:agentId",
  agentDuplicate: "/api/v1/agents/:agentId/duplicate",
  agentTest: "/api/v1/agents/:agentId/test",
  seedTemplates: "/api/v1/agents/templates/seed",
  swarms: "/api/v1/swarms",
  swarmDetail: "/api/v1/swarms/:runId",
  swarmApprovePlan: "/api/v1/swarms/:runId/approve-plan",
  swarmCancel: "/api/v1/swarms/:runId/cancel",
  swarmEvents: "/api/v1/swarms/:runId/events",
} as const;

export interface AgentTemplatePreset {
  slug: string;
  name: string;
  roleTitle: string;
  category: "supervisor" | "research" | "developer" | "reviewer" | "analyst" | "assistant";
  description: string;
  avatarAccent: string;
  canSupervise: boolean;
  systemPrompt: string;
  temperature: number;
  maxOutputTokens: number;
  recommendedBridgeCapabilities: string[];
}

export const DEFAULT_AGENT_TEMPLATES: AgentTemplatePreset[] = [
  {
    slug: "supervisor-orchestrator",
    name: "Supervisor Architect",
    roleTitle: "Swarm Lead & DAG Planner",
    category: "supervisor",
    description:
      "Decomposes complex goals into acyclic task graphs, assigns specialized workers, tracks partial outcomes, and synthesizes cohesive final deliverables.",
    avatarAccent: "#00FFA3",
    canSupervise: true,
    systemPrompt:
      "You are a principal AI orchestration supervisor. Break user goals into discrete, non-overlapping tasks tailored to available worker capabilities, specify strict dependency order and explicit input handoffs, respect budgets and approval policies, and synthesize verified outputs accurately without fabrication.",
    temperature: 0.2,
    maxOutputTokens: 4096,
    recommendedBridgeCapabilities: [],
  },
  {
    slug: "research-specialist",
    name: "Research Analyst",
    roleTitle: "Information & Codebase Investigator",
    category: "research",
    description:
      "Inspects repositories, documentation, and remote sources using read-only tools and reports structured factual findings with exact references.",
    avatarAccent: "#38BDF8",
    canSupervise: false,
    systemPrompt:
      "You are a precision research specialist. Investigate assigned questions or codebase areas thoroughly, cite concrete observed files/findings, and never claim unverified behaviors or invent evidence.",
    temperature: 0.2,
    maxOutputTokens: 4096,
    recommendedBridgeCapabilities: ["filesystem.list", "filesystem.read", "filesystem.search"],
  },
  {
    slug: "developer-engineer",
    name: "Systems Developer",
    roleTitle: "Implementation & Remediation Engineer",
    category: "developer",
    description:
      "Plans and executes code edits, test runs, and sandboxed local workstation builds within approved MCP and Bridge permissions.",
    avatarAccent: "#818CF8",
    canSupervise: false,
    systemPrompt:
      "You are a senior software systems engineer. Produce clean, minimal, well-tested code changes, honor all workspace approvals and filesystem boundaries, and report concrete implementation results and verification outcomes.",
    temperature: 0.2,
    maxOutputTokens: 4096,
    recommendedBridgeCapabilities: [
      "filesystem.list",
      "filesystem.read",
      "filesystem.search",
      "filesystem.modify",
      "filesystem.create",
      "process.run",
    ],
  },
  {
    slug: "code-reviewer",
    name: "Security & Code Reviewer",
    roleTitle: "Adversarial Reviewer & Verifier",
    category: "reviewer",
    description:
      "Reviews architectures, patches, security invariants, and test gaps with strict correctness and vulnerability scrutiny.",
    avatarAccent: "#F472B6",
    canSupervise: false,
    systemPrompt:
      "You are a senior security and quality reviewer. Audit code, diffs, and plans for bugs, IDORs, race conditions, missing error handling, and unverified claims. Classify findings by severity with concrete fixes.",
    temperature: 0.1,
    maxOutputTokens: 4096,
    recommendedBridgeCapabilities: ["filesystem.list", "filesystem.read", "filesystem.search"],
  },
  {
    slug: "data-analyst",
    name: "Quantitative Analyst",
    roleTitle: "Metrics, Logs & Architecture Analyst",
    category: "analyst",
    description:
      "Synthesizes execution telemetry, logs, benchmarks, and structured tradeoffs into concise tables and recommendations.",
    avatarAccent: "#FBBF24",
    canSupervise: false,
    systemPrompt:
      "You are a quantitative and technical systems analyst. Compare options, analyze logs and telemetry rigorously, separate measured facts from hypotheses, and summarize conclusions crisply.",
    temperature: 0.2,
    maxOutputTokens: 4096,
    recommendedBridgeCapabilities: ["filesystem.read", "filesystem.search"],
  },
  {
    slug: "general-assistant",
    name: "General Specialist",
    roleTitle: "Adaptable Task Collaborator",
    category: "assistant",
    description:
      "Handles documentation, structured writing, summarization, and cross-functional coordination tasks.",
    avatarAccent: "#A78BFA",
    canSupervise: false,
    systemPrompt:
      "You are a capable generalist collaborator working within an orchestration swarm. Execute your scoped assignment clearly and return concise structured output.",
    temperature: 0.4,
    maxOutputTokens: 4096,
    recommendedBridgeCapabilities: [],
  },
];


// ==============================================================================
// Phase 6: Vector Memory & Workflow Automation Constants
// ==============================================================================

export const MEMORY_CONSTANTS = {
  DEFAULT_EMBEDDING_DIMENSIONS: 1536,
  SUPPORTED_DIMENSIONS: [768, 1536, 3072] as readonly number[],
  DEFAULT_TOP_K: 6,
  MAX_TOP_K: 25,
  MAX_CONTENT_CHARS: 24000,
  DEFAULT_MIN_SIMILARITY: 0.2,
  EMBEDDING_MODELS: {
    openai: [
      { id: "text-embedding-3-small", name: "OpenAI text-embedding-3-small", defaultDimensions: 1536, maxDimensions: 1536 },
      { id: "text-embedding-3-large", name: "OpenAI text-embedding-3-large", defaultDimensions: 1536, maxDimensions: 3072 },
    ],
    gemini: [
      { id: "gemini-embedding-001", name: "Gemini embedding-001", defaultDimensions: 768, maxDimensions: 1536 },
      { id: "text-embedding-004", name: "Gemini text-embedding-004", defaultDimensions: 768, maxDimensions: 768 },
    ],
  },
} as const;

export const MEMORY_API_ROUTES = {
  memories: "/api/v1/memories",
  memoryDetail: "/api/v1/memories/:memoryId",
  memorySearch: "/api/v1/memories/search",
  collections: "/api/v1/memories/collections",
  collectionDetail: "/api/v1/memories/collections/:collectionId",
  settings: "/api/v1/memories/settings",
  reembed: "/api/v1/memories/reembed",
  clear: "/api/v1/memories/clear",
} as const;

export const WORKFLOW_NODE_TYPES = [
  "manual_trigger",
  "schedule_trigger",
  "event_trigger",
  "run_agent",
  "run_swarm",
  "mcp_tool",
  "bridge_capability",
  "condition",
  "approval_gate",
  "transform",
  "merge",
  "store_result",
  "completion",
] as const;

export const WORKFLOW_EVENT_TYPES = [
  "chat.completed",
  "swarm.completed",
  "swarm.failed",
  "bridge.task.completed",
  "bridge.task.failed",
  "mcp.tool.completed",
  "memory.created",
  "workflow.completed",
  "workflow.failed",
] as const;

export const WORKFLOW_CONSTANTS = {
  MAX_WORKFLOWS_PER_WORKSPACE: 100,
  MAX_NODES_PER_WORKFLOW: 40,
  MAX_EDGES_PER_WORKFLOW: 80,
  MAX_CONCURRENT_NODES: 4,
  MAX_NODE_RETRIES: 3,
  MAX_RECURSION_DEPTH: 3,
  DEFAULT_APPROVAL_TTL_MS: 3600_000, // 1 hour for automated workflows
} as const;

export const WORKFLOW_API_ROUTES = {
  workflows: "/api/v1/workflows",
  workflowDetail: "/api/v1/workflows/:workflowId",
  workflowValidate: "/api/v1/workflows/validate",
  workflowPublish: "/api/v1/workflows/:workflowId/publish",
  workflowRun: "/api/v1/workflows/:workflowId/run",
  workflowScheduleToggle: "/api/v1/workflows/:workflowId/schedule/toggle",
  workflowTemplatesSeed: "/api/v1/workflows/templates/seed",
  workflowRuns: "/api/v1/workflows/runs",
  workflowRunDetail: "/api/v1/workflows/runs/:runId",
  workflowRunCancel: "/api/v1/workflows/runs/:runId/cancel",
  workflowApprove: "/api/v1/workflows/approvals/:approvalId/approve",
  workflowReject: "/api/v1/workflows/approvals/:approvalId/reject",
} as const;

export interface WorkflowStarterTemplate {
  slug: string;
  name: string;
  category: string;
  description: string;
  graph: {
    nodes: Array<{
      id: string;
      type: (typeof WORKFLOW_NODE_TYPES)[number];
      title: string;
      position: { x: number; y: number };
      config: Record<string, unknown>;
    }>;
    edges: Array<{
      id: string;
      source: string;
      target: string;
      sourceHandle?: string;
      label?: string;
    }>;
  };
}

export const STARTER_WORKFLOW_TEMPLATES: WorkflowStarterTemplate[] = [
  {
    slug: "daily-ai-research-summary",
    name: "Daily AI Research Summary",
    category: "research",
    description:
      "Runs on a daily schedule to synthesize workspace topics with a Research Specialist agent, format a brief digest, and persist key takeaways to Workspace Memory.",
    graph: {
      nodes: [
        {
          id: "trigger_schedule",
          type: "schedule_trigger",
          title: "Daily 09:00 UTC Schedule",
          position: { x: 80, y: 180 },
          config: {
            cronExpression: "0 9 * * *",
            timezone: "UTC",
            misfirePolicy: "FIRE_ONCE",
            concurrencyPolicy: "SKIP_IF_RUNNING",
            staticInput: { focusTopic: "AI agent systems & engineering updates" },
          },
        },
        {
          id: "agent_research",
          type: "run_agent",
          title: "Research Brief Generator",
          position: { x: 370, y: 180 },
          config: {
            agentRoleHint: "research",
            promptTemplate:
              "Produce a concise daily executive research briefing focused on: {{trigger.payload.focusTopic}}. Highlight concrete architectural takeaways and open questions.",
            useMemoryRetrieval: true,
            memoryScopes: ["WORKSPACE"],
            timeoutMs: 120000,
          },
        },
        {
          id: "transform_digest",
          type: "transform",
          title: "Format Knowledge Record",
          position: { x: 670, y: 180 },
          config: {
            mode: "template",
            template: "Daily Research Digest ({{trigger.triggeredAt}}):\n\n{{steps.agent_research.output.summary}}",
          },
        },
        {
          id: "store_memory",
          type: "store_result",
          title: "Save to Workspace Memory",
          position: { x: 970, y: 180 },
          config: {
            saveToMemory: true,
            memoryScope: "WORKSPACE",
            memoryTitleTemplate: "Daily Research Summary",
            memoryTags: ["research", "daily-brief"],
            importance: 0.7,
            outputTemplate: "{{steps.transform_digest.output.result}}",
          },
        },
        {
          id: "complete_daily",
          type: "completion",
          title: "Complete Digest",
          position: { x: 1260, y: 180 },
          config: {
            summaryTemplate: "Daily AI Research Summary generated and saved to memory.",
          },
        },
      ],
      edges: [
        { id: "e1", source: "trigger_schedule", target: "agent_research" },
        { id: "e2", source: "agent_research", target: "transform_digest" },
        { id: "e3", source: "transform_digest", target: "store_memory" },
        { id: "e4", source: "store_memory", target: "complete_daily" },
      ],
    },
  },
  {
    slug: "scheduled-project-status-report",
    name: "Scheduled Project Status Report",
    category: "reporting",
    description:
      "Runs two analytical branches concurrently, merges their findings, pauses at a human approval gate before publishing, and stores an executive workspace decision.",
    graph: {
      nodes: [
        {
          id: "trigger_manual",
          type: "manual_trigger",
          title: "Run Status Check",
          position: { x: 70, y: 200 },
          config: {
            defaultPayload: { projectScope: "Core Platform Milestone" },
          },
        },
        {
          id: "agent_analyst",
          type: "run_agent",
          title: "Telemetry & Delivery Analyst",
          position: { x: 350, y: 90 },
          config: {
            agentRoleHint: "analyst",
            promptTemplate:
              "Analyze current workspace status and recent decisions for: {{trigger.payload.projectScope}}. List milestones, blockers, and risk indicators.",
            useMemoryRetrieval: true,
            memoryScopes: ["WORKSPACE", "PERSONAL"],
          },
        },
        {
          id: "agent_reviewer",
          type: "run_agent",
          title: "Risk & Readiness Reviewer",
          position: { x: 350, y: 310 },
          config: {
            agentRoleHint: "reviewer",
            promptTemplate:
              "Review release readiness, security checks, and testing coverage risks for: {{trigger.payload.projectScope}}.",
            useMemoryRetrieval: true,
            memoryScopes: ["WORKSPACE"],
          },
        },
        {
          id: "merge_reports",
          type: "merge",
          title: "Consolidate Status Branches",
          position: { x: 660, y: 200 },
          config: {
            joinMode: "ALL",
          },
        },
        {
          id: "approve_publish",
          type: "approval_gate",
          title: "Approve Executive Summary",
          position: { x: 940, y: 200 },
          config: {
            title: "Approve Status Report Publication",
            summaryTemplate: "Confirm executive status report before archiving to Workspace Memory.",
          },
        },
        {
          id: "store_status",
          type: "store_result",
          title: "Store Report Summary",
          position: { x: 1220, y: 200 },
          config: {
            saveToMemory: true,
            memoryScope: "WORKSPACE",
            memoryTitleTemplate: "Project Status Report",
            memoryTags: ["status-report", "milestone"],
            importance: 0.75,
            outputTemplate:
              "Analyst: {{steps.agent_analyst.output.summary}}\n\nReviewer: {{steps.agent_reviewer.output.summary}}",
          },
        },
        {
          id: "complete_status",
          type: "completion",
          title: "Complete Report",
          position: { x: 1500, y: 200 },
          config: {
            summaryTemplate: "Project status report approved and stored.",
          },
        },
      ],
      edges: [
        { id: "e1", source: "trigger_manual", target: "agent_analyst" },
        { id: "e2", source: "trigger_manual", target: "agent_reviewer" },
        { id: "e3", source: "agent_analyst", target: "merge_reports" },
        { id: "e4", source: "agent_reviewer", target: "merge_reports" },
        { id: "e5", source: "merge_reports", target: "approve_publish" },
        { id: "e6", source: "approve_publish", target: "store_status" },
        { id: "e7", source: "store_status", target: "complete_status" },
      ],
    },
  },
  {
    slug: "code-review-workflow",
    name: "Code Review Workflow",
    category: "engineering",
    description:
      "Evaluates change descriptions with a Security & Code Reviewer agent, checks conditional risk thresholds, and routes high-risk changes through an explicit approval gate.",
    graph: {
      nodes: [
        {
          id: "trigger_event",
          type: "event_trigger",
          title: "On Swarm / Build Event",
          position: { x: 80, y: 200 },
          config: {
            eventType: "swarm.completed",
            cooldownSeconds: 10,
            filterRules: {},
          },
        },
        {
          id: "agent_review",
          type: "run_agent",
          title: "Security & Quality Audit",
          position: { x: 370, y: 200 },
          config: {
            agentRoleHint: "reviewer",
            promptTemplate:
              "Review this engineering output and identify correctness or security concerns. Include severity (low/medium/high) in your assessment.\nContext: {{trigger.payload.summary}}",
            useMemoryRetrieval: true,
            memoryScopes: ["WORKSPACE"],
          },
        },
        {
          id: "cond_risk",
          type: "condition",
          title: "High Risk Detected?",
          position: { x: 670, y: 200 },
          config: {
            expression: "steps.agent_review.output.summary contains \"high\"",
            trueTargetNodeId: "gate_escalate",
            falseTargetNodeId: "store_clean_review",
          },
        },
        {
          id: "gate_escalate",
          type: "approval_gate",
          title: "Security Sign-Off Required",
          position: { x: 960, y: 100 },
          config: {
            title: "Approve Flagged Code Review",
            summaryTemplate: "High-severity finding mentioned during automated review.",
          },
        },
        {
          id: "store_clean_review",
          type: "store_result",
          title: "Archive Review Notes",
          position: { x: 960, y: 310 },
          config: {
            saveToMemory: false,
            outputTemplate: "{{steps.agent_review.output.summary}}",
          },
        },
        {
          id: "merge_end",
          type: "merge",
          title: "Converge Outcome",
          position: { x: 1250, y: 200 },
          config: {
            joinMode: "ANY",
          },
        },
        {
          id: "complete_review",
          type: "completion",
          title: "Finish Code Review",
          position: { x: 1520, y: 200 },
          config: {
            summaryTemplate: "Code review pipeline finished.",
          },
        },
      ],
      edges: [
        { id: "e1", source: "trigger_event", target: "agent_review" },
        { id: "e2", source: "agent_review", target: "cond_risk" },
        { id: "e3", source: "cond_risk", target: "gate_escalate", sourceHandle: "true", label: "High Risk" },
        { id: "e4", source: "cond_risk", target: "store_clean_review", sourceHandle: "false", label: "Standard" },
        { id: "e5", source: "gate_escalate", target: "merge_end" },
        { id: "e6", source: "store_clean_review", target: "merge_end" },
        { id: "e7", source: "merge_end", target: "complete_review" },
      ],
    },
  },
  {
    slug: "agent-research-synthesis",
    name: "Multi-Agent Swarm Synthesis",
    category: "orchestration",
    description:
      "Delegates a complex objective to a Supervisor + Worker Swarm, stores the verified synthesis into Workspace Memory, and produces a structured artifact.",
    graph: {
      nodes: [
        {
          id: "trigger_manual",
          type: "manual_trigger",
          title: "Launch Swarm Workflow",
          position: { x: 80, y: 180 },
          config: {
            defaultPayload: { objective: "Investigate system bottlenecks and recommend optimizations" },
          },
        },
        {
          id: "swarm_node",
          type: "run_swarm",
          title: "Execute Coordinated Swarm",
          position: { x: 400, y: 180 },
          config: {
            objectiveTemplate: "{{trigger.payload.objective}}",
            requirePlanApproval: false,
            maxTotalTokens: 80000,
            maxCostUsd: 1.5,
            maxConcurrency: 3,
          },
        },
        {
          id: "store_synth",
          type: "store_result",
          title: "Store Swarm Synthesis",
          position: { x: 740, y: 180 },
          config: {
            saveToMemory: true,
            memoryScope: "WORKSPACE",
            memoryTitleTemplate: "Swarm Synthesis Artifact",
            memoryTags: ["swarm", "synthesis"],
            importance: 0.8,
            outputTemplate: "{{steps.swarm_node.output.summary}}",
          },
        },
        {
          id: "complete_synth",
          type: "completion",
          title: "Workflow Complete",
          position: { x: 1060, y: 180 },
          config: {
            summaryTemplate: "Multi-agent swarm execution and knowledge storage complete.",
          },
        },
      ],
      edges: [
        { id: "e1", source: "trigger_manual", target: "swarm_node" },
        { id: "e2", source: "swarm_node", target: "store_synth" },
        { id: "e3", source: "store_synth", target: "complete_synth" },
      ],
    },
  },
];
