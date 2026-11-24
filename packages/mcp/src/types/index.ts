import type {
  WorkspaceRole,
  McpTransportType,
  McpConnectionStatus,
  McpAuthType,
  McpAuthStatus,
  McpPermissionMode,
  McpServerConnectionInfo,
  McpCredentialInfo,
  McpToolDefinitionInfo,
  McpToolPermissionInfo,
  CreateMcpConnectionRequest,
  UpdateMcpConnectionRequest,
  UpdateMcpToolPermissionRequest,
  McpTestConnectionResult,
} from "@messiah/shared";

export type {
  WorkspaceRole,
  McpTransportType,
  McpConnectionStatus,
  McpAuthType,
  McpAuthStatus,
  McpPermissionMode,
  McpServerConnectionInfo,
  McpCredentialInfo,
  McpToolDefinitionInfo,
  McpToolPermissionInfo,
  CreateMcpConnectionRequest,
  UpdateMcpConnectionRequest,
  UpdateMcpToolPermissionRequest,
  McpTestConnectionResult,
};

export interface DiscoveredTool {
  name: string;
  namespacedName: string;
  displayName?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  schemaHash: string;
  cacheMetadata?: Record<string, unknown>;
}

export interface McpServerCapabilities {
  tools?: {
    listChanged?: boolean;
  };
  prompts?: {
    listChanged?: boolean;
  };
  resources?: {
    subscribe?: boolean;
    listChanged?: boolean;
  };
  logging?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
}

export interface McpConnectionContext {
  connectionId: string;
  workspaceId: string;
  name: string;
  endpointUrl: string;
  transportType: McpTransportType;
  authType: McpAuthType;
  bearerToken?: string;
  oauthTokens?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: Date;
  };
}
