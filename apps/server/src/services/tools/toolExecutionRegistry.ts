import {
  prisma,
  type McpPermissionMode,
} from "@messiah/db";
import {
  generateToolAlias,
  parseToolAlias,
  translateToProviderTool,
} from "@messiah/mcp";
import type { ProviderToolDefinition } from "@messiah/providers";

export interface ResolvedToolMapping {
  toolDefinitionId: string;
  connectionId: string;
  connectionName: string;
  endpointUrl: string;
  transportType: string;
  originalToolName: string;
  providerToolAlias: string;
  schemaHash: string;
  inputSchema: Record<string, unknown>;
  isReadOnly: boolean;
  permissionMode: McpPermissionMode;
  requiresApproval: boolean;
}

export class ToolExecutionRegistry {
  /**
   * Retrieves all enabled, provider-compatible tool definitions for a workspace (and optional thread filter)
   * to be passed to LLM providers during generation.
   */
  public async getAvailableToolsForThread(
    workspaceId: string,
    threadEnabledTools?: string[]
  ): Promise<{
    definitions: ProviderToolDefinition[];
    mappings: Map<string, ResolvedToolMapping>;
  }> {
    // 1. Fetch all connected MCP servers in the workspace
    const connections = await prisma.mcpServerConnection.findMany({
      where: {
        workspaceId,
        status: "CONNECTED",
      },
      include: {
        tools: {
          where: { isAvailable: true },
          include: {
            permission: true,
          },
        },
      },
    });

    const definitions: ProviderToolDefinition[] = [];
    const mappings = new Map<string, ResolvedToolMapping>();

    for (const conn of connections) {
      for (const tool of conn.tools) {
        const permissionMode = tool.permission?.permissionMode || "REQUIRE_APPROVAL";

        // Skip completely disabled tools
        if (permissionMode === "DISABLED") {
          continue;
        }

        // Thread-level filter check
        if (threadEnabledTools && !threadEnabledTools.includes(tool.toolName)) {
          continue;
        }

        const alias = generateToolAlias(conn.name, tool.toolName, conn.id);
        const legacyAlias = generateToolAlias(conn.name, tool.toolName);
        const inputSchema = (tool.inputSchema || {}) as Record<string, unknown>;
        const isReadOnly = Boolean((tool.annotations as any)?.readOnly);

        // Translate to standard JSON Schema suitable for OpenAI / Anthropic / Gemini
        const providerTool = translateToProviderTool(
          alias,
          tool.description || undefined,
          inputSchema
        );

        definitions.push(providerTool);

        const mapping: ResolvedToolMapping = {
          toolDefinitionId: tool.id,
          connectionId: conn.id,
          connectionName: conn.name,
          endpointUrl: conn.endpointUrl,
          transportType: conn.transportType,
          originalToolName: tool.toolName,
          providerToolAlias: alias,
          schemaHash: tool.schemaHash,
          inputSchema,
          isReadOnly,
          permissionMode,
          requiresApproval: tool.permission?.requiresApproval ?? true,
        };

        mappings.set(alias, mapping);
        if (!mappings.has(legacyAlias)) {
          mappings.set(legacyAlias, mapping);
        }
        mappings.set(`${conn.name}__${tool.toolName}`, mapping);
      }
    }

    return { definitions, mappings };
  }

  /**
   * Resolves a model tool call name (e.g. mcp__github_prod__get_issue)
   * to its underlying MCP tool definition, connection, and permission record.
   */
  public async resolveToolAlias(
    workspaceId: string,
    toolAlias: string
  ): Promise<ResolvedToolMapping | null> {
    const parsed = parseToolAlias(toolAlias);

    // 1. First attempt: match by generated alias or namespaced name from active tools in workspace
    const { mappings } = await this.getAvailableToolsForThread(workspaceId);
    if (mappings.has(toolAlias)) {
      return mappings.get(toolAlias)!;
    }

    if (!parsed) {
      return null;
    }

    // 2. Fallback: match by tool name and connection in database
    const matchingDefs = await prisma.mcpToolDefinition.findMany({
      where: {
        isAvailable: true,
        toolName: parsed.toolName,
        connection: {
          workspaceId,
          status: "CONNECTED",
        },
      },
      include: {
        connection: true,
        permission: true,
      },
    });

    if (matchingDefs.length === 0) {
      return null;
    }

    let toolDef = matchingDefs[0]!;
    if (parsed.connectionIdSuffix) {
      const matched = matchingDefs.find((td) => {
        const suffix = td.connection.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 6).toLowerCase();
        return suffix === parsed.connectionIdSuffix;
      });
      if (matched) {
        toolDef = matched;
      }
    }

    if (!toolDef || !toolDef.connection) {
      return null;
    }

    const permissionMode = toolDef.permission?.permissionMode || "REQUIRE_APPROVAL";
    if (permissionMode === "DISABLED") {
      return null;
    }

    const alias = generateToolAlias(toolDef.connection.name, toolDef.toolName, toolDef.connectionId);
    const isReadOnly = Boolean((toolDef.annotations as any)?.readOnly);
    return {
      toolDefinitionId: toolDef.id,
      connectionId: toolDef.connectionId,
      connectionName: toolDef.connection.name,
      endpointUrl: toolDef.connection.endpointUrl,
      transportType: toolDef.connection.transportType,
      originalToolName: toolDef.toolName,
      providerToolAlias: alias,
      schemaHash: toolDef.schemaHash,
      inputSchema: (toolDef.inputSchema || {}) as Record<string, unknown>,
      isReadOnly,
      permissionMode,
      requiresApproval: toolDef.permission?.requiresApproval ?? true,
    };
  }
}

export const toolExecutionRegistry = new ToolExecutionRegistry();
