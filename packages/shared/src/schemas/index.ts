import { z } from "zod";

export const HealthStatusSchema = z.enum(["healthy", "degraded", "unhealthy"]);

export const ServiceHealthSchema = z.object({
  status: HealthStatusSchema,
  latencyMs: z.number().optional(),
  message: z.string().optional(),
  timestamp: z.string().datetime(),
});

export const LivenessResponseSchema = z.object({
  status: z.literal("alive"),
  uptimeSeconds: z.number(),
  timestamp: z.string().datetime(),
  version: z.string(),
});

export const ReadinessResponseSchema = z.object({
  status: HealthStatusSchema,
  timestamp: z.string().datetime(),
  version: z.string(),
  checks: z.object({
    database: ServiceHealthSchema,
    redis: ServiceHealthSchema,
  }),
});

export const UpdateProfileSchema = z.object({
  fullName: z.string().trim().min(1, 'Display name cannot be empty').max(128, 'Display name too long').optional(),
  avatarUrl: z.string().url('Invalid avatar URL').max(1024).optional().nullable(),
});
export type UpdateProfileInput = z.infer<typeof UpdateProfileSchema>;

export const CreateWorkspaceSchema = z.object({
  name: z.string().trim().min(2, 'Workspace name must be at least 2 characters').max(64, 'Workspace name too long'),
  slug: z
    .string()
    .trim()
    .min(2, 'Slug must be at least 2 characters')
    .max(64, 'Slug too long')
    .regex(/^[a-z0-9-]+$/, 'Slug must only contain lowercase alphanumeric characters and hyphens')
    .optional(),
});
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceSchema>;

export const ServerEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default("0.0.0.0"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  MESSIAH_ALLOWED_ORIGINS: z.string().optional(),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_JWT_SECRET: z.string().optional(),
  VAULT_ENCRYPTION_KEY: z
    .string()
    .min(32, "VAULT_ENCRYPTION_KEY must be at least 32 characters/bytes for AES-256")
    .optional(),
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

export const SupportedProviderSchema = z.enum(["openai", "anthropic", "gemini"]);

export const CreateProviderConnectionSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID format"),
  provider: SupportedProviderSchema,
  displayName: z
    .string()
    .trim()
    .min(2, "Connection name must be at least 2 characters")
    .max(128, "Connection name cannot exceed 128 characters"),
  apiKey: z
    .string()
    .trim()
    .min(10, "API Key must be at least 10 characters")
    .max(512, "API Key too long"),
});
export type CreateProviderConnectionDto = z.infer<typeof CreateProviderConnectionSchema>;

export const UpdateProviderConnectionSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(2, "Connection name must be at least 2 characters")
    .max(128, "Connection name cannot exceed 128 characters")
    .optional(),
  apiKey: z
    .string()
    .trim()
    .min(10, "API Key must be at least 10 characters")
    .max(512, "API Key too long")
    .optional(),
});
export type UpdateProviderConnectionDto = z.infer<typeof UpdateProviderConnectionSchema>;

// ==========================================
// Phase 2B: Chat & Realtime Schemas
// ==========================================

export const CreateThreadSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID format"),
  title: z
    .string()
    .trim()
    .min(1, "Thread title cannot be empty")
    .max(255, "Thread title cannot exceed 255 characters")
    .optional(),
  preferredProviderConnectionId: z.string().uuid("Invalid provider connection ID").optional().nullable(),
  preferredModelId: z.string().trim().max(128).optional().nullable(),
});
export type CreateThreadInput = z.infer<typeof CreateThreadSchema>;

export const UpdateThreadSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Thread title cannot be empty")
    .max(255, "Thread title cannot exceed 255 characters")
    .optional(),
  archived: z.boolean().optional(),
  preferredProviderConnectionId: z.string().uuid("Invalid provider connection ID").optional().nullable(),
  preferredModelId: z.string().trim().max(128).optional().nullable(),
});
export type UpdateThreadInput = z.infer<typeof UpdateThreadSchema>;

export const SendMessageSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, "Message content cannot be empty")
    .max(32768, "Message exceeds maximum allowed length of 32,768 characters"),
  providerConnectionId: z.string().uuid("Invalid provider connection ID"),
  modelId: z.string().trim().min(1, "Model ID is required").max(128, "Model ID too long"),
  idempotencyKey: z.string().trim().max(128).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(131072).optional(),
  systemPrompt: z.string().trim().max(8192).optional(),
});
export type SendMessageInput = z.infer<typeof SendMessageSchema>;

export const CancelRunSchema = z.object({
  reason: z.string().trim().max(256).optional(),
});
export type CancelRunInput = z.infer<typeof CancelRunSchema>;

export const RealtimeTicketRequestSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID format").optional(),
});
export type RealtimeTicketRequestInput = z.infer<typeof RealtimeTicketRequestSchema>;

export const WebSocketClientFrameSchema = z.object({
  action: z.enum([
    "auth",
    "thread.subscribe",
    "thread.unsubscribe",
    "swarm.subscribe",
    "swarm.unsubscribe",
    "workflow.subscribe",
    "workflow.unsubscribe",
    "ping",
  ]),
  ticket: z.string().trim().min(16).max(256).optional(),
  threadId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
});
export type WebSocketClientFrameInput = z.infer<typeof WebSocketClientFrameSchema>;

export const CursorPaginationSchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type CursorPaginationQuery = z.infer<typeof CursorPaginationSchema>;

export const OutboxStatusSchema = z.enum(["PENDING", "PROCESSING", "PROCESSED", "FAILED"]);

// =============================================================================
// MCP (Model Context Protocol) Schemas
// =============================================================================

export const McpTransportTypeSchema = z.enum(["STREAMABLE_HTTP", "SSE"]);
export const McpConnectionStatusSchema = z.enum(["CONNECTED", "DISCONNECTED", "CONNECTING", "ERROR"]);
export const McpAuthTypeSchema = z.enum(["NONE", "BEARER", "OAUTH"]);
export const McpAuthStatusSchema = z.enum(["NONE", "CONFIGURED", "AUTHENTICATED", "EXPIRED", "FAILED"]);
export const McpPermissionModeSchema = z.enum(["DISABLED", "READ_ONLY", "REQUIRE_APPROVAL", "EXPLICITLY_AUTHORIZED"]);

export const CreateMcpConnectionSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID format"),
  name: z.string().trim().min(2, "Connection name must be at least 2 characters").max(128, "Connection name too long"),
  endpointUrl: z.string().trim().url("Invalid MCP endpoint URL").max(2048, "URL too long"),
  transportType: McpTransportTypeSchema.default("STREAMABLE_HTTP"),
  authType: McpAuthTypeSchema.default("NONE"),
  bearerToken: z.string().trim().max(4096).optional(),
  oauthConfig: z
    .object({
      clientId: z.string().trim().max(256).optional(),
      clientSecret: z.string().trim().max(1024).optional(),
      authorizationUrl: z.string().trim().url().optional(),
      tokenUrl: z.string().trim().url().optional(),
      scopes: z.array(z.string().trim()).optional(),
    })
    .optional(),
});
export type CreateMcpConnectionInput = z.infer<typeof CreateMcpConnectionSchema>;

export const UpdateMcpConnectionSchema = z.object({
  name: z.string().trim().min(2, "Connection name must be at least 2 characters").max(128, "Connection name too long").optional(),
  endpointUrl: z.string().trim().url("Invalid MCP endpoint URL").max(2048, "URL too long").optional(),
  transportType: McpTransportTypeSchema.optional(),
  authType: McpAuthTypeSchema.optional(),
  bearerToken: z.string().trim().max(4096).optional(),
});
export type UpdateMcpConnectionInput = z.infer<typeof UpdateMcpConnectionSchema>;

export const UpdateMcpToolPermissionSchema = z.object({
  permissionMode: McpPermissionModeSchema,
  requiresApproval: z.boolean().optional(),
});
export type UpdateMcpToolPermissionInput = z.infer<typeof UpdateMcpToolPermissionSchema>;

// ==============================================================================
// Bridge Device & Secure Connectivity Schemas (Phase 4A)
// ==============================================================================

export const CreatePairingChallengeSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
});
export type CreatePairingChallengeInput = z.infer<typeof CreatePairingChallengeSchema>;

export const ClaimPairingChallengeSchema = z.object({
  pairingCode: z.string().trim().min(8, "Pairing code too short").max(64, "Pairing code too long"),
  displayName: z.string().trim().min(1, "Display name required").max(128, "Display name too long"),
  platform: z.string().trim().min(1).max(32),
  architecture: z.string().trim().min(1).max(32),
  bridgeVersion: z.string().trim().min(1).max(64),
  publicKey: z.string().trim().min(32, "Invalid public key").max(4096),
  publicKeyFingerprint: z.string().trim().min(16).max(128),
});
export type ClaimPairingChallengeInputSchema = z.infer<typeof ClaimPairingChallengeSchema>;

export const ApprovePairingSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
});

export const RejectPairingSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  reason: z.string().trim().max(512).optional(),
});

export const RenameDeviceSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  displayName: z.string().trim().min(1, "Display name required").max(128, "Display name too long"),
});

export const DeviceActionSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
});

// WebSocket Protocol Frames
export const ServerChallengeFrameSchema = z.object({
  type: z.literal("device.challenge"),
  challengeId: z.string().min(1),
  nonce: z.string().min(16),
  serverAudience: z.string().min(1),
  timestamp: z.number().int(),
  protocolVersion: z.string(),
  expiresAt: z.number().int(),
});

export const ServerAuthSuccessFrameSchema = z.object({
  type: z.literal("device.auth.success"),
  sessionId: z.string().uuid(),
  deviceId: z.string().uuid(),
  displayName: z.string(),
  heartbeatIntervalMs: z.number().int().positive(),
  sessionExpiresAt: z.string(),
  taskSigningKey: z.string().optional(),
  taskKeyVersion: z.number().int().positive().optional(),
  protocolVersion: z.string().optional(),
});

export const ServerAuthFailedFrameSchema = z.object({
  type: z.literal("device.auth.failed"),
  code: z.string(),
  message: z.string(),
});

export const ServerHeartbeatAckFrameSchema = z.object({
  type: z.literal("device.heartbeat.ack"),
  timestamp: z.number().int(),
  sequence: z.number().int(),
});

export const ServerSessionExpiringFrameSchema = z.object({
  type: z.literal("device.session.expiring"),
  expiresAt: z.string(),
});

export const ServerDeviceRevokedFrameSchema = z.object({
  type: z.literal("device.revoked"),
  reason: z.string(),
});

export const ServerProtocolErrorFrameSchema = z.object({
  type: z.literal("device.protocol.error"),
  code: z.string(),
  message: z.string(),
});

// Phase 4B: Signed Task Dispatch Frame Schema
export const DeviceTaskDispatchFrameSchema = z.object({
  type: z.literal("device.task.dispatch"),
  taskId: z.string().uuid(),
  requestId: z.string().min(1),
  deviceId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  capability: z.string().min(1),
  resourceScopes: z.array(z.string()),
  parameters: z.record(z.unknown()),
  argumentsHash: z.string().min(32),
  issuedAt: z.number().int(),
  expiresAt: z.number().int(),
  nonce: z.string().min(16),
  policyVersion: z.string(),
  approvalReference: z.string().optional(),
  protocolVersion: z.string().optional(),
  serverAudience: z.string().optional(),
  mcpServerName: z.string().optional(),
  mcpSchemaHash: z.string().optional(),
  executableIdentity: z.string().optional(),
  serverSignature: z.string().min(32),
});

export const DeviceTaskCancelFrameSchema = z.object({
  type: z.literal("device.task.cancel"),
  taskId: z.string().uuid(),
  reason: z.string(),
});

export const DeviceMcpSyncFrameSchema = z.object({
  type: z.literal("device.mcp.sync"),
  requestId: z.string().min(1),
});

export const ServerToDeviceFrameSchema = z.discriminatedUnion("type", [
  ServerChallengeFrameSchema,
  ServerAuthSuccessFrameSchema,
  ServerAuthFailedFrameSchema,
  ServerHeartbeatAckFrameSchema,
  ServerSessionExpiringFrameSchema,
  ServerDeviceRevokedFrameSchema,
  ServerProtocolErrorFrameSchema,
  DeviceTaskDispatchFrameSchema,
  DeviceTaskCancelFrameSchema,
  DeviceMcpSyncFrameSchema,
]);

// Bridge to Server Frames
export const BridgeAuthProofFrameSchema = z.object({
  type: z.literal("device.auth.proof"),
  deviceId: z.string().uuid(),
  challengeId: z.string().min(1),
  signature: z.string().min(32),
  timestamp: z.number().int(),
  metadata: z.object({
    platform: z.string().max(32),
    architecture: z.string().max(32),
    bridgeVersion: z.string().max(64),
  }),
});

export const BridgeHeartbeatFrameSchema = z.object({
  type: z.literal("device.heartbeat"),
  timestamp: z.number().int(),
  sequence: z.number().int(),
});

export const BridgeStatusFrameSchema = z.object({
  type: z.literal("device.status"),
  status: z.enum(["online", "idle", "busy"]),
  uptimeSeconds: z.number().min(0),
  memoryUsageMb: z.number().min(0),
});

export const BridgeDiagnosticsFrameSchema = z.object({
  type: z.literal("device.diagnostics"),
  nodeVersion: z.string(),
  osRelease: z.string(),
  connectionLatencyMs: z.number().optional(),
});

export const BridgeDisconnectFrameSchema = z.object({
  type: z.literal("device.disconnect"),
  reason: z.string().optional(),
});

// Phase 4B: Bridge Execution Frames
export const BridgeTaskAcceptedFrameSchema = z.object({
  type: z.literal("device.task.accepted"),
  taskId: z.string().uuid(),
  timestamp: z.number().int(),
});

export const BridgeTaskStartedFrameSchema = z.object({
  type: z.literal("device.task.started"),
  taskId: z.string().uuid(),
  sandboxProfile: z.string(),
  timestamp: z.number().int(),
});

export const BridgeTaskProgressFrameSchema = z.object({
  type: z.literal("device.task.progress"),
  taskId: z.string().uuid(),
  progressPercent: z.number().min(0).max(100).optional(),
  message: z.string(),
  timestamp: z.number().int(),
});

export const BridgeTaskLogFrameSchema = z.object({
  type: z.literal("device.task.log"),
  taskId: z.string().uuid(),
  sequence: z.number().int(),
  stream: z.enum(["stdout", "stderr", "system"]),
  chunk: z.string(),
  timestamp: z.number().int(),
});

export const BridgeTaskApprovalRequiredFrameSchema = z.object({
  type: z.literal("device.approval.required"),
  taskId: z.string().uuid(),
  operation: z.string(),
  summary: z.string(),
  details: z.record(z.unknown()),
  argumentsHash: z.string().min(32),
  nonce: z.string().min(16),
  expiresAt: z.number().int(),
});

export const BridgeTaskCompletedFrameSchema = z.object({
  type: z.literal("device.task.completed"),
  taskId: z.string().uuid(),
  result: z.record(z.unknown()),
  exitCode: z.number().int().optional(),
  durationMs: z.number().int().nonnegative(),
  timestamp: z.number().int(),
});

export const BridgeTaskFailedFrameSchema = z.object({
  type: z.literal("device.task.failed"),
  taskId: z.string().uuid(),
  code: z.string(),
  message: z.string(),
  exitCode: z.number().int().optional(),
  durationMs: z.number().int().nonnegative(),
  timestamp: z.number().int(),
});

export const BridgeTaskUnknownOutcomeFrameSchema = z.object({
  type: z.literal("device.task.unknown_outcome"),
  taskId: z.string().uuid(),
  reason: z.string(),
  timestamp: z.number().int(),
});

export const BridgeTaskCancelledFrameSchema = z.object({
  type: z.literal("device.task.cancelled"),
  taskId: z.string().uuid(),
  reason: z.string(),
  timestamp: z.number().int(),
});

export const BridgeMcpDiscoveredFrameSchema = z.object({
  type: z.literal("device.mcp.discovered"),
  servers: z.array(
    z.object({
      name: z.string(),
      command: z.string(),
      args: z.array(z.string()),
      status: z.enum(["ACTIVE", "DISABLED", "CRASHED"]),
      schemaHash: z.string().optional(),
      tools: z.array(
        z.object({
          name: z.string(),
          description: z.string().optional(),
          inputSchema: z.record(z.unknown()),
        })
      ),
    })
  ),
  timestamp: z.number().int(),
});

export const BridgeCapabilitiesReportedFrameSchema = z.object({
  type: z.literal("device.capabilities.reported"),
  capabilities: z.array(z.string()),
  allowedRoots: z.array(z.string()),
  sandboxStatus: z.object({
    available: z.boolean(),
    provider: z.string(),
    details: z.string().optional(),
  }),
  timestamp: z.number().int(),
});

export const DeviceToServerFrameSchema = z.discriminatedUnion("type", [
  BridgeAuthProofFrameSchema,
  BridgeHeartbeatFrameSchema,
  BridgeStatusFrameSchema,
  BridgeDiagnosticsFrameSchema,
  BridgeDisconnectFrameSchema,
  BridgeTaskAcceptedFrameSchema,
  BridgeTaskStartedFrameSchema,
  BridgeTaskProgressFrameSchema,
  BridgeTaskLogFrameSchema,
  BridgeTaskApprovalRequiredFrameSchema,
  BridgeTaskCompletedFrameSchema,
  BridgeTaskFailedFrameSchema,
  BridgeTaskUnknownOutcomeFrameSchema,
  BridgeTaskCancelledFrameSchema,
  BridgeMcpDiscoveredFrameSchema,
  BridgeCapabilitiesReportedFrameSchema,
]);

// Phase 4B API DTO Schemas
export const CreateBridgeTaskSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  deviceId: z.string().uuid("Invalid device ID"),
  capability: z.string().min(1, "Capability required"),
  resourceScopes: z.array(z.string()).default([]),
  parameters: z.record(z.unknown()).default({}),
  threadId: z.string().uuid().optional(),
  generationRunId: z.string().uuid().optional(),
});

export const BridgeTaskDecisionSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  action: z.enum(["approve", "reject"]),
  rejectionReason: z.string().optional(),
});

export const ConfigureDevicePolicySchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  allowedRoots: z.array(z.string()).optional(),
  capabilities: z.array(z.string()).optional(),
  devicePolicy: z
    .object({
      readOnlyRoots: z.array(z.string()).default([]),
      writableRoots: z.array(z.string()).default([]),
      allowedMcpServers: z.array(z.string()).default([]),
      terminalExecutionEnabled: z.boolean().default(false),
      maxExecutionTimeoutMs: z.number().int().positive().default(120000),
      maxMemoryBytes: z.number().int().positive().default(1073741824),
      maxCpuPercent: z.number().min(1).max(100).default(80),
      maxProcesses: z.number().int().positive().default(5),
      networkAllowed: z.boolean().default(false),
      networkAllowedHosts: z.array(z.string().min(1).max(255)).default([]),
      networkAllowedPorts: z.array(z.number().int().min(1).max(65535)).default([]),
      allowedAgentAdapters: z.array(z.string()).default([]),
    })
    .optional(),
});

export const RegisterLocalMcpServerSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  serverName: z.string().min(1).max(128),
  command: z.string().min(1).max(255),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  pinnedExecutablePath: z.string().optional(),
  pinnedExecutableSha256: z.string().optional(),
  packageName: z.string().optional(),
  packageVersion: z.string().optional(),
  userConfirmed: z.boolean().default(true),
});

// ==============================================================================
// Phase 5: Multi-Agent Orchestration & Swarm Schemas
// ==============================================================================

export const AgentStatusSchema = z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]);

export const AgentExecutionBudgetSchema = z.object({
  maxIterations: z.number().int().min(1).max(12).optional(),
  maxTokens: z.number().int().min(512).max(200000).optional(),
  maxCostUsd: z.number().min(0.01).max(50).optional(),
  timeoutMs: z.number().int().min(5000).max(600000).optional(),
});

export const CreateAgentSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  name: z.string().trim().min(2).max(128),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(128)
    .regex(/^[a-z0-9-]+$/, "Slug must contain lowercase letters, numbers, and hyphens")
    .optional(),
  roleTitle: z.string().trim().min(2).max(128),
  category: z.string().trim().min(2).max(64).default("custom"),
  description: z.string().trim().max(1000).optional().nullable(),
  avatarAccent: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional()
    .nullable(),
  canSupervise: z.boolean().default(false),
  status: AgentStatusSchema.default("ACTIVE"),
  providerConnectionId: z.string().uuid().optional().nullable(),
  modelId: z.string().trim().min(1).max(128).optional().nullable(),
  systemPrompt: z.string().trim().min(5).max(32000),
  temperature: z.number().min(0).max(2).default(0.3),
  maxOutputTokens: z.number().int().min(64).max(32768).default(4096),
  allowedMcpToolIds: z.array(z.string().uuid()).default([]),
  allowedBridgeCapabilities: z.array(z.string().min(1).max(64)).default([]),
  preferredBridgeDeviceId: z.string().uuid().optional().nullable(),
  defaultExecutionBudget: AgentExecutionBudgetSchema.default({}),
});
export type CreateAgentDto = z.infer<typeof CreateAgentSchema>;

export const UpdateAgentSchema = CreateAgentSchema.omit({ workspaceId: true }).partial();
export type UpdateAgentDto = z.infer<typeof UpdateAgentSchema>;

export const TestAgentSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  prompt: z.string().trim().min(1).max(8000),
});
export type TestAgentDto = z.infer<typeof TestAgentSchema>;

export const SwarmPlanTaskSpecSchema = z.object({
  taskKey: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/, "taskKey must be alphanumeric with _ or -"),
  title: z.string().trim().min(2).max(160),
  instructions: z.string().trim().min(3).max(8000),
  assignedAgentId: z.string().uuid(),
  dependsOnKeys: z.array(z.string()).default([]),
  inputTaskKeys: z.array(z.string()).default([]),
  priority: z.number().int().min(0).max(100).optional(),
  maxIterations: z.number().int().min(1).max(8).optional(),
  targetBridgeDeviceId: z.string().uuid().optional().nullable(),
});

export const SwarmPlanPayloadSchema = z.object({
  goalSummary: z.string().trim().min(3).max(2000),
  tasks: z.array(SwarmPlanTaskSpecSchema).min(1).max(24),
});

export const StartSwarmRunSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  supervisorAgentId: z.string().uuid("Invalid supervisor agent ID"),
  workerAgentIds: z.array(z.string().uuid()).min(1, "Select at least one worker agent").max(8),
  objective: z.string().trim().min(3).max(16000),
  threadId: z.string().uuid().optional().nullable(),
  requirePlanApproval: z.boolean().default(false),
  maxTotalTokens: z.number().int().min(2000).max(500000).default(120000),
  maxCostUsd: z.number().min(0.05).max(100).default(2.0),
  maxDurationMs: z.number().int().min(10000).max(900000).default(300000),
  maxConcurrency: z.number().int().min(1).max(5).default(3),
  maxDelegationDepth: z.number().int().min(1).max(4).default(2),
  maxReplanRounds: z.number().int().min(0).max(3).default(1),
  targetBridgeDeviceId: z.string().uuid().optional().nullable(),
});
export type StartSwarmRunDto = z.infer<typeof StartSwarmRunSchema>;

export const ApproveSwarmPlanSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  action: z.enum(["approve", "reject"]).default("approve"),
  rejectionReason: z.string().trim().max(500).optional(),
});




// ==============================================================================
// Phase 6: Vector Memory & Workflow Automation Schemas
// ==============================================================================

export const MemoryScopeSchema = z.enum(["PERSONAL", "WORKSPACE", "AGENT"]);
export const MemorySourceTypeSchema = z.enum([
  "MANUAL",
  "CONVERSATION_SUMMARY",
  "PREFERENCE",
  "WORKSPACE_DECISION",
  "AGENT_FINDING",
  "WORKFLOW_OUTPUT",
  "ARTIFACT",
]);
export const MemorySensitivitySchema = z.enum([
  "PUBLIC_WORKSPACE",
  "PERSONAL_PRIVATE",
  "AGENT_RESTRICTED",
  "SENSITIVE_REDACTED",
]);

export const CreateMemoryCollectionSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  scope: MemoryScopeSchema.default("WORKSPACE"),
  agentId: z.string().uuid().optional().nullable(),
  name: z.string().trim().min(2).max(128),
  description: z.string().trim().max(1000).optional().nullable(),
});
export type CreateMemoryCollectionDto = z.infer<typeof CreateMemoryCollectionSchema>;

export const CreateMemorySchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  scope: MemoryScopeSchema,
  agentId: z.string().uuid().optional().nullable(),
  collectionId: z.string().uuid().optional().nullable(),
  sourceType: MemorySourceTypeSchema.default("MANUAL"),
  sourceThreadId: z.string().uuid().optional().nullable(),
  sourceMessageId: z.string().uuid().optional().nullable(),
  sourceAgentRunId: z.string().uuid().optional().nullable(),
  sourceWorkflowRunId: z.string().uuid().optional().nullable(),
  title: z.string().trim().min(2).max(200),
  content: z.string().trim().min(3).max(24000),
  summary: z.string().trim().max(2000).optional().nullable(),
  tags: z.array(z.string().trim().min(1).max(48)).max(20).default([]),
  metadata: z.record(z.unknown()).default({}),
  importance: z.number().min(0).max(1).default(0.6),
  isPinned: z.boolean().default(false),
  expiresAt: z.string().datetime().optional().nullable(),
  embedImmediately: z.boolean().default(true),
});
export type CreateMemoryDto = z.infer<typeof CreateMemorySchema>;

export const UpdateMemorySchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  title: z.string().trim().min(2).max(200).optional(),
  content: z.string().trim().min(3).max(24000).optional(),
  summary: z.string().trim().max(2000).optional().nullable(),
  collectionId: z.string().uuid().optional().nullable(),
  tags: z.array(z.string().trim().min(1).max(48)).max(20).optional(),
  importance: z.number().min(0).max(1).optional(),
  isPinned: z.boolean().optional(),
  isArchived: z.boolean().optional(),
  changeReason: z.string().trim().max(255).optional(),
  expiresAt: z.string().datetime().optional().nullable(),
});
export type UpdateMemoryDto = z.infer<typeof UpdateMemorySchema>;

export const SearchMemorySchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  query: z.string().trim().min(1).max(4000),
  scopes: z.array(MemoryScopeSchema).min(1).max(3).default(["PERSONAL", "WORKSPACE"]),
  agentIds: z.array(z.string().uuid()).max(16).optional(),
  collectionId: z.string().uuid().optional().nullable(),
  topK: z.number().int().min(1).max(25).default(6),
  minSimilarity: z.number().min(0).max(1).default(0.15),
  includeArchived: z.boolean().default(false),
});
export type SearchMemoryDto = z.infer<typeof SearchMemorySchema>;

export const ClearMemoriesSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  scope: MemoryScopeSchema.optional(),
  collectionId: z.string().uuid().optional(),
  agentId: z.string().uuid().optional(),
});
export type ClearMemoriesDto = z.infer<typeof ClearMemoriesSchema>;

export const UpdateMemorySettingsSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  embeddingProvider: SupportedProviderSchema.optional().nullable(),
  embeddingModel: z.string().trim().min(1).max(128).optional().nullable(),
  embeddingDimensions: z.number().int().min(128).max(3072).optional(),
  providerConnectionId: z.string().uuid().optional().nullable(),
  enableAutoCapture: z.boolean().optional(),
  enableChatInjection: z.boolean().optional(),
  enableSwarmInjection: z.boolean().optional(),
  defaultTopK: z.number().int().min(1).max(25).optional(),
  minSimilarityScore: z.number().min(0).max(1).optional(),
  retentionDays: z.number().int().min(1).max(3650).optional().nullable(),
});
export type UpdateMemorySettingsDto = z.infer<typeof UpdateMemorySettingsSchema>;

export const ReembedMemoriesSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  forceAll: z.boolean().default(true),
});
export type ReembedMemoriesDto = z.infer<typeof ReembedMemoriesSchema>;

export const WorkflowNodeTypeSchema = z.enum([
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
]);

export const WorkflowNodeSpecSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/, "Node ID must be alphanumeric with _ or -"),
  type: WorkflowNodeTypeSchema,
  title: z.string().trim().min(1).max(160),
  position: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
  }),
  config: z.record(z.unknown()).default({}),
  retryPolicy: z
    .object({
      maxAttempts: z.number().int().min(1).max(3).optional(),
      backoffMs: z.number().int().min(100).max(60000).optional(),
      sideEffectSafe: z.boolean().optional(),
    })
    .optional(),
  timeoutMs: z.number().int().min(1000).max(600000).optional(),
});

export const WorkflowEdgeSpecSchema = z.object({
  id: z.string().trim().min(1).max(128),
  source: z.string().trim().min(1).max(64),
  target: z.string().trim().min(1).max(64),
  sourceHandle: z.string().trim().max(64).optional(),
  targetHandle: z.string().trim().max(64).optional(),
  label: z.string().trim().max(64).optional(),
});

export const WorkflowGraphSchema = z.object({
  nodes: z.array(WorkflowNodeSpecSchema).min(1).max(40),
  edges: z.array(WorkflowEdgeSpecSchema).max(80),
});
export type WorkflowGraphDto = z.infer<typeof WorkflowGraphSchema>;

export const CreateWorkflowSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  name: z.string().trim().min(2).max(128),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(128)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  description: z.string().trim().max(2000).optional().nullable(),
  category: z.string().trim().min(2).max(64).default("automation"),
  draftGraph: WorkflowGraphSchema,
  defaultInputSchema: z.record(z.unknown()).optional().nullable(),
});
export type CreateWorkflowDto = z.infer<typeof CreateWorkflowSchema>;

export const UpdateWorkflowSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  name: z.string().trim().min(2).max(128).optional(),
  description: z.string().trim().max(2000).optional().nullable(),
  category: z.string().trim().min(2).max(64).optional(),
  status: z.enum(["DRAFT", "ACTIVE", "PAUSED", "ARCHIVED"]).optional(),
  draftGraph: WorkflowGraphSchema.optional(),
  defaultInputSchema: z.record(z.unknown()).optional().nullable(),
});
export type UpdateWorkflowDto = z.infer<typeof UpdateWorkflowSchema>;

export const PublishWorkflowSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  activate: z.boolean().default(true),
});
export type PublishWorkflowDto = z.infer<typeof PublishWorkflowSchema>;

export const ValidateWorkflowGraphSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  graph: WorkflowGraphSchema,
});
export type ValidateWorkflowGraphDto = z.infer<typeof ValidateWorkflowGraphSchema>;

export const TriggerWorkflowRunSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  triggerPayload: z.record(z.unknown()).default({}),
  versionNumber: z.number().int().positive().optional(),
  correlationId: z.string().trim().max(128).optional(),
});
export type TriggerWorkflowRunDto = z.infer<typeof TriggerWorkflowRunSchema>;

export const ToggleWorkflowScheduleSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  enabled: z.boolean(),
});
export type ToggleWorkflowScheduleDto = z.infer<typeof ToggleWorkflowScheduleSchema>;

export const WorkflowApprovalDecisionSchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  reason: z.string().trim().max(500).optional(),
});
export type WorkflowApprovalDecisionDto = z.infer<typeof WorkflowApprovalDecisionSchema>;
