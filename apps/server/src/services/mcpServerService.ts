import {
  prisma,
  Prisma,
  type McpTransportType,
  type McpConnectionStatus,
  type McpAuthStatus,
  type McpPermissionMode,
  type WorkspaceRole,
} from "@messiah/db";
import type {
  CreateMcpConnectionInput,
  UpdateMcpConnectionInput,
  UpdateMcpToolPermissionInput,
  McpServerConnectionInfo,
  McpToolDefinitionInfo,
  McpToolPermissionInfo,
  McpTestConnectionResult,
} from "@messiah/shared";
import {
  McpConnectionManager,
  McpDiscoveryService,
  McpToolRegistry,
  McpHealthService,
  McpAuthService,
  validateMcpEndpointUrl,
  McpError,
  SsrfSecurityError,
} from "@messiah/mcp";
import { VaultService, type EncryptedPayload, type VaultAadContext } from "./vaultService.js";
import { logAuditEvent } from "./auditService.js";
import { workspaceService } from "./workspaceService.js";

export class McpServerServiceError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode = 400, code = "MCP_SERVER_ERROR") {
    super(message);
    this.name = "McpServerServiceError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class McpServerService {
  private vaultService: VaultService;
  private connectionManager: McpConnectionManager;
  private discoveryService: McpDiscoveryService;
  private toolRegistry: McpToolRegistry;
  private healthService: McpHealthService;
  private authService: McpAuthService;

  constructor(
    vaultService?: VaultService,
    connectionManager?: McpConnectionManager,
    discoveryService?: McpDiscoveryService,
    toolRegistry?: McpToolRegistry,
    healthService?: McpHealthService,
    authService?: McpAuthService
  ) {
    this.vaultService = vaultService || new VaultService();
    this.connectionManager = connectionManager || new McpConnectionManager();
    this.discoveryService = discoveryService || new McpDiscoveryService();
    this.toolRegistry = toolRegistry || new McpToolRegistry();
    this.healthService =
      healthService || new McpHealthService(this.connectionManager, this.discoveryService);
    this.authService = authService || new McpAuthService();
  }

  public getAuthService(): McpAuthService {
    return this.authService;
  }

  /**
   * Helper to verify workspace membership.
   * Throws 404 to avoid leaking existence of private workspaces (anti-IDOR).
   */
  private async getAuthorizedMembership(
    userId: string,
    workspaceId: string
  ): Promise<WorkspaceRole> {
    const role = await workspaceService.getWorkspaceMembership(userId, workspaceId);
    if (!role) {
      throw new McpServerServiceError(
        "Workspace not found or access denied",
        404,
        "WORKSPACE_NOT_FOUND"
      );
    }
    return role;
  }

  /**
   * Helper to enforce administrative permissions (OWNER or ADMIN).
   */
  private requireAdminRole(role: WorkspaceRole): void {
    if (role !== "OWNER" && role !== "ADMIN") {
      throw new McpServerServiceError(
        "Insufficient workspace permissions. Only workspace owners and admins can manage MCP server connections and permissions.",
        403,
        "FORBIDDEN_ROLE"
      );
    }
  }

  /**
   * Build AES-256-GCM v2 AAD context for MCP credentials.
   */
  private buildMcpAadContext(workspaceId: string, connectionId: string): VaultAadContext {
    return {
      workspaceId,
      providerConnectionId: connectionId,
      provider: "mcp",
    };
  }

  /**
   * Decrypts stored bearer token for a connection.
   */
  private decryptBearerToken(
    workspaceId: string,
    connectionId: string,
    encryptedAccessToken: string | null
  ): string | undefined {
    if (!encryptedAccessToken) return undefined;
    try {
      const payload = JSON.parse(encryptedAccessToken) as EncryptedPayload;
      const aadContext = this.buildMcpAadContext(workspaceId, connectionId);
      return this.vaultService.decrypt(payload, aadContext);
    } catch {
      throw new McpServerServiceError(
        "Failed to authenticate or decrypt stored MCP credentials.",
        500,
        "CREDENTIAL_DECRYPTION_ERROR"
      );
    }
  }

  /**
   * Formats a database connection into a safe public DTO.
   */
  private formatConnectionInfo(
    conn: {
      id: string;
      workspaceId: string;
      name: string;
      endpointUrl: string;
      transportType: McpTransportType;
      status: McpConnectionStatus;
      protocolVersion: string | null;
      serverName: string | null;
      serverVersion: string | null;
      serverCapabilities: unknown;
      authenticationStatus: McpAuthStatus;
      lastConnectedAt: Date | null;
      lastValidatedAt: Date | null;
      lastErrorCode: string | null;
      createdByUserId: string | null;
      createdAt: Date;
      updatedAt: Date;
      _count?: { tools: number };
    },
    toolCountOverride?: number
  ): McpServerConnectionInfo {
    return {
      id: conn.id,
      workspaceId: conn.workspaceId,
      name: conn.name,
      endpointUrl: conn.endpointUrl,
      transportType: conn.transportType,
      status: conn.status,
      protocolVersion: conn.protocolVersion,
      serverName: conn.serverName,
      serverVersion: conn.serverVersion,
      serverCapabilities: (conn.serverCapabilities || {}) as Record<string, unknown>,
      authenticationStatus: conn.authenticationStatus,
      lastConnectedAt: conn.lastConnectedAt ? conn.lastConnectedAt.toISOString() : null,
      lastValidatedAt: conn.lastValidatedAt ? conn.lastValidatedAt.toISOString() : null,
      lastErrorCode: conn.lastErrorCode,
      createdByUserId: conn.createdByUserId,
      createdAt: conn.createdAt.toISOString(),
      updatedAt: conn.updatedAt.toISOString(),
      toolCount: toolCountOverride !== undefined ? toolCountOverride : conn._count?.tools ?? 0,
    };
  }

  /**
   * Formats a database tool definition into a safe public DTO.
   */
  private formatToolInfo(
    tool: {
      id: string;
      connectionId: string;
      toolName: string;
      displayName: string | null;
      description: string | null;
      inputSchema: unknown;
      outputSchema: unknown;
      annotations: unknown;
      cacheMetadata: unknown;
      discoveredAt: Date;
      schemaHash: string;
      isAvailable: boolean;
      permission?: {
        id: string;
        workspaceId: string;
        toolDefinitionId: string;
        permissionMode: McpPermissionMode;
        requiresApproval: boolean;
        configuredByUserId: string | null;
        createdAt: Date;
        updatedAt: Date;
      } | null;
    },
    serverName = "server"
  ): McpToolDefinitionInfo {
    return {
      id: tool.id,
      connectionId: tool.connectionId,
      namespacedName: McpDiscoveryService.formatNamespacedName(serverName, tool.toolName),
      toolName: tool.toolName,
      displayName: tool.displayName,
      description: tool.description,
      inputSchema: (tool.inputSchema || {}) as Record<string, unknown>,
      outputSchema: (tool.outputSchema || null) as Record<string, unknown> | null,
      annotations: (tool.annotations || null) as Record<string, unknown> | null,
      cacheMetadata: (tool.cacheMetadata || null) as Record<string, unknown> | null,
      discoveredAt: tool.discoveredAt.toISOString(),
      schemaHash: tool.schemaHash,
      isAvailable: tool.isAvailable,
      permission: tool.permission
        ? {
            id: tool.permission.id,
            workspaceId: tool.permission.workspaceId,
            toolDefinitionId: tool.permission.toolDefinitionId,
            permissionMode: tool.permission.permissionMode,
            requiresApproval: tool.permission.requiresApproval,
            configuredByUserId: tool.permission.configuredByUserId,
            createdAt: tool.permission.createdAt.toISOString(),
            updatedAt: tool.permission.updatedAt.toISOString(),
          }
        : null,
    };
  }

  // ===========================================================================
  // Connection Management
  // ===========================================================================

  /**
   * Creates a new MCP server connection.
   */
  public async createConnection(
    userId: string,
    input: CreateMcpConnectionInput,
    auditMeta?: { ipAddress?: string; userAgent?: string }
  ): Promise<McpServerConnectionInfo> {
    const role = await this.getAuthorizedMembership(userId, input.workspaceId);
    this.requireAdminRole(role);

    // 1. SSRF Validation
    try {
      await validateMcpEndpointUrl(input.endpointUrl);
    } catch (err: unknown) {
      if (err instanceof SsrfSecurityError) {
        throw new McpServerServiceError(err.message, 400, "SSRF_VALIDATION_FAILED");
      }
      throw err;
    }

    // 2. Name Uniqueness within workspace
    const existing = await prisma.mcpServerConnection.findFirst({
      where: { workspaceId: input.workspaceId, name: input.name },
    });
    if (existing) {
      throw new McpServerServiceError(
        `An MCP server connection with name '${input.name}' already exists in this workspace.`,
        409,
        "DUPLICATE_CONNECTION_NAME"
      );
    }

    const authType = input.authType || "NONE";
    const transportType = input.transportType || "STREAMABLE_HTTP";

    // 3. Persist connection and encrypted credentials atomically
    const newConnection = await prisma.$transaction(async (tx) => {
      const conn = await tx.mcpServerConnection.create({
        data: {
          workspaceId: input.workspaceId,
          name: input.name,
          endpointUrl: input.endpointUrl,
          transportType,
          status: "DISCONNECTED",
          authenticationStatus:
            authType === "BEARER" && input.bearerToken
              ? "CONFIGURED"
              : authType === "OAUTH"
              ? "CONFIGURED"
              : "NONE",
          createdByUserId: userId,
        },
      });

      if (authType === "BEARER" && input.bearerToken) {
        const aadContext = this.buildMcpAadContext(input.workspaceId, conn.id);
        const encrypted = this.vaultService.encrypt(input.bearerToken, aadContext);

        await tx.mcpCredential.create({
          data: {
            connectionId: conn.id,
            authType: "BEARER",
            encryptedAccessToken: JSON.stringify(encrypted),
            encryptionKeyVersion: encrypted.keyVersion,
          },
        });
      } else if (authType === "OAUTH" && input.oauthConfig) {
        await tx.mcpCredential.create({
          data: {
            connectionId: conn.id,
            authType: "OAUTH",
            clientInformation: input.oauthConfig as Prisma.InputJsonValue,
          },
        });
      }

      return conn;
    });

    await logAuditEvent({
      workspaceId: input.workspaceId,
      actorId: userId,
      action: "mcp_connection.created",
      resourceType: "mcp_connection",
      resourceId: newConnection.id,
      details: {
        name: input.name,
        endpointUrl: input.endpointUrl,
        transportType,
        authType,
      },
      ipAddress: auditMeta?.ipAddress,
      userAgent: auditMeta?.userAgent,
    });

    return this.formatConnectionInfo(newConnection, 0);
  }

  /**
   * Lists all MCP connections in a workspace with tool counts.
   */
  public async listConnections(
    userId: string,
    workspaceId: string
  ): Promise<McpServerConnectionInfo[]> {
    await this.getAuthorizedMembership(userId, workspaceId);

    const connections = await prisma.mcpServerConnection.findMany({
      where: { workspaceId },
      include: {
        _count: {
          select: { tools: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return connections.map((conn) => this.formatConnectionInfo(conn));
  }

  /**
   * Retrieves a single connection by ID with tools and credential status.
   */
  public async getConnection(
    userId: string,
    connectionId: string
  ): Promise<{
    connection: McpServerConnectionInfo;
    tools: McpToolDefinitionInfo[];
  }> {
    const conn = await prisma.mcpServerConnection.findUnique({
      where: { id: connectionId },
      include: {
        _count: { select: { tools: true } },
        tools: {
          include: { permission: true },
          orderBy: { toolName: "asc" },
        },
      },
    });

    if (!conn) {
      throw new McpServerServiceError(
        "MCP server connection not found",
        404,
        "CONNECTION_NOT_FOUND"
      );
    }

    await this.getAuthorizedMembership(userId, conn.workspaceId);

    const formattedTools = conn.tools.map((t) => this.formatToolInfo(t, conn.name));

    return {
      connection: this.formatConnectionInfo(conn),
      tools: formattedTools,
    };
  }

  /**
   * Updates an existing MCP server connection.
   */
  public async updateConnection(
    userId: string,
    connectionId: string,
    input: UpdateMcpConnectionInput,
    auditMeta?: { ipAddress?: string; userAgent?: string }
  ): Promise<McpServerConnectionInfo> {
    const conn = await prisma.mcpServerConnection.findUnique({
      where: { id: connectionId },
      include: { credential: true },
    });

    if (!conn) {
      throw new McpServerServiceError(
        "MCP server connection not found",
        404,
        "CONNECTION_NOT_FOUND"
      );
    }

    const role = await this.getAuthorizedMembership(userId, conn.workspaceId);
    this.requireAdminRole(role);

    // SSRF validation if endpoint is being updated
    if (input.endpointUrl && input.endpointUrl !== conn.endpointUrl) {
      try {
        await validateMcpEndpointUrl(input.endpointUrl);
      } catch (err: unknown) {
        if (err instanceof SsrfSecurityError) {
          throw new McpServerServiceError(err.message, 400, "SSRF_VALIDATION_FAILED");
        }
        throw err;
      }
    }

    // Name uniqueness check if name is being changed
    if (input.name && input.name !== conn.name) {
      const nameConflict = await prisma.mcpServerConnection.findFirst({
        where: {
          workspaceId: conn.workspaceId,
          name: input.name,
          id: { not: connectionId },
        },
      });
      if (nameConflict) {
        throw new McpServerServiceError(
          `An MCP server connection with name '${input.name}' already exists in this workspace.`,
          409,
          "DUPLICATE_CONNECTION_NAME"
        );
      }
    }

    const updatedConn = await prisma.$transaction(async (tx) => {
      const updated = await tx.mcpServerConnection.update({
        where: { id: connectionId },
        data: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.endpointUrl ? { endpointUrl: input.endpointUrl } : {}),
          ...(input.transportType ? { transportType: input.transportType } : {}),
          ...(input.authType
            ? {
                authenticationStatus:
                  input.authType === "NONE"
                    ? "NONE"
                    : input.bearerToken
                    ? "CONFIGURED"
                    : conn.authenticationStatus,
              }
            : {}),
        },
        include: { _count: { select: { tools: true } } },
      });

      if (input.bearerToken !== undefined) {
        if (input.bearerToken.trim().length > 0) {
          const aadContext = this.buildMcpAadContext(conn.workspaceId, connectionId);
          const encrypted = this.vaultService.encrypt(input.bearerToken, aadContext);

          await tx.mcpCredential.upsert({
            where: { connectionId },
            create: {
              connectionId,
              authType: "BEARER",
              encryptedAccessToken: JSON.stringify(encrypted),
              encryptionKeyVersion: encrypted.keyVersion,
            },
            update: {
              authType: "BEARER",
              encryptedAccessToken: JSON.stringify(encrypted),
              encryptionKeyVersion: encrypted.keyVersion,
            },
          });

          await tx.mcpServerConnection.update({
            where: { id: connectionId },
            data: { authenticationStatus: "CONFIGURED" },
          });
        } else if (conn.credential) {
          // Token removed
          await tx.mcpCredential.delete({
            where: { connectionId },
          });
          await tx.mcpServerConnection.update({
            where: { id: connectionId },
            data: { authenticationStatus: "NONE" },
          });
        }
      }

      return updated;
    });

    // If endpoint or transport changed, disconnect any active session
    if (
      (input.endpointUrl && input.endpointUrl !== conn.endpointUrl) ||
      (input.transportType && input.transportType !== conn.transportType)
    ) {
      await this.connectionManager.disconnect(conn.workspaceId, connectionId);
    }

    await logAuditEvent({
      workspaceId: conn.workspaceId,
      actorId: userId,
      action: "mcp_connection.updated",
      resourceType: "mcp_connection",
      resourceId: connectionId,
      details: {
        name: input.name,
        endpointUrl: input.endpointUrl,
        transportType: input.transportType,
      },
      ipAddress: auditMeta?.ipAddress,
      userAgent: auditMeta?.userAgent,
    });

    return this.formatConnectionInfo(updatedConn);
  }

  /**
   * Deletes an MCP server connection and clean up active sessions.
   */
  public async deleteConnection(
    userId: string,
    connectionId: string,
    auditMeta?: { ipAddress?: string; userAgent?: string }
  ): Promise<void> {
    const conn = await prisma.mcpServerConnection.findUnique({
      where: { id: connectionId },
    });

    if (!conn) {
      throw new McpServerServiceError(
        "MCP server connection not found",
        404,
        "CONNECTION_NOT_FOUND"
      );
    }

    const role = await this.getAuthorizedMembership(userId, conn.workspaceId);
    this.requireAdminRole(role);

    // 1. Disconnect active session
    await this.connectionManager.disconnect(conn.workspaceId, connectionId);

    // 2. Invalidate tool registry in memory
    this.toolRegistry.invalidateConnection(conn.workspaceId, connectionId);

    // 3. Delete database record (cascading deletes credentials, tools, permissions)
    await prisma.mcpServerConnection.delete({
      where: { id: connectionId },
    });

    await logAuditEvent({
      workspaceId: conn.workspaceId,
      actorId: userId,
      action: "mcp_connection.deleted",
      resourceType: "mcp_connection",
      resourceId: connectionId,
      details: { name: conn.name, endpointUrl: conn.endpointUrl },
      ipAddress: auditMeta?.ipAddress,
      userAgent: auditMeta?.userAgent,
    });
  }

  // ===========================================================================
  // Connect & Discovery
  // ===========================================================================

  /**
   * Connects to a remote MCP server, queries listTools, synchronizes definitions in DB,
   * creates default REQUIRE_APPROVAL permissions, and caches tools in memory.
   */
  public async connectAndDiscover(
    userId: string,
    connectionId: string,
    auditMeta?: { ipAddress?: string; userAgent?: string }
  ): Promise<{
    connection: McpServerConnectionInfo;
    discoveredToolsCount: number;
    tools: McpToolDefinitionInfo[];
  }> {
    const conn = await prisma.mcpServerConnection.findUnique({
      where: { id: connectionId },
      include: { credential: true },
    });

    if (!conn) {
      throw new McpServerServiceError(
        "MCP server connection not found",
        404,
        "CONNECTION_NOT_FOUND"
      );
    }

    const role = await this.getAuthorizedMembership(userId, conn.workspaceId);
    this.requireAdminRole(role);

    // Decrypt credentials if configured
    const bearerToken = this.decryptBearerToken(
      conn.workspaceId,
      conn.id,
      conn.credential?.encryptedAccessToken || null
    );

    // Update status to CONNECTING
    await prisma.mcpServerConnection.update({
      where: { id: connectionId },
      data: { status: "CONNECTING" },
    });

    try {
      // 1. Connect via McpConnectionManager
      const session = await this.connectionManager.connect({
        workspaceId: conn.workspaceId,
        connectionId: conn.id,
        name: conn.name,
        endpointUrl: conn.endpointUrl,
        transportType: conn.transportType,
        authType: conn.credential?.authType || "NONE",
        bearerToken,
      });

      // 2. Discover tools
      const { tools: discoveredTools, cacheMetadata } =
        await this.discoveryService.discoverTools(session.client, conn.name);

      const discoveredToolNames = new Set(discoveredTools.map((t) => t.name));

      // 3. Atomically synchronize discovered tools in DB
      await prisma.$transaction(async (tx) => {
        // Upsert each discovered tool
        for (const tool of discoveredTools) {
          const toolDef = await tx.mcpToolDefinition.upsert({
            where: {
              connectionId_toolName: {
                connectionId: conn.id,
                toolName: tool.name,
              },
            },
            create: {
              connectionId: conn.id,
              toolName: tool.name,
              displayName: tool.displayName || null,
              description: tool.description || null,
              inputSchema: tool.inputSchema as Prisma.InputJsonValue,
              outputSchema: tool.outputSchema ? (tool.outputSchema as Prisma.InputJsonValue) : Prisma.DbNull,
              annotations: tool.annotations ? (tool.annotations as Prisma.InputJsonValue) : Prisma.DbNull,
              cacheMetadata: (tool.cacheMetadata || cacheMetadata) ? ((tool.cacheMetadata || cacheMetadata) as Prisma.InputJsonValue) : Prisma.DbNull,
              schemaHash: tool.schemaHash,
              isAvailable: true,
            },
            update: {
              displayName: tool.displayName || null,
              description: tool.description || null,
              inputSchema: tool.inputSchema as Prisma.InputJsonValue,
              outputSchema: tool.outputSchema ? (tool.outputSchema as Prisma.InputJsonValue) : Prisma.DbNull,
              annotations: tool.annotations ? (tool.annotations as Prisma.InputJsonValue) : Prisma.DbNull,
              cacheMetadata: (tool.cacheMetadata || cacheMetadata) ? ((tool.cacheMetadata || cacheMetadata) as Prisma.InputJsonValue) : Prisma.DbNull,
              schemaHash: tool.schemaHash,
              isAvailable: true,
            },
          });

          // Ensure default permission exists (DENY-BY-DEFAULT: REQUIRE_APPROVAL)
          const existingPerm = await tx.mcpToolPermission.findUnique({
            where: { toolDefinitionId: toolDef.id },
          });

          if (!existingPerm) {
            await tx.mcpToolPermission.create({
              data: {
                workspaceId: conn.workspaceId,
                toolDefinitionId: toolDef.id,
                permissionMode: "REQUIRE_APPROVAL",
                requiresApproval: true,
                configuredByUserId: userId,
              },
            });
          }
        }

        // Mark missing tools as unavailable
        await tx.mcpToolDefinition.updateMany({
          where: {
            connectionId: conn.id,
            toolName: { notIn: Array.from(discoveredToolNames) },
          },
          data: {
            isAvailable: false,
          },
        });

        // Update connection status
        await tx.mcpServerConnection.update({
          where: { id: connectionId },
          data: {
            status: "CONNECTED",
            protocolVersion: session.protocolVersion || "2026-07-28",
            serverName: session.serverName || null,
            serverVersion: session.serverVersion || null,
            serverCapabilities: (session.serverCapabilities || {}) as Prisma.InputJsonValue,
            lastConnectedAt: new Date(),
            lastValidatedAt: new Date(),
            lastErrorCode: null,
            ...(conn.credential?.authType === "BEARER"
              ? { authenticationStatus: "AUTHENTICATED" }
              : {}),
          },
        });
      });

      // 4. Update in-memory tool registry cache
      this.toolRegistry.registerTools(
        conn.workspaceId,
        conn.id,
        conn.name,
        discoveredTools,
        cacheMetadata
      );

      // 5. Fetch updated connection and tools
      const updated = await prisma.mcpServerConnection.findUniqueOrThrow({
        where: { id: connectionId },
        include: {
          _count: { select: { tools: true } },
          tools: {
            include: { permission: true },
            orderBy: { toolName: "asc" },
          },
        },
      });

      await logAuditEvent({
        workspaceId: conn.workspaceId,
        actorId: userId,
        action: "mcp_connection.discovered",
        resourceType: "mcp_connection",
        resourceId: connectionId,
        details: {
          serverName: session.serverName,
          discoveredToolsCount: discoveredTools.length,
        },
        ipAddress: auditMeta?.ipAddress,
        userAgent: auditMeta?.userAgent,
      });

      const formattedTools = updated.tools.map((t) => this.formatToolInfo(t, updated.name));

      return {
        connection: this.formatConnectionInfo(updated),
        discoveredToolsCount: discoveredTools.length,
        tools: formattedTools,
      };
    } catch (err: unknown) {
      const errorMessage = (err as Error).message;
      const errorCode = (err as McpError).code || "CONNECTION_FAILED";

      // Persist failure status
      await prisma.mcpServerConnection.update({
        where: { id: connectionId },
        data: {
          status: "ERROR",
          lastErrorCode: errorCode,
        },
      });

      await logAuditEvent({
        workspaceId: conn.workspaceId,
        actorId: userId,
        action: "mcp_connection.failed",
        resourceType: "mcp_connection",
        resourceId: connectionId,
        details: { error: errorMessage, errorCode },
        ipAddress: auditMeta?.ipAddress,
        userAgent: auditMeta?.userAgent,
      });

      if (err instanceof McpError) {
        throw new McpServerServiceError(err.message, 502, err.code);
      }

      throw new McpServerServiceError(
        `Failed to connect to MCP server: ${errorMessage}`,
        502,
        "MCP_CONNECTION_FAILED"
      );
    }
  }

  /**
   * Health probes a server without modifying persistent state.
   */
  public async testConnection(
    userId: string,
    connectionId: string
  ): Promise<McpTestConnectionResult> {
    const conn = await prisma.mcpServerConnection.findUnique({
      where: { id: connectionId },
      include: { credential: true },
    });

    if (!conn) {
      throw new McpServerServiceError(
        "MCP server connection not found",
        404,
        "CONNECTION_NOT_FOUND"
      );
    }

    const role = await this.getAuthorizedMembership(userId, conn.workspaceId);
    this.requireAdminRole(role);

    const bearerToken = this.decryptBearerToken(
      conn.workspaceId,
      conn.id,
      conn.credential?.encryptedAccessToken || null
    );

    return await this.healthService.testConnection({
      workspaceId: conn.workspaceId,
      connectionId: conn.id,
      name: conn.name,
      endpointUrl: conn.endpointUrl,
      transportType: conn.transportType,
      authType: conn.credential?.authType || "NONE",
      bearerToken,
    });
  }

  // ===========================================================================
  // Tool & Permission Management
  // ===========================================================================

  /**
   * Lists all discovered tools for a workspace or connection.
   */
  public async listTools(
    userId: string,
    workspaceId: string,
    connectionId?: string
  ): Promise<McpToolDefinitionInfo[]> {
    await this.getAuthorizedMembership(userId, workspaceId);

    const tools = await prisma.mcpToolDefinition.findMany({
      where: {
        ...(connectionId ? { connectionId } : {}),
        connection: { workspaceId },
      },
      include: {
        connection: { select: { name: true } },
        permission: true,
      },
      orderBy: [{ connection: { name: "asc" } }, { toolName: "asc" }],
    });

    return tools.map((t) => this.formatToolInfo(t, t.connection.name));
  }

  /**
   * Updates authorization permission for a discovered tool.
   * Enforces OWNER or ADMIN role.
   */
  public async updateToolPermission(
    userId: string,
    toolDefinitionId: string,
    input: UpdateMcpToolPermissionInput,
    auditMeta?: { ipAddress?: string; userAgent?: string }
  ): Promise<McpToolPermissionInfo> {
    const toolDef = await prisma.mcpToolDefinition.findUnique({
      where: { id: toolDefinitionId },
      include: { connection: true },
    });

    if (!toolDef) {
      throw new McpServerServiceError(
        "MCP tool definition not found",
        404,
        "TOOL_NOT_FOUND"
      );
    }

    const role = await this.getAuthorizedMembership(userId, toolDef.connection.workspaceId);
    this.requireAdminRole(role);

    const requiresApproval =
      input.requiresApproval !== undefined
        ? input.requiresApproval
        : input.permissionMode === "REQUIRE_APPROVAL";

    const perm = await prisma.mcpToolPermission.upsert({
      where: { toolDefinitionId },
      create: {
        workspaceId: toolDef.connection.workspaceId,
        toolDefinitionId,
        permissionMode: input.permissionMode,
        requiresApproval,
        configuredByUserId: userId,
      },
      update: {
        permissionMode: input.permissionMode,
        requiresApproval,
        configuredByUserId: userId,
      },
    });

    // Invalidate in-memory tool cache so permission changes take immediate effect
    this.toolRegistry.invalidateConnection(toolDef.connection.workspaceId, toolDef.connectionId);

    await logAuditEvent({
      workspaceId: toolDef.connection.workspaceId,
      actorId: userId,
      action: "mcp_tool_permission.updated",
      resourceType: "mcp_tool_permission",
      resourceId: perm.id,
      details: {
        toolDefinitionId,
        toolName: toolDef.toolName,
        permissionMode: input.permissionMode,
        requiresApproval,
      },
      ipAddress: auditMeta?.ipAddress,
      userAgent: auditMeta?.userAgent,
    });

    return {
      id: perm.id,
      workspaceId: perm.workspaceId,
      toolDefinitionId: perm.toolDefinitionId,
      permissionMode: perm.permissionMode,
      requiresApproval: perm.requiresApproval,
      configuredByUserId: perm.configuredByUserId,
      createdAt: perm.createdAt.toISOString(),
      updatedAt: perm.updatedAt.toISOString(),
    };
  }
}

export const mcpServerService = new McpServerService();
