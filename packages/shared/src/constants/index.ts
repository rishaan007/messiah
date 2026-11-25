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
