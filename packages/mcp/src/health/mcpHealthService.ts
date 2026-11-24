import type { McpConnectionManager } from "../connection/mcpConnectionManager.js";
import type { McpDiscoveryService } from "../discovery/mcpDiscoveryService.js";
import type { McpConnectionContext, McpTestConnectionResult } from "../types/index.js";
import type { SsrfValidationOptions } from "../security/ssrf.js";

export class McpHealthService {
  constructor(
    private connectionManager: McpConnectionManager,
    private discoveryService: McpDiscoveryService
  ) {}

  /**
   * Tests an MCP server endpoint by connecting, negotiating protocol,
   * querying server capabilities, listing tools, and disconnecting.
   */
  public async testConnection(
    context: McpConnectionContext,
    ssrfOptions?: SsrfValidationOptions
  ): Promise<McpTestConnectionResult> {
    const startTime = Date.now();
    try {
      const session = await this.connectionManager.connect(context, ssrfOptions);

      // Probe tools count
      const discoveryResult = await this.discoveryService.discoverTools(
        session.client,
        context.name
      );

      const latencyMs = Date.now() - startTime;

      // Clean up test session
      await this.connectionManager.disconnect(context.workspaceId, context.connectionId);

      return {
        success: true,
        protocolVersion: session.protocolVersion,
        serverName: session.serverName,
        serverVersion: session.serverVersion,
        serverCapabilities: session.serverCapabilities,
        discoveredToolsCount: discoveryResult.tools.length,
        latencyMs,
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      return {
        success: false,
        latencyMs,
        error: (err as Error).message,
      };
    }
  }
}
