import {
  prisma,
  type ToolCallStatus,
} from "@messiah/db";
import {
  McpConnectionManager,
  ToolSchemaValidator,
  toolResultSanitizer,
  type SanitizedToolResult,
} from "@messiah/mcp";
import { VaultService, type EncryptedPayload, type VaultAadContext } from "../vaultService.js";
import { streamPublisher } from "../chat/streamPublisher.js";
import { logAuditEvent } from "../auditService.js";

export class ToolExecutionServiceError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode = 400, code = "TOOL_EXECUTION_ERROR") {
    super(message);
    this.name = "ToolExecutionServiceError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface ExecuteToolParams {
  toolCallId: string;
  generationRunId: string;
  threadId: string;
  workspaceId: string;
  connectionId: string;
  toolDefinitionId: string;
  toolName: string;
  providerCallId: string;
  providerToolAlias: string;
  arguments: Record<string, unknown>;
  timeoutMs?: number;
}

export interface ToolExecutionOutcome {
  status: ToolCallStatus;
  result: unknown;
  sanitizedText: string;
  isError: boolean;
  errorMessage?: string;
  durationMs: number;
}

export class ToolExecutionService {
  private connectionManager: McpConnectionManager;
  private vaultService: VaultService;
  private validator: ToolSchemaValidator;

  public static readonly DEFAULT_TIMEOUT_MS = 30000; // 30 seconds

  constructor(
    connectionManager?: McpConnectionManager,
    vaultService?: VaultService,
    validator?: ToolSchemaValidator
  ) {
    const isTest = process.env.NODE_ENV === "test";
    this.connectionManager =
      connectionManager ||
      new McpConnectionManager(isTest ? { allowLocalhost: true, allowHttp: true } : {});
    this.vaultService = vaultService || new VaultService();
    this.validator = validator || new ToolSchemaValidator();
  }

  private buildMcpAadContext(workspaceId: string, connectionId: string): VaultAadContext {
    return {
      workspaceId,
      providerConnectionId: connectionId,
      provider: "mcp",
    };
  }

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
      throw new ToolExecutionServiceError(
        "Failed to decrypt stored MCP credentials.",
        500,
        "CREDENTIAL_DECRYPTION_ERROR"
      );
    }
  }

  /**
   * Executes a validated and authorized MCP tool call against the remote MCP server.
   */
  public async executeTool(params: ExecuteToolParams): Promise<ToolExecutionOutcome> {
    const {
      toolCallId,
      generationRunId,
      threadId,
      workspaceId,
      connectionId,
      toolDefinitionId,
      toolName,
      providerCallId,
      providerToolAlias,
      arguments: rawArguments,
      timeoutMs = ToolExecutionService.DEFAULT_TIMEOUT_MS,
    } = params;

    // 1. Transition ToolCall status to EXECUTING
    await prisma.toolCall.update({
      where: { id: toolCallId },
      data: {
        status: "EXECUTING",
      },
    });

    // 2. Publish real-time "tool.executing" event
    await streamPublisher.publish({
      type: "tool.executing",
      threadId,
      runId: generationRunId,
      messageId: providerCallId,
      sequence: 0,
      timestamp: new Date().toISOString(),
      payload: {
        toolCall: {
          id: toolCallId,
          providerCallId,
          toolName,
          providerToolAlias,
          status: "EXECUTING",
        },
      },
    });

    // 3. Load connection and tool definition from DB
    const connection = await prisma.mcpServerConnection.findUnique({
      where: { id: connectionId },
      include: {
        credential: true,
      },
    });

    if (!connection || connection.workspaceId !== workspaceId) {
      const outcome: ToolExecutionOutcome = {
        status: "FAILED",
        result: null,
        sanitizedText: "MCP server connection not found or unauthorized.",
        isError: true,
        errorMessage: "MCP server connection not found.",
        durationMs: 0,
      };
      await this.persistOutcome(toolCallId, threadId, generationRunId, providerCallId, outcome);
      return outcome;
    }

    const toolDef = await prisma.mcpToolDefinition.findUnique({
      where: { id: toolDefinitionId },
    });

    if (!toolDef || !toolDef.isAvailable) {
      const outcome: ToolExecutionOutcome = {
        status: "FAILED",
        result: null,
        sanitizedText: `Tool '${toolName}' is not available.`,
        isError: true,
        errorMessage: "Tool definition unavailable.",
        durationMs: 0,
      };
      await this.persistOutcome(toolCallId, threadId, generationRunId, providerCallId, outcome);
      return outcome;
    }

    // 4. Server-side Ajv JSON Schema validation
    const validation = this.validator.validateArguments(
      (toolDef.inputSchema || {}) as Record<string, unknown>,
      rawArguments,
      toolDef.schemaHash
    );

    if (!validation.valid) {
      const validationErrorMsg = `Schema validation failed: ${(validation.errors || []).join("; ")}`;
      const outcome: ToolExecutionOutcome = {
        status: "FAILED",
        result: { errors: validation.errors },
        sanitizedText: validationErrorMsg,
        isError: true,
        errorMessage: validationErrorMsg,
        durationMs: 0,
      };
      await this.persistOutcome(toolCallId, threadId, generationRunId, providerCallId, outcome);
      return outcome;
    }

    // 5. Resolve active client session
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

    // 6. Execute tool invocation via MCP SDK Client with AbortController timeout
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
          name: toolName,
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

    // 7. Sanitize output (strip dangerous protocols, redact secrets, limit to 512KB)
    const sanitized: SanitizedToolResult = toolResultSanitizer.sanitize(rawResult);

    const outcome: ToolExecutionOutcome = {
      status,
      result: rawResult,
      sanitizedText: sanitized.content,
      isError,
      errorMessage,
      durationMs,
    };

    // 8. Persist outcome and publish event
    await this.persistOutcome(toolCallId, threadId, generationRunId, providerCallId, outcome);

    // 9. Audit log
    await logAuditEvent({
      actorId: undefined,
      workspaceId,
      action: status === "SUCCEEDED" ? "tool_execution_succeeded" : "tool_execution_failed",
      resourceType: "tool_call",
      resourceId: toolCallId,
      details: {
        toolName,
        status,
        durationMs,
        isError,
      },
    });

    return outcome;
  }

  /**
   * Persists tool execution outcome to database and broadcasts WebSocket event.
   */
  private async persistOutcome(
    toolCallId: string,
    threadId: string,
    runId: string,
    providerCallId: string,
    outcome: ToolExecutionOutcome
  ): Promise<void> {
    await prisma.toolCall.update({
      where: { id: toolCallId },
      data: {
        status: outcome.status,
        result: outcome.result as any,
        isError: outcome.isError,
        errorMessage: outcome.errorMessage || null,
        durationMs: outcome.durationMs,
        completedAt: new Date(),
      },
    });

    const eventType = outcome.status === "UNKNOWN_OUTCOME" ? "tool.unknown_outcome" : outcome.isError ? "tool.failed" : "tool.completed";
    await streamPublisher.publish({
      type: eventType,
      threadId,
      runId,
      messageId: providerCallId,
      sequence: 0,
      timestamp: new Date().toISOString(),
      payload: {
        toolCall: {
          id: toolCallId,
          status: outcome.status,
          isError: outcome.isError,
          errorMessage: outcome.errorMessage,
          durationMs: outcome.durationMs,
        },
      },
    });
  }
}

export const toolExecutionService = new ToolExecutionService();
