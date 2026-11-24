import {
  prisma,
  type McpPermissionMode,
  type ToolCallStatus,
} from "@messiah/db";
import {
  McpConnectionManager,
  ToolSchemaValidator,
  toolResultSanitizer,
  generateToolAlias,
  translateToProviderTool,
  type SanitizedToolResult,
} from "@messiah/mcp";
import type { ProviderToolDefinition } from "@messiah/providers";
import { VaultService } from "./vault.js";

export interface ResolvedWorkerToolMapping {
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

export interface WorkerToolExecutionOutcome {
  status: ToolCallStatus;
  result: unknown;
  sanitizedText: string;
  isError: boolean;
  errorMessage?: string;
  durationMs: number;
}

export class WorkerToolExecutor {
  private connectionManager: McpConnectionManager;
  private validator: ToolSchemaValidator;

  public static readonly DEFAULT_TIMEOUT_MS = 30000; // 30s timeout

  constructor() {
    this.connectionManager = new McpConnectionManager();
    this.validator = new ToolSchemaValidator();
  }

  /**
   * Retrieves all enabled tool definitions and mapping lookups for a workspace.
   */
  public async getAvailableToolsForWorkspace(
    workspaceId: string
  ): Promise<{
    definitions: ProviderToolDefinition[];
    mappings: Map<string, ResolvedWorkerToolMapping>;
  }> {
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
    const mappings = new Map<string, ResolvedWorkerToolMapping>();

    for (const conn of connections) {
      for (const tool of conn.tools) {
        const permissionMode = tool.permission?.permissionMode || "REQUIRE_APPROVAL";

        if (permissionMode === "DISABLED") {
          continue;
        }

        const alias = generateToolAlias(conn.name, tool.toolName, conn.id);
        const legacyAlias = generateToolAlias(conn.name, tool.toolName);
        const inputSchema = (tool.inputSchema || {}) as Record<string, unknown>;
        const isReadOnly = Boolean((tool.annotations as any)?.readOnly);

        const providerTool = translateToProviderTool(
          alias,
          tool.description || undefined,
          inputSchema
        );

        definitions.push(providerTool);

        const mapping: ResolvedWorkerToolMapping = {
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
   * Decrypts stored bearer token for an MCP connection.
   */
  private decryptBearerToken(
    workspaceId: string,
    connectionId: string,
    encryptedAccessToken: string | null
  ): string | undefined {
    if (!encryptedAccessToken) return undefined;
    try {
      const payload = JSON.parse(encryptedAccessToken);
      return VaultService.decrypt(
        payload.ciphertext,
        payload.iv,
        payload.tag,
        connectionId,
        workspaceId,
        "v2"
      );
    } catch {
      return undefined;
    }
  }

  /**
   * Executes a tool against an MCP server, enforcing timeout, schema validation, and sanitization.
   */
  public async executeTool(
    workspaceId: string,
    connectionId: string,
    originalToolName: string,
    inputSchema: Record<string, unknown>,
    schemaHash: string,
    rawArguments: Record<string, unknown>,
    timeoutMs = WorkerToolExecutor.DEFAULT_TIMEOUT_MS
  ): Promise<WorkerToolExecutionOutcome> {
    // 1. Schema validation
    const validation = this.validator.validateArguments(inputSchema, rawArguments, schemaHash);
    if (!validation.valid) {
      const errorMsg = `Schema validation failed: ${(validation.errors || []).join("; ")}`;
      return {
        status: "FAILED",
        result: { errors: validation.errors },
        sanitizedText: errorMsg,
        isError: true,
        errorMessage: errorMsg,
        durationMs: 0,
      };
    }

    // 2. Fetch connection
    const connection = await prisma.mcpServerConnection.findUnique({
      where: { id: connectionId },
      include: { credential: true },
    });

    if (!connection) {
      return {
        status: "FAILED",
        result: null,
        sanitizedText: "MCP connection not found.",
        isError: true,
        errorMessage: "Connection not found.",
        durationMs: 0,
      };
    }

    // 3. Resolve active session
    let session = this.connectionManager.getSession(workspaceId, connectionId);
    if (!session) {
      const bearerToken = this.decryptBearerToken(
        workspaceId,
        connectionId,
        connection.credential?.encryptedAccessToken || null
      );

      session = await this.connectionManager.connect({
        connectionId,
        workspaceId,
        name: connection.name,
        endpointUrl: connection.endpointUrl,
        transportType: connection.transportType,
        authType: connection.credential?.authType || "NONE",
        bearerToken,
      });
    }

    // 4. Execute tool with timeout
    const abortController = new AbortController();
    const timer = setTimeout(() => {
      abortController.abort();
    }, timeoutMs);

    const startTime = Date.now();
    let rawResult: unknown;
    let isError = false;
    let status: ToolCallStatus = "SUCCEEDED";
    let errorMessage: string | undefined;

    try {
      const callResult = await session.client.callTool(
        {
          name: originalToolName,
          arguments: rawArguments,
        },
        { signal: abortController.signal }
      );

      clearTimeout(timer);
      rawResult = callResult;

      if (callResult.isError) {
        isError = true;
        status = "FAILED";
        errorMessage = "MCP tool returned error status";
      }
    } catch (err: unknown) {
      clearTimeout(timer);
      const errStr = String(err).toLowerCase();
      const errCode = (err as any)?.code;
      const cause = (err as any)?.cause;
      const causeStr = cause ? String(cause).toLowerCase() : "";
      const causeCode = cause?.code;

      const isTimeout =
        abortController.signal.aborted ||
        (err instanceof Error && err.name === "AbortError") ||
        errStr.includes("aborted") ||
        errStr.includes("timeout") ||
        errStr.includes("etimedout") ||
        errCode === "ETIMEDOUT" ||
        causeCode === "ETIMEDOUT" ||
        causeStr.includes("timeout") ||
        causeStr.includes("etimedout");

      const isSeveredConnection =
        errCode === "ECONNRESET" ||
        errCode === "ECONNABORTED" ||
        errCode === "EPIPE" ||
        errCode === "UND_ERR_SOCKET" ||
        causeCode === "ECONNRESET" ||
        causeCode === "UND_ERR_SOCKET" ||
        errStr.includes("socket hang up") ||
        errStr.includes("econnreset") ||
        errStr.includes("fetch failed") ||
        errStr.includes("bad gateway") ||
        errStr.includes("gateway timeout") ||
        causeStr.includes("socket") ||
        causeStr.includes("closed") ||
        causeStr.includes("reset");

      if (isTimeout || isSeveredConnection) {
        status = "UNKNOWN_OUTCOME";
        isError = true;
        errorMessage = isTimeout
          ? `Tool execution timed out after ${timeoutMs / 1000} seconds. The external server may have processed or begun processing the request. Operation outcome is unknown. Do not automatically re-execute.`
          : `Connection severed or socket hung up during tool execution (${err instanceof Error ? err.message : String(err)}). The external server may have processed the request. Operation outcome is unknown. Do not automatically re-execute.`;
      } else {
        status = "FAILED";
        isError = true;
        errorMessage = err instanceof Error ? err.message : String(err);
      }
      rawResult = { error: errorMessage, outcomeStatus: status };
    }

    const durationMs = Date.now() - startTime;
    const sanitized: SanitizedToolResult = toolResultSanitizer.sanitize(rawResult);

    return {
      status,
      result: rawResult,
      sanitizedText: sanitized.content,
      isError,
      errorMessage,
      durationMs,
    };
  }
}

export const workerToolExecutor = new WorkerToolExecutor();
