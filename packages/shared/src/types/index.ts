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
  action: "auth" | "thread.subscribe" | "thread.unsubscribe" | "ping";
  ticket?: string;
  threadId?: string;
}

export interface WebSocketServerFrame {
  event:
    | "auth.success"
    | "auth.failed"
    | "thread.snapshot"
    | "run.started"
    | "message.delta"
    | "message.snapshot"
    | "usage.updated"
    | "run.completed"
    | "run.failed"
    | "run.cancelled"
    | "run.interrupted"
    | "pong"
    | "error";
  data?: unknown;
  error?: {
    code: string;
    message: string;
  };
  threadId?: string;
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
  allowedAgentAdapters: string[];
}


