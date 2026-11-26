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
