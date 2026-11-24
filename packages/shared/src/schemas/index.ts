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
  action: z.enum(["auth", "thread.subscribe", "thread.unsubscribe", "ping"]),
  ticket: z.string().trim().min(16).max(256).optional(),
  threadId: z.string().uuid().optional(),
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


