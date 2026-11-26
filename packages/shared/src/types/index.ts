/**
 * MESSIAH Shared Types & API Contracts
 */

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface ServiceHealth {
  status: HealthStatus;
  latencyMs?: number;
  message?: string;
  timestamp: string;
}

export interface LivenessResponse {
  status: "alive";
  uptimeSeconds: number;
  timestamp: string;
  version: string;
}

export interface ReadinessResponse {
  status: HealthStatus;
  timestamp: string;
  version: string;
  checks: {
    database: ServiceHealth;
    redis: ServiceHealth;
  };
}

export interface SystemInfo {
  name: string;
  tagline: string;
  version: string;
  environment: "development" | "production" | "test";
}

export type WorkspaceRole = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

export type DeviceType =
  "MACOS" | "WINDOWS" | "LINUX" | "IOS" | "ANDROID" | "WEB";

export type DeviceStatus = "ONLINE" | "OFFLINE" | "PAIRED" | "REVOKED";

export type AgentMode = "SINGLE" | "ORCHESTRATOR" | "WORKER";

export type CapabilityLevel = "LEVEL_0" | "LEVEL_1" | "LEVEL_2" | "LEVEL_3";

export interface WorkspaceMembershipInfo {
  id: string;
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  role: WorkspaceRole;
  joinedAt: string;
}

export interface UserProfile {
  id: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  externalProvider: string;
  externalId: string;
  createdAt: string;
  updatedAt: string;
  memberships: WorkspaceMembershipInfo[];
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  slug: string;
  role: WorkspaceRole;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  memberCount?: number;
}

export interface AuthUserContext {
  id: string;
  externalId: string;
  externalProvider: string;
  email: string;
  fullName: string | null;
}

export type SupportedProviderId = "openai" | "anthropic" | "gemini";

export type ProviderConnectionStatus = "ACTIVE" | "INVALID" | "ERROR";

export interface ProviderCapabilityMap {
  streaming: boolean;
  toolCalling: boolean;
  vision: boolean;
  systemPrompt: boolean;
  modelListing: boolean;
  embeddings?: boolean;
}

export interface ProviderMetadataInfo {
  id: SupportedProviderId;
  name: string;
  description: string;
  websiteUrl: string;
  docsUrl: string;
  authType: "api_key";
  requiresGenerationForValidation: boolean;
  capabilities: ProviderCapabilityMap;
  supportedModelsEndpoint: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: SupportedProviderId;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities: {
    vision?: boolean;
    toolCalling?: boolean;
    reasoning?: boolean;
  };
  status?: "available" | "deprecated" | "preview";
}

export interface ProviderConnectionInfo {
  id: string;
  workspaceId: string;
  provider: SupportedProviderId;
  displayName: string;
  status: ProviderConnectionStatus;
  capabilities: Partial<ProviderCapabilityMap>;
  lastValidatedAt: string | null;
  createdAt: string;
  updatedAt: string;
  modelCount?: number;
}

export interface CreateProviderConnectionInput {
  workspaceId: string;
  provider: SupportedProviderId;
  displayName: string;
  apiKey: string;
}

export interface UpdateProviderConnectionInput {
  displayName?: string;
  apiKey?: string;
}

export interface ConnectionValidationResult {
  valid: boolean;
  message?: string;
  testedAt: string;
  modelsFound?: number;
}

// ==========================================
// Phase 2B: Chat & Realtime Streaming Engine
// ==========================================

export type MessageRole = "USER" | "ASSISTANT" | "SYSTEM" | "TOOL";

export type MessageStatus = "PENDING" | "STREAMING" | "COMPLETED" | "FAILED" | "CANCELLED" | "INTERRUPTED";

export type RunStatus = "PENDING" | "STREAMING" | "AWAITING_APPROVAL" | "COMPLETED" | "FAILED" | "CANCELLED" | "INTERRUPTED";

export type OutboxStatus = "PENDING" | "PROCESSING" | "PROCESSED" | "FAILED";

export interface ThreadInfo {
  id: string;
  workspaceId: string;
  createdByUserId: string;
  title: string;
  preferredProviderConnectionId: string | null;
  preferredModelId: string | null;
  lastMessageAt: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
}

export interface MessageInfo {
  id: string;
  threadId: string;
  sequence: number;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  providerConnectionId: string | null;
  modelId: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  run?: GenerationRunInfo | null;
}

export interface GenerationRunInfo {
  id: string;
  threadId: string;
  assistantMessageId: string;
  providerConnectionId: string;
  provider: SupportedProviderId;
  modelId: string;
  status: RunStatus;
  idempotencyKey?: string | null;
  requestFingerprint?: string | null;
  startedAt: string | null;
  completedAt?: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  providerResponseId?: string | null;
  safeErrorCode?: string | null;
  cancellationRequestedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IdempotencyKeyInfo {
  id: string;
  workspaceId: string;
  userId: string;
  threadId: string;
  key: string;
  requestFingerprint: string;
  generationRunId?: string | null;
  userMessageId?: string | null;
  assistantMessageId?: string | null;
  lockedAt: string;
  expiresAt: string;
  createdAt: string;
}

export interface OutboxEventInfo {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  retryCount: number;
  errorDetails?: string | null;
  processedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MessiahStreamEventType =
  | "run.started"
  | "message.delta"
  | "message.snapshot"
  | "usage.updated"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "run.interrupted"
  | "tool.delta"
  | "tool.proposed"
  | "tool.approval_requested"
  | "tool.approval_decided"
  | "tool.executing"
  | "tool.completed"
  | "tool.failed"
  | "tool.unknown_outcome";

export interface MessiahStreamEvent {
  type: MessiahStreamEventType;
  threadId: string;
  runId: string;
  messageId: string;
  sequence: number;
  timestamp: string;
  payload: {
    delta?: string;
    content?: string;
    status?: MessageStatus;
    usage?: {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
      totalTokens?: number;
    };
    error?: {
      code: string;
      message: string;
    };
    finishReason?: string;
    toolCall?: Partial<ToolCallInfo>;
    toolApproval?: Partial<ToolApprovalInfo>;
    argumentsDelta?: string;
  };
}

export interface RealtimeTicketInfo {
  ticket: string;
  expiresInSeconds: number;
  expiresAt: string;
}

export interface WebSocketClientFrame {
  action: "auth" | "thread.subscribe" | "thread.unsubscribe" | "swarm.subscribe" | "swarm.unsubscribe" | "ping";
  ticket?: string;
  threadId?: string;
  runId?: string;
}

export interface WebSocketServerFrame {
  event:
    | "auth.success"
    | "auth.failed"
    | "thread.snapshot"
    | "swarm.snapshot"
    | "run.started"
    | "message.delta"
    | "message.snapshot"
    | "usage.updated"
    | "run.completed"
    | "run.failed"
    | "run.cancelled"
    | "run.interrupted"
    | "swarm.run.started"
    | "swarm.run.planned"
    | "swarm.run.awaiting_plan_approval"
    | "swarm.run.awaiting_approval"
    | "swarm.run.completed"
    | "swarm.run.partial_completed"
    | "swarm.run.failed"
    | "swarm.run.cancelled"
    | "swarm.task.queued"
    | "swarm.agent.started"
    | "swarm.agent.message"
    | "swarm.agent.tool_call"
    | "swarm.agent.tool_result"
    | "swarm.agent.approval_requested"
    | "swarm.agent.completed"
    | "swarm.agent.failed"
    | "swarm.artifact.created"
    | "swarm.budget.updated"
    | "pong"
    | "error";
  data?: unknown;
  error?: {
    code: string;
    message: string;
  };
  threadId?: string;
  runId?: string;
  timestamp: string;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  meta?: {
    timestamp: string;
    requestId?: string;
  };
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  meta: {
    timestamp: string;
    requestId?: string;
  };
}

// =============================================================================
// MCP (Model Context Protocol) Types
// =============================================================================

export type McpTransportType = "STREAMABLE_HTTP" | "SSE";
export type McpConnectionStatus = "CONNECTED" | "DISCONNECTED" | "CONNECTING" | "ERROR";
export type McpAuthType = "NONE" | "BEARER" | "OAUTH";
export type McpAuthStatus = "NONE" | "CONFIGURED" | "AUTHENTICATED" | "EXPIRED" | "FAILED";
export type McpPermissionMode = "DISABLED" | "READ_ONLY" | "REQUIRE_APPROVAL" | "EXPLICITLY_AUTHORIZED";

export interface McpServerConnectionInfo {
  id: string;
  workspaceId: string;
  name: string;
  endpointUrl: string;
  transportType: McpTransportType;
  status: McpConnectionStatus;
  protocolVersion: string | null;
  serverName: string | null;
  serverVersion: string | null;
  serverCapabilities: Record<string, unknown>;
  authenticationStatus: McpAuthStatus;
  lastConnectedAt: string | null;
  lastValidatedAt: string | null;
  lastErrorCode: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  toolCount?: number;
}

export interface McpCredentialInfo {
  id: string;
  connectionId: string;
  authType: McpAuthType;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  tokenIssuer: string | null;
  grantedScopes: string[];
  encryptionKeyVersion: string;
  tokenExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface McpToolDefinitionInfo {
  id: string;
  connectionId: string;
  namespacedName: string; // serverIdentifier.toolName
  toolName: string;
  displayName: string | null;
  description: string | null;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  annotations: Record<string, unknown> | null;
  cacheMetadata: Record<string, unknown> | null;
  discoveredAt: string;
  schemaHash: string;
  isAvailable: boolean;
  permission?: McpToolPermissionInfo | null;
}

export interface McpToolPermissionInfo {
  id: string;
  workspaceId: string;
  toolDefinitionId: string;
  permissionMode: McpPermissionMode;
  requiresApproval: boolean;
  configuredByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMcpConnectionRequest {
  workspaceId: string;
  name: string;
  endpointUrl: string;
  transportType?: McpTransportType;
  authType?: McpAuthType;
  bearerToken?: string;
  oauthConfig?: {
    clientId?: string;
    clientSecret?: string;
    authorizationUrl?: string;
    tokenUrl?: string;
    scopes?: string[];
  };
}

export interface UpdateMcpConnectionRequest {
  name?: string;
  endpointUrl?: string;
  transportType?: McpTransportType;
  authType?: McpAuthType;
  bearerToken?: string;
}

export interface UpdateMcpToolPermissionRequest {
  permissionMode: McpPermissionMode;
  requiresApproval?: boolean;
}

export interface McpTestConnectionResult {
  success: boolean;
  protocolVersion?: string;
  serverName?: string;
  serverVersion?: string;
  serverCapabilities?: Record<string, unknown>;
  discoveredToolsCount?: number;
  latencyMs?: number;
  error?: string;
}

export type ToolCallStatus =
  | "PROPOSED"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "EXECUTING"
  | "SUCCEEDED"
  | "FAILED"
  | "DENIED"
  | "CANCELLED"
  | "EXPIRED"
  | "UNKNOWN_OUTCOME";

export type ToolApprovalStatus =
  | "PENDING"
  | "APPROVED"
  | "DENIED"
  | "EXPIRED";

export interface ToolCallInfo {
  id: string;
  generationRunId: string;
  threadId: string;
  workspaceId: string;
  toolDefinitionId: string;
  providerCallId: string;
  providerToolAlias: string;
  connectionId: string;
  toolName: string;
  schemaHash: string;
  argumentsHash: string;
  argumentsPreview: Record<string, unknown>;
  status: ToolCallStatus;
  result?: unknown;
  isError: boolean;
  errorMessage?: string | null;
  durationMs?: number | null;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  approval?: ToolApprovalInfo | null;
}

export interface ToolApprovalInfo {
  id: string;
  toolCallId: string;
  workspaceId: string;
  requestedByUserId?: string | null;
  decidedByUserId?: string | null;
  status: ToolApprovalStatus;
  argumentsHash: string;
  schemaHash: string;
  expiresAt: string;
  decidedAt?: string | null;
  rejectionReason?: string | null;
  createdAt: string;
  updatedAt: string;
  toolCall?: ToolCallInfo | null;
}

// ==============================================================================
// Bridge Device & Secure Connectivity Types (Phase 4A)
// ==============================================================================

export type BridgeDeviceStatus = "PENDING_APPROVAL" | "ACTIVE" | "PAUSED" | "REVOKED";
export type PairingChallengeStatus = "PENDING" | "CLAIMED" | "CONSUMED" | "EXPIRED" | "REJECTED";
export type BridgePlatform = "darwin" | "win32" | "linux" | string;
export type BridgeArchitecture = "arm64" | "x64" | string;

export interface BridgeDeviceInfo {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  displayName: string;
  platform: string;
  architecture: string;
  bridgeVersion: string;
  publicKey: string;
  publicKeyFingerprint: string;
  protocolVersion: string;
  status: BridgeDeviceStatus;
  isOnline: boolean;
  lastSeenAt: string | null;
  lastConnectedAt: string | null;
  pairedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DevicePairingChallengeInfo {
  id: string;
  workspaceId: string;
  requestedByUserId: string;
  claimedDeviceId: string | null;
  claimedDeviceName: string | null;
  claimedPlatform: string | null;
  claimedArchitecture: string | null;
  claimedBridgeVersion: string | null;
  claimedFingerprint: string | null;
  status: PairingChallengeStatus;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

export interface CreatePairingChallengeResponse {
  challengeId: string;
  pairingCode: string;
  expiresAt: string;
}

export interface ClaimPairingChallengeInput {
  pairingCode: string;
  displayName: string;
  platform: string;
  architecture: string;
  bridgeVersion: string;
  publicKey: string;
  publicKeyFingerprint: string;
}

export interface ClaimPairingChallengeResponse {
  deviceId: string;
  status: "PENDING_APPROVAL";
  message: string;
}

// WebSocket Protocol Frames (Server to Bridge)
export interface ServerChallengeFrame {
  type: "device.challenge";
  challengeId: string;
  nonce: string;
  serverAudience: string;
  timestamp: number;
  protocolVersion: string;
  expiresAt: number;
}

export interface ServerAuthSuccessFrame {
  type: "device.auth.success";
  sessionId: string;
  deviceId: string;
  displayName: string;
  heartbeatIntervalMs: number;
  sessionExpiresAt: string;
  taskSigningKey?: string;
  taskKeyVersion?: number;
  protocolVersion?: string;
}

export interface ServerAuthFailedFrame {
  type: "device.auth.failed";
  code: string;
  message: string;
}

export interface ServerHeartbeatAckFrame {
  type: "device.heartbeat.ack";
  timestamp: number;
  sequence: number;
}

export interface ServerSessionExpiringFrame {
  type: "device.session.expiring";
  expiresAt: string;
}

export interface ServerDeviceRevokedFrame {
  type: "device.revoked";
  reason: string;
}

export interface ServerProtocolErrorFrame {
  type: "device.protocol.error";
  code: string;
  message: string;
}

// Phase 4B: Signed Task Dispatch Frame
export interface DeviceTaskDispatchFrame {
  type: "device.task.dispatch";
  taskId: string;
  requestId: string;
  deviceId: string;
  workspaceId: string;
  capability: string;
  resourceScopes: string[];
  parameters: Record<string, unknown>;
  argumentsHash: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  policyVersion: string;
  approvalReference?: string;
  protocolVersion?: string;
  serverAudience?: string;
  mcpServerName?: string;
  mcpSchemaHash?: string;
  executableIdentity?: string;
  serverSignature: string;
}

export interface DeviceTaskCancelFrame {
  type: "device.task.cancel";
  taskId: string;
  reason: string;
}

export interface DeviceMcpSyncFrame {
  type: "device.mcp.sync";
  requestId: string;
}

export type ServerToDeviceFrame =
  | ServerChallengeFrame
  | ServerAuthSuccessFrame
  | ServerAuthFailedFrame
  | ServerHeartbeatAckFrame
  | ServerSessionExpiringFrame
  | ServerDeviceRevokedFrame
  | ServerProtocolErrorFrame
  | DeviceTaskDispatchFrame
  | DeviceTaskCancelFrame
  | DeviceMcpSyncFrame;

// WebSocket Protocol Frames (Bridge to Server)
export interface BridgeAuthProofFrame {
  type: "device.auth.proof";
  deviceId: string;
  challengeId: string;
  signature: string; // base64
  timestamp: number;
  metadata: {
    platform: string;
    architecture: string;
    bridgeVersion: string;
  };
}

export interface BridgeHeartbeatFrame {
  type: "device.heartbeat";
  timestamp: number;
  sequence: number;
}

export interface BridgeStatusFrame {
  type: "device.status";
  status: "online" | "idle" | "busy";
  uptimeSeconds: number;
  memoryUsageMb: number;
}

export interface BridgeDiagnosticsFrame {
  type: "device.diagnostics";
  nodeVersion: string;
  osRelease: string;
  connectionLatencyMs?: number;
}

export interface BridgeDisconnectFrame {
  type: "device.disconnect";
  reason?: string;
}

// Phase 4B: Bridge Task Execution & Capability Frames
export interface BridgeTaskAcceptedFrame {
  type: "device.task.accepted";
  taskId: string;
  timestamp: number;
}

export interface BridgeTaskStartedFrame {
  type: "device.task.started";
  taskId: string;
  sandboxProfile: string;
  timestamp: number;
}

export interface BridgeTaskProgressFrame {
  type: "device.task.progress";
  taskId: string;
  progressPercent?: number;
  message: string;
  timestamp: number;
}

export interface BridgeTaskLogFrame {
  type: "device.task.log";
  taskId: string;
  sequence: number;
  stream: "stdout" | "stderr" | "system";
  chunk: string;
  timestamp: number;
}

export interface BridgeTaskApprovalRequiredFrame {
  type: "device.approval.required";
  taskId: string;
  operation: string;
  summary: string;
  details: Record<string, unknown>;
  argumentsHash: string;
  nonce: string;
  expiresAt: number;
}

export interface BridgeTaskCompletedFrame {
  type: "device.task.completed";
  taskId: string;
  result: Record<string, unknown>;
  exitCode?: number;
  durationMs: number;
  timestamp: number;
}

export interface BridgeTaskFailedFrame {
  type: "device.task.failed";
  taskId: string;
  code: string;
  message: string;
  exitCode?: number;
  durationMs: number;
  timestamp: number;
}

export interface BridgeTaskUnknownOutcomeFrame {
  type: "device.task.unknown_outcome";
  taskId: string;
  reason: string;
  timestamp: number;
}

export interface BridgeTaskCancelledFrame {
  type: "device.task.cancelled";
  taskId: string;
  reason: string;
  timestamp: number;
}

export interface BridgeMcpDiscoveredFrame {
  type: "device.mcp.discovered";
  servers: Array<{
    name: string;
    command: string;
    args: string[];
    status: "ACTIVE" | "DISABLED" | "CRASHED";
    schemaHash?: string;
    tools: Array<{
      name: string;
      description?: string;
      inputSchema: Record<string, unknown>;
    }>;
  }>;
  timestamp: number;
}

export interface BridgeCapabilitiesReportedFrame {
  type: "device.capabilities.reported";
  capabilities: string[];
  allowedRoots: string[];
  sandboxStatus: {
    available: boolean;
    provider: string;
    details?: string;
  };
  timestamp: number;
}

export type DeviceToServerFrame =
  | BridgeAuthProofFrame
  | BridgeHeartbeatFrame
  | BridgeStatusFrame
  | BridgeDiagnosticsFrame
  | BridgeDisconnectFrame
  | BridgeTaskAcceptedFrame
  | BridgeTaskStartedFrame
  | BridgeTaskProgressFrame
  | BridgeTaskLogFrame
  | BridgeTaskApprovalRequiredFrame
  | BridgeTaskCompletedFrame
  | BridgeTaskFailedFrame
  | BridgeTaskUnknownOutcomeFrame
  | BridgeTaskCancelledFrame
  | BridgeMcpDiscoveredFrame
  | BridgeCapabilitiesReportedFrame;

// Phase 4B DTOs
export type BridgeTaskStatus =
  | "QUEUED"
  | "AWAITING_APPROVAL"
  | "DISPATCHED"
  | "ACCEPTED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCEL_REQUESTED"
  | "CANCELLED"
  | "UNKNOWN_OUTCOME"
  | "DEVICE_OFFLINE"
  | "EXPIRED";

export interface BridgeTaskInfo {
  id: string;
  workspaceId: string;
  deviceId: string;
  userId: string;
  threadId?: string | null;
  generationRunId?: string | null;
  capability: string;
  resourceScopes: string[];
  parameters: Record<string, unknown>;
  argumentsHash: string;
  status: BridgeTaskStatus;
  result?: Record<string, unknown> | null;
  errorMessage?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  issuedAt: string;
  expiresAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BridgeLocalMcpServerInfo {
  id: string;
  deviceId: string;
  workspaceId: string;
  serverName: string;
  command: string;
  args: string[];
  cwd?: string | null;
  env?: Record<string, string> | null;
  status: "ACTIVE" | "DISABLED" | "CRASHED";
  schemaHash?: string | null;
  tools?: Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }> | null;
  lastDiscoveredAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BridgeTaskApprovalInfo {
  id: string;
  taskId: string;
  workspaceId: string;
  deviceId: string;
  requestedByUserId?: string | null;
  decidedByUserId?: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";
  operation: string;
  summary: string;
  details: Record<string, unknown>;
  argumentsHash: string;
  nonce: string;
  expiresAt: string;
  decidedAt?: string | null;
  rejectionReason?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BridgeDevicePolicy {
  readOnlyRoots: string[];
  writableRoots: string[];
  allowedMcpServers: string[];
  terminalExecutionEnabled: boolean;
  maxExecutionTimeoutMs: number;
  maxMemoryBytes: number;
  maxCpuPercent: number;
  maxProcesses: number;
  networkAllowed: boolean;
  networkAllowedHosts?: string[];
  networkAllowedPorts?: number[];
  allowedAgentAdapters: string[];
}

// ==============================================================================
// Multi-Agent Orchestration & Swarm Topology Types (Phase 5)
// ==============================================================================

export type AgentStatus = "DRAFT" | "ACTIVE" | "ARCHIVED";

export type AgentRunStatus =
  | "PENDING"
  | "PLANNING"
  | "AWAITING_PLAN_APPROVAL"
  | "RUNNING"
  | "AWAITING_APPROVAL"
  | "SYNTHESIZING"
  | "COMPLETED"
  | "PARTIAL_COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type AgentTaskStatus =
  | "PENDING"
  | "QUEUED"
  | "RUNNING"
  | "AWAITING_APPROVAL"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "SKIPPED"
  | "UNKNOWN_OUTCOME";

export type AgentExecutionStatus =
  | "RUNNING"
  | "AWAITING_APPROVAL"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "UNKNOWN_OUTCOME";

export interface AgentExecutionBudget {
  maxIterations?: number;
  maxTokens?: number;
  maxCostUsd?: number;
  timeoutMs?: number;
}

export interface AgentConfigurationVersionInfo {
  id: string;
  agentDefinitionId: string;
  workspaceId: string;
  versionNumber: number;
  name: string;
  roleTitle: string;
  canSupervise: boolean;
  providerConnectionId: string | null;
  modelId: string | null;
  systemPrompt: string;
  temperature: number;
  maxOutputTokens: number;
  allowedMcpToolIds: string[];
  allowedBridgeCapabilities: string[];
  preferredBridgeDeviceId: string | null;
  executionBudget: AgentExecutionBudget;
  configHash: string;
  createdByUserId: string | null;
  createdAt: string;
}

export interface AgentDefinitionInfo {
  id: string;
  workspaceId: string;
  createdByUserId: string | null;
  name: string;
  slug: string;
  roleTitle: string;
  category: string;
  description: string | null;
  avatarAccent: string | null;
  isTemplate: boolean;
  canSupervise: boolean;
  status: AgentStatus;
  activeVersion: number;
  providerConnectionId: string | null;
  providerConnectionSummary?: {
    id: string;
    provider: SupportedProviderId;
    displayName: string;
    status: ProviderConnectionStatus;
  } | null;
  modelId: string | null;
  systemPrompt: string;
  temperature: number;
  maxOutputTokens: number;
  allowedMcpToolIds: string[];
  allowedBridgeCapabilities: string[];
  preferredBridgeDeviceId: string | null;
  defaultExecutionBudget: AgentExecutionBudget;
  createdAt: string;
  updatedAt: string;
  versions?: AgentConfigurationVersionInfo[];
}

export interface SwarmPlanTaskSpec {
  taskKey: string;
  title: string;
  instructions: string;
  assignedAgentId: string;
  dependsOnKeys: string[];
  inputTaskKeys: string[];
  priority?: number;
  maxIterations?: number;
  targetBridgeDeviceId?: string | null;
}

export interface SwarmExecutionPlan {
  goalSummary: string;
  planHash: string;
  tasks: SwarmPlanTaskSpec[];
}

export interface AgentTaskInfo {
  id: string;
  runId: string;
  workspaceId: string;
  taskKey: string;
  title: string;
  instructions: string;
  assignedAgentId: string;
  assignedVersionId: string | null;
  assignedAgent?: {
    id: string;
    name: string;
    roleTitle: string;
    category: string;
    avatarAccent: string | null;
    modelId: string | null;
  } | null;
  dependsOnKeys: string[];
  inputTaskKeys: string[];
  delegationDepth: number;
  fingerprint: string;
  status: AgentTaskStatus;
  priority: number;
  maxIterations: number;
  targetBridgeDeviceId: string | null;
  outputSummary: string | null;
  outputData: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  inputTokens: number;
  outputTokens: number;
  attemptCount: number;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentExecutionInfo {
  id: string;
  runId: string;
  taskId: string | null;
  workspaceId: string;
  agentId: string;
  versionId: string | null;
  phase: string;
  status: AgentExecutionStatus;
  providerConnectionId: string | null;
  modelId: string | null;
  iterationsUsed: number;
  toolCallIds: string[];
  bridgeTaskIds: string[];
  inputTokens: number;
  outputTokens: number;
  durationMs: number | null;
  resultSummary: string | null;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface AgentCommunicationInfo {
  id: string;
  runId: string;
  taskId: string | null;
  workspaceId: string;
  fromAgentId: string | null;
  toAgentId: string | null;
  messageType: string;
  summary: string;
  payloadDigest: string;
  createdAt: string;
}

export interface AgentArtifactInfo {
  id: string;
  runId: string;
  taskId: string | null;
  workspaceId: string;
  agentId: string | null;
  artifactType: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AgentRunEventInfo {
  id: string;
  runId: string;
  workspaceId: string;
  sequence: number;
  eventType: SwarmStreamEventType | string;
  taskId: string | null;
  agentId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AgentRunInfo {
  id: string;
  workspaceId: string;
  createdByUserId: string | null;
  threadId: string | null;
  assistantMessageId: string | null;
  supervisorAgentId: string;
  supervisorVersionId: string | null;
  supervisorAgent?: {
    id: string;
    name: string;
    roleTitle: string;
    category: string;
    avatarAccent: string | null;
    modelId: string | null;
  } | null;
  workerAgentIds: string[];
  objective: string;
  status: AgentRunStatus;
  requirePlanApproval: boolean;
  planApprovedAt: string | null;
  planJson: SwarmExecutionPlan | null;
  maxTotalTokens: number;
  maxCostUsd: number;
  maxDurationMs: number;
  maxConcurrency: number;
  maxDelegationDepth: number;
  maxReplanRounds: number;
  replanCount: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  finalSummary: string | null;
  safeErrorCode: string | null;
  errorMessage: string | null;
  cancellationRequestedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SwarmRunDetail extends AgentRunInfo {
  tasks: AgentTaskInfo[];
  executions: AgentExecutionInfo[];
  communications: AgentCommunicationInfo[];
  artifacts: AgentArtifactInfo[];
  events: AgentRunEventInfo[];
  pendingToolApprovals?: ToolApprovalInfo[];
  bridgeTasks?: BridgeTaskInfo[];
}

export type SwarmStreamEventType =
  | "swarm.run.started"
  | "swarm.run.planned"
  | "swarm.run.awaiting_plan_approval"
  | "swarm.run.awaiting_approval"
  | "swarm.run.completed"
  | "swarm.run.partial_completed"
  | "swarm.run.failed"
  | "swarm.run.cancelled"
  | "swarm.task.queued"
  | "swarm.agent.started"
  | "swarm.agent.message"
  | "swarm.agent.tool_call"
  | "swarm.agent.tool_result"
  | "swarm.agent.approval_requested"
  | "swarm.agent.completed"
  | "swarm.agent.failed"
  | "swarm.artifact.created"
  | "swarm.budget.updated";

export interface SwarmStreamEvent {
  type: SwarmStreamEventType;
  runId: string;
  workspaceId: string;
  threadId?: string | null;
  taskId?: string | null;
  agentId?: string | null;
  sequence: number;
  timestamp: string;
  payload: Record<string, unknown>;
}




// ==============================================================================
// Phase 6: Vector Memory & Workflow Automation Types
// ==============================================================================

export type MemoryScope = "PERSONAL" | "WORKSPACE" | "AGENT";
export type MemorySourceType =
  | "MANUAL"
  | "CONVERSATION_SUMMARY"
  | "PREFERENCE"
  | "WORKSPACE_DECISION"
  | "AGENT_FINDING"
  | "WORKFLOW_OUTPUT"
  | "ARTIFACT";
export type MemorySensitivity =
  | "PUBLIC_WORKSPACE"
  | "PERSONAL_PRIVATE"
  | "AGENT_RESTRICTED"
  | "SENSITIVE_REDACTED";

export interface MemorySettingsInfo {
  id: string;
  workspaceId: string;
  embeddingProvider: SupportedProviderId | string | null;
  embeddingModel: string | null;
  embeddingDimensions: number;
  providerConnectionId: string | null;
  enableAutoCapture: boolean;
  enableChatInjection: boolean;
  enableSwarmInjection: boolean;
  defaultTopK: number;
  minSimilarityScore: number;
  retentionDays: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryCollectionInfo {
  id: string;
  workspaceId: string;
  scope: MemoryScope;
  ownerUserId: string | null;
  agentId: string | null;
  name: string;
  slug: string;
  description: string | null;
  memoryCount?: number;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryVersionInfo {
  id: string;
  memoryId: string;
  versionNumber: number;
  title: string;
  content: string;
  contentHash: string;
  changeReason: string | null;
  editedByUserId: string | null;
  createdAt: string;
}

export interface MemoryInfo {
  id: string;
  workspaceId: string;
  scope: MemoryScope;
  ownerUserId: string | null;
  agentId: string | null;
  agentName?: string | null;
  collectionId: string | null;
  collectionName?: string | null;
  sourceType: MemorySourceType;
  sourceThreadId: string | null;
  sourceMessageId: string | null;
  sourceAgentRunId: string | null;
  sourceWorkflowRunId: string | null;
  title: string;
  content: string;
  summary: string | null;
  contentHash: string;
  tags: string[];
  metadata: Record<string, unknown>;
  importance: number;
  sensitivity: MemorySensitivity;
  isPinned: boolean;
  isArchived: boolean;
  currentVersion: number;
  accessCount: number;
  lastAccessedAt: string | null;
  expiresAt: string | null;
  embeddingStatus?: string | null;
  embeddingModel?: string | null;
  embeddingDimensions?: number | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  versions?: MemoryVersionInfo[];
}

export interface MemorySearchMatch {
  memory: MemoryInfo;
  score: number;
  semanticScore: number;
  lexicalScore: number;
  matchMode: "vector" | "hybrid" | "lexical_fallback";
}

export interface MemorySearchResponse {
  query: string;
  mode: "vector" | "hybrid" | "lexical_fallback";
  embeddingProvider: string | null;
  embeddingModel: string | null;
  matches: MemorySearchMatch[];
}

export type WorkflowStatus = "DRAFT" | "ACTIVE" | "PAUSED" | "ARCHIVED";
export type WorkflowTriggerType = "MANUAL" | "SCHEDULE" | "EVENT";
export type WorkflowMisfirePolicy = "SKIP" | "FIRE_ONCE" | "CATCH_UP_BOUNDED";
export type WorkflowConcurrencyPolicy = "SKIP_IF_RUNNING" | "ALLOW_CONCURRENT" | "REPLACE_QUEUED";
export type WorkflowRunStatus =
  | "PENDING"
  | "RUNNING"
  | "AWAITING_APPROVAL"
  | "COMPLETED"
  | "PARTIAL_COMPLETED"
  | "FAILED"
  | "CANCELLED";
export type WorkflowNodeStatus =
  | "PENDING"
  | "QUEUED"
  | "RUNNING"
  | "AWAITING_APPROVAL"
  | "COMPLETED"
  | "FAILED"
  | "SKIPPED"
  | "CANCELLED"
  | "UNKNOWN_OUTCOME";

export type WorkflowNodeType =
  | "manual_trigger"
  | "schedule_trigger"
  | "event_trigger"
  | "run_agent"
  | "run_swarm"
  | "mcp_tool"
  | "bridge_capability"
  | "condition"
  | "approval_gate"
  | "transform"
  | "merge"
  | "store_result"
  | "completion";

export interface WorkflowNodeSpec {
  id: string;
  type: WorkflowNodeType;
  title: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
  retryPolicy?: {
    maxAttempts?: number;
    backoffMs?: number;
    sideEffectSafe?: boolean;
  };
  timeoutMs?: number;
}

export interface WorkflowEdgeSpec {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  label?: string;
}

export interface WorkflowGraphDefinition {
  nodes: WorkflowNodeSpec[];
  edges: WorkflowEdgeSpec[];
}

export interface WorkflowValidationIssue {
  severity: "error" | "warning";
  nodeId?: string;
  edgeId?: string;
  code: string;
  message: string;
}

export interface WorkflowValidationResult {
  valid: boolean;
  issues: WorkflowValidationIssue[];
  topologicalOrder: string[];
  triggerNodeIds: string[];
}

export interface WorkflowScheduleInfo {
  id: string;
  workflowId: string;
  workspaceId: string;
  versionId: string | null;
  cronExpression: string;
  timezone: string;
  enabled: boolean;
  misfirePolicy: WorkflowMisfirePolicy;
  concurrencyPolicy: WorkflowConcurrencyPolicy;
  staticInput: Record<string, unknown>;
  lastTriggeredAt: string | null;
  nextRunAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
}

export interface WorkflowEventTriggerInfo {
  id: string;
  workflowId: string;
  workspaceId: string;
  versionId: string | null;
  eventType: string;
  filterRules: Record<string, unknown>;
  cooldownSeconds: number;
  enabled: boolean;
  lastTriggeredAt: string | null;
}

export interface WorkflowVersionInfo {
  id: string;
  workflowId: string;
  workspaceId: string;
  versionNumber: number;
  definitionJson: WorkflowGraphDefinition;
  graphHash: string;
  publishedByUserId: string | null;
  publishedAt: string;
  createdAt: string;
}

export interface WorkflowDefinitionInfo {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  description: string | null;
  category: string;
  status: WorkflowStatus;
  activeVersionNumber: number | null;
  draftGraph: WorkflowGraphDefinition;
  defaultInputSchema: Record<string, unknown> | null;
  isTemplate: boolean;
  createdByUserId: string | null;
  schedule?: WorkflowScheduleInfo | null;
  eventTriggers?: WorkflowEventTriggerInfo[];
  versions?: WorkflowVersionInfo[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowNodeExecutionInfo {
  id: string;
  runId: string;
  workflowId: string;
  workspaceId: string;
  nodeId: string;
  nodeType: WorkflowNodeType | string;
  title: string;
  status: WorkflowNodeStatus;
  attemptCount: number;
  inputData: Record<string, unknown> | null;
  outputData: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  durationMs: number | null;
  agentRunId: string | null;
  toolCallId: string | null;
  bridgeTaskId: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface WorkflowApprovalInfo {
  id: string;
  runId: string;
  nodeExecutionId: string;
  workflowId: string;
  workspaceId: string;
  nodeId: string;
  requestedByUserId: string | null;
  decidedByUserId: string | null;
  status: "PENDING" | "APPROVED" | "DENIED" | "EXPIRED";
  title: string;
  summary: string;
  contextPreview: Record<string, unknown>;
  expiresAt: string;
  decidedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
}

export interface WorkflowRunEventInfo {
  id: string;
  runId: string;
  workspaceId: string;
  sequence: number;
  eventType: string;
  nodeId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface WorkflowRunInfo {
  id: string;
  workflowId: string;
  workflowName?: string;
  versionId: string;
  workspaceId: string;
  triggeredByUserId: string | null;
  triggerType: WorkflowTriggerType;
  triggerEventId: string | null;
  correlationId: string | null;
  status: WorkflowRunStatus;
  triggerPayload: Record<string, unknown>;
  finalOutput: Record<string, unknown> | null;
  finalSummary: string | null;
  safeErrorCode: string | null;
  errorMessage: string | null;
  cancellationRequestedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRunDetail extends WorkflowRunInfo {
  version: WorkflowVersionInfo;
  nodeExecutions: WorkflowNodeExecutionInfo[];
  approvals: WorkflowApprovalInfo[];
  events: WorkflowRunEventInfo[];
  pendingToolApprovals?: ToolApprovalInfo[];
  bridgeTasks?: BridgeTaskInfo[];
}

export type WorkflowStreamEventType =
  | "workflow.run.started"
  | "workflow.run.awaiting_approval"
  | "workflow.run.completed"
  | "workflow.run.partial_completed"
  | "workflow.run.failed"
  | "workflow.run.cancelled"
  | "workflow.node.queued"
  | "workflow.node.started"
  | "workflow.node.completed"
  | "workflow.node.skipped"
  | "workflow.node.failed"
  | "workflow.node.awaiting_approval"
  | "workflow.approval.resolved";

export interface WorkflowStreamEvent {
  type: WorkflowStreamEventType;
  runId: string;
  workflowId: string;
  workspaceId: string;
  nodeId?: string | null;
  sequence: number;
  timestamp: string;
  payload: Record<string, unknown>;
}

// ==============================================================================
// Phase 7: Notifications, Unified Approvals, Audit & Platform Types
// ==============================================================================

export type NotificationCategory =
  | "TOOL_APPROVAL"
  | "BRIDGE_APPROVAL"
  | "SWARM_APPROVAL"
  | "WORKFLOW_APPROVAL"
  | "AGENT_RUN_COMPLETED"
  | "AGENT_RUN_FAILED"
  | "WORKFLOW_COMPLETED"
  | "WORKFLOW_FAILED"
  | "DEVICE_STATUS";

export type ClientPlatform =
  | "WEB_PWA"
  | "MACOS_DESKTOP"
  | "WINDOWS_DESKTOP"
  | "LINUX_DESKTOP"
  | "IOS_CAPACITOR"
  | "ANDROID_CAPACITOR";

export interface NotificationDeviceInfo {
  id: string;
  userId: string;
  workspaceId: string | null;
  platform: ClientPlatform;
  deviceLabel: string;
  pushProvider: string;
  appVersion: string | null;
  isActive: boolean;
  lastSeenAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface NotificationPreferenceInfo {
  id: string;
  userId: string;
  workspaceId: string;
  inAppEnabled: boolean;
  webPushEnabled: boolean;
  desktopEnabled: boolean;
  mobilePushEnabled: boolean;
  notifyApprovals: boolean;
  notifyCompletions: boolean;
  notifyFailures: boolean;
  notifyDeviceStatus: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  updatedAt: string;
}

export interface NotificationItemInfo {
  id: string;
  workspaceId: string;
  recipientUserId: string;
  category: NotificationCategory;
  title: string;
  preview: string;
  resourceType: string;
  resourceId: string;
  deepLink: string;
  metadata: Record<string, unknown>;
  expiresAt: string | null;
  readAt: string | null;
  createdAt: string;
}

export type UnifiedApprovalKind = "MCP_TOOL" | "BRIDGE_TASK" | "WORKFLOW_GATE" | "SWARM_PLAN";

export interface UnifiedApprovalItem {
  id: string;
  kind: UnifiedApprovalKind;
  workspaceId: string;
  title: string;
  summary: string;
  status: string;
  expiresAt: string | null;
  createdAt: string;
  deepLink: string;
  resourceId: string;
  parentRunId?: string | null;
  threadId?: string | null;
  deviceName?: string | null;
  toolName?: string | null;
  capability?: string | null;
  previewDetails: Record<string, unknown>;
}

export interface AuditLogEntryInfo {
  id: string;
  workspaceId: string;
  actorId: string | null;
  actorEmail?: string | null;
  actorName?: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  details: Record<string, unknown>;
  ipAddress: string | null;
  createdAt: string;
}

export interface PlatformCapabilityMatrixEntry {
  platform: "macos" | "windows" | "linux" | "web_pwa" | "ios" | "android";
  label: string;
  sandboxProvider: string;
  sandboxSupported: boolean;
  keystoreEngine: string;
  notes: string;
}
