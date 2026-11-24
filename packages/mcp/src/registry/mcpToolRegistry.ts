import type { DiscoveredTool } from "../types/index.js";

export interface CachedToolSet {
  connectionId: string;
  serverIdentifier: string;
  tools: DiscoveredTool[];
  cacheMetadata?: Record<string, unknown>;
  cachedAt: number;
  expiresAt?: number;
}

export class McpToolRegistry {
  // Workspace-scoped cache: workspaceId -> connectionId -> CachedToolSet
  // Strictly segregated by workspace to prevent any multi-tenant data leak
  private workspaceCaches = new Map<string, Map<string, CachedToolSet>>();

  /**
   * Registers or updates discovered tools in the in-memory cache for a workspace connection.
   */
  public registerTools(
    workspaceId: string,
    connectionId: string,
    serverIdentifier: string,
    tools: DiscoveredTool[],
    cacheMetadata?: Record<string, unknown>
  ): void {
    let connectionMap = this.workspaceCaches.get(workspaceId);
    if (!connectionMap) {
      connectionMap = new Map();
      this.workspaceCaches.set(workspaceId, connectionMap);
    }

    const now = Date.now();
    let expiresAt: number | undefined;

    // Respect protocol cache TTL if provided in seconds
    const ttlSeconds = typeof cacheMetadata?.ttl === "number" ? cacheMetadata.ttl : undefined;
    if (ttlSeconds !== undefined) {
      expiresAt = now + ttlSeconds * 1000;
    }

    connectionMap.set(connectionId, {
      connectionId,
      serverIdentifier,
      tools,
      cacheMetadata,
      cachedAt: now,
      expiresAt,
    });
  }

  /**
   * Retrieves tools for a specific workspace and connection, checking cache expiry.
   */
  public getTools(workspaceId: string, connectionId: string): DiscoveredTool[] | null {
    const connectionMap = this.workspaceCaches.get(workspaceId);
    if (!connectionMap) return null;

    const cached = connectionMap.get(connectionId);
    if (!cached) return null;

    // Check expiry
    if (cached.expiresAt && Date.now() > cached.expiresAt) {
      connectionMap.delete(connectionId);
      return null;
    }

    return cached.tools;
  }

  /**
   * Retrieves all cached tools across all connections for a specific workspace.
   */
  public getAllWorkspaceTools(workspaceId: string): DiscoveredTool[] {
    const connectionMap = this.workspaceCaches.get(workspaceId);
    if (!connectionMap) return [];

    const allTools: DiscoveredTool[] = [];
    const now = Date.now();

    for (const [connectionId, cached] of connectionMap.entries()) {
      if (cached.expiresAt && now > cached.expiresAt) {
        connectionMap.delete(connectionId);
        continue;
      }
      allTools.push(...cached.tools);
    }

    return allTools;
  }

  /**
   * Invalidates cached tools for a specific connection when refreshed, updated, or removed.
   */
  public invalidateConnection(workspaceId: string, connectionId: string): void {
    const connectionMap = this.workspaceCaches.get(workspaceId);
    if (connectionMap) {
      connectionMap.delete(connectionId);
      if (connectionMap.size === 0) {
        this.workspaceCaches.delete(workspaceId);
      }
    }
  }

  /**
   * Clears the entire cache for a workspace (e.g. on workspace deletion).
   */
  public clearWorkspace(workspaceId: string): void {
    this.workspaceCaches.delete(workspaceId);
  }
}
