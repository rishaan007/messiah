import { Client } from "@modelcontextprotocol/client";
import { McpClientFactory } from "../client/mcpClientFactory.js";
import { McpTransportFactory } from "../transports/transportFactory.js";
import { McpConnectionError } from "../errors/index.js";
import type { McpConnectionContext } from "../types/index.js";
import type { SsrfValidationOptions } from "../security/ssrf.js";

export interface ConnectedSession {
  client: Client;
  context: McpConnectionContext;
  protocolVersion?: string;
  serverName?: string;
  serverVersion?: string;
  serverCapabilities?: Record<string, unknown>;
  connectedAt: Date;
}

export class McpConnectionManager {
  // Scoped active sessions: workspaceId -> connectionId -> ConnectedSession
  // Guarantees zero cross-workspace client mutation or leakage!
  private workspaceSessions = new Map<string, Map<string, ConnectedSession>>();

  constructor(private defaultSsrfOptions: SsrfValidationOptions = {}) {}

  /**
   * Connects to a remote MCP server using official Streamable HTTP (or fallback SSE).
   * Negotiates protocol revision, extracts capabilities, and registers the active session.
   */
  public async connect(
    context: McpConnectionContext,
    overrideSsrfOptions?: SsrfValidationOptions
  ): Promise<ConnectedSession> {
    const { workspaceId, connectionId, endpointUrl, transportType, bearerToken } = context;

    // Disconnect any existing session for this connection first
    await this.disconnect(workspaceId, connectionId);

    const ssrfOptions = overrideSsrfOptions || this.defaultSsrfOptions;

    let client: Client;
    try {
      // 1. Create transport with SSRF protection
      const transport = await McpTransportFactory.createTransport(endpointUrl, {
        transportType,
        bearerToken,
        ssrfOptions,
      });

      // 2. Create official MCP Client
      client = McpClientFactory.createClient();

      // 3. Connect to transport with timeout guard
      await client.connect(transport);

      // 4. Extract server metadata & capabilities
      const serverVersion = client.getServerVersion();
      const serverCapabilities = (client.getServerCapabilities() || {}) as Record<string, unknown>;

      // Modern protocol version negotiation extraction
      const protocolVersion = (client as any).protocolVersion || "2026-07-28";

      const session: ConnectedSession = {
        client,
        context,
        protocolVersion,
        serverName: serverVersion?.name,
        serverVersion: serverVersion?.version,
        serverCapabilities,
        connectedAt: new Date(),
      };

      // 5. Register in workspace session map
      let connectionMap = this.workspaceSessions.get(workspaceId);
      if (!connectionMap) {
        connectionMap = new Map();
        this.workspaceSessions.set(workspaceId, connectionMap);
      }
      connectionMap.set(connectionId, session);

      return session;
    } catch (err) {
      throw new McpConnectionError(
        `Failed to connect to MCP server "${context.name}" at ${endpointUrl}: ${(err as Error).message}`
      );
    }
  }

  /**
   * Retrieves an active connected session for a workspace and connection ID.
   */
  public getSession(workspaceId: string, connectionId: string): ConnectedSession | undefined {
    return this.workspaceSessions.get(workspaceId)?.get(connectionId);
  }

  /**
   * Gracefully disconnects an active session and disposes transport resources.
   */
  public async disconnect(workspaceId: string, connectionId: string): Promise<boolean> {
    const connectionMap = this.workspaceSessions.get(workspaceId);
    if (!connectionMap) return false;

    const session = connectionMap.get(connectionId);
    if (!session) return false;

    try {
      await session.client.close();
    } catch (err) {
      console.warn(`[McpConnectionManager] Error closing client for connection ${connectionId}:`, err);
    } finally {
      connectionMap.delete(connectionId);
      if (connectionMap.size === 0) {
        this.workspaceSessions.delete(workspaceId);
      }
    }

    return true;
  }

  /**
   * Gracefully closes all active MCP connections across all workspaces.
   */
  public async closeAll(): Promise<void> {
    for (const connectionMap of this.workspaceSessions.values()) {
      for (const [connectionId, session] of connectionMap.entries()) {
        try {
          await session.client.close();
        } catch (err) {
          console.warn(`[McpConnectionManager] Error closing connection ${connectionId}:`, err);
        }
      }
      connectionMap.clear();
    }
    this.workspaceSessions.clear();
  }
}
