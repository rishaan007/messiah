import crypto from "node:crypto";
import type { Client } from "@modelcontextprotocol/client";
import { McpDiscoveryError } from "../errors/index.js";
import type { DiscoveredTool } from "../types/index.js";

export class McpDiscoveryService {
  /**
   * Computes a deterministic SHA-256 schema hash to detect tool definition changes.
   */
  public static computeSchemaHash(tool: {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
  }): string {
    const canonical = JSON.stringify({
      name: tool.name,
      description: tool.description || "",
      inputSchema: tool.inputSchema || {},
      outputSchema: tool.outputSchema || null,
    });
    return crypto.createHash("sha256").update(canonical).digest("hex");
  }

  /**
   * Creates an unambiguous namespaced identifier: serverIdentifier.toolName
   */
  public static formatNamespacedName(serverIdentifier: string, toolName: string): string {
    const cleanServer = serverIdentifier
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_-]/g, "_");
    const cleanTool = toolName.trim();
    return `${cleanServer}.${cleanTool}`;
  }

  /**
   * Discovers tools from a connected MCP client, normalizing schemas and extracting cache metadata.
   * Tool execution is NEVER triggered during discovery.
   */
  public async discoverTools(
    client: Client,
    serverIdentifier: string
  ): Promise<{ tools: DiscoveredTool[]; cacheMetadata?: Record<string, unknown> }> {
    try {
      // 1. Invoke official SDK listTools
      const result = await client.listTools();

      const rawTools = result.tools || [];
      const discoveredTools: DiscoveredTool[] = [];
      const seenToolNames = new Set<string>();

      // 2. Normalize and validate each tool
      for (const raw of rawTools) {
        if (!raw.name || typeof raw.name !== "string") {
          console.warn("[McpDiscoveryService] Skipping tool with missing or invalid name:", raw);
          continue;
        }

        const toolName = raw.name.trim();

        // Check for duplicate tool names within the same server connection
        if (seenToolNames.has(toolName)) {
          console.warn(`[McpDiscoveryService] Duplicate tool name "${toolName}" returned by server; skipping duplicate.`);
          continue;
        }
        seenToolNames.add(toolName);

        const inputSchema = (raw.inputSchema && typeof raw.inputSchema === "object"
          ? raw.inputSchema
          : { type: "object", properties: {} }) as Record<string, unknown>;

        const outputSchema = (raw as any).outputSchema && typeof (raw as any).outputSchema === "object"
          ? (raw as any).outputSchema
          : undefined;

        const annotations = (raw as any).annotations && typeof (raw as any).annotations === "object"
          ? (raw as any).annotations
          : undefined;

        const schemaHash = McpDiscoveryService.computeSchemaHash({
          name: toolName,
          description: raw.description,
          inputSchema,
          outputSchema,
        });

        const namespacedName = McpDiscoveryService.formatNamespacedName(serverIdentifier, toolName);

        discoveredTools.push({
          name: toolName,
          namespacedName,
          displayName: (raw as any).title || toolName,
          description: raw.description || undefined,
          inputSchema,
          outputSchema,
          annotations,
          schemaHash,
        });
      }

      // 3. Extract protocol cache metadata if returned (modern 2026-07-28 protocol feature)
      const cacheMetadata = (result as any)._meta?.cache || (result as any).cacheMetadata;

      return {
        tools: discoveredTools,
        cacheMetadata: cacheMetadata ? (cacheMetadata as Record<string, unknown>) : undefined,
      };
    } catch (err) {
      throw new McpDiscoveryError(
        `Failed to discover tools from MCP server "${serverIdentifier}": ${(err as Error).message}`
      );
    }
  }
}
