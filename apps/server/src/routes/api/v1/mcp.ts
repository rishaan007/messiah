import type { FastifyPluginAsync } from "fastify";
import {
  CreateMcpConnectionSchema,
  UpdateMcpConnectionSchema,
  UpdateMcpToolPermissionSchema,
  type ApiResponse,
  type McpServerConnectionInfo,
  type McpToolDefinitionInfo,
  type McpToolPermissionInfo,
  type McpTestConnectionResult,
} from "@messiah/shared";
import {
  mcpServerService,
  McpServerServiceError,
} from "../../../services/mcpServerService.js";
import { z } from "zod";

const ListConnectionsQuerySchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID format"),
});

const ConnectionParamsSchema = z.object({
  id: z.string().uuid("Invalid connection ID format"),
});

const ToolPermissionParamsSchema = z.object({
  toolDefinitionId: z.string().uuid("Invalid tool definition ID format"),
});

const ListToolsQuerySchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID format"),
});

export const mcpRoutes: FastifyPluginAsync = async (fastify) => {
  // Enforce authentication across all MCP management routes
  fastify.addHook("preHandler", fastify.authenticate);

  /**
   * GET /api/v1/mcp/connections
   * Lists all MCP server connections for the specified workspace.
   */
  fastify.get<{
    Querystring: { workspaceId?: string };
  }>("/api/v1/mcp/connections", async (request, reply) => {
    const parseResult = ListConnectionsQuerySchema.safeParse(request.query);
    if (!parseResult.success) {
      return reply.status(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Query parameter 'workspaceId' must be a valid UUID.",
          details: parseResult.error.format(),
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    try {
      const connections = await mcpServerService.listConnections(
        request.user.id,
        parseResult.data.workspaceId
      );

      const response: ApiResponse<McpServerConnectionInfo[]> = {
        success: true,
        data: connections,
        meta: { timestamp: new Date().toISOString() },
      };
      return reply.status(200).send(response);
    } catch (err: unknown) {
      if (err instanceof McpServerServiceError) {
        return reply.status(err.statusCode).send({
          success: false,
          error: { code: err.code, message: err.message },
          meta: { timestamp: new Date().toISOString() },
        });
      }
      return reply.status(500).send({
        success: false,
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to list MCP connections.",
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }
  });

  /**
   * POST /api/v1/mcp/connections
   * Creates a new MCP server connection.
   */
  fastify.post("/api/v1/mcp/connections", async (request, reply) => {
    const parseResult = CreateMcpConnectionSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid connection payload.",
          details: parseResult.error.format(),
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    try {
      const connection = await mcpServerService.createConnection(
        request.user.id,
        parseResult.data,
        {
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"],
        }
      );

      const response: ApiResponse<McpServerConnectionInfo> = {
        success: true,
        data: connection,
        meta: { timestamp: new Date().toISOString() },
      };
      return reply.status(201).send(response);
    } catch (err: unknown) {
      if (err instanceof McpServerServiceError) {
        return reply.status(err.statusCode).send({
          success: false,
          error: { code: err.code, message: err.message },
          meta: { timestamp: new Date().toISOString() },
        });
      }
      return reply.status(500).send({
        success: false,
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create MCP server connection.",
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }
  });

  /**
   * GET /api/v1/mcp/connections/:id
   * Retrieves connection details and discovered tools.
   */
  fastify.get<{
    Params: { id: string };
  }>("/api/v1/mcp/connections/:id", async (request, reply) => {
    const parseResult = ConnectionParamsSchema.safeParse(request.params);
    if (!parseResult.success) {
      return reply.status(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid connection ID parameter.",
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    try {
      const data = await mcpServerService.getConnection(
        request.user.id,
        parseResult.data.id
      );

      const response: ApiResponse<{
        connection: McpServerConnectionInfo;
        tools: McpToolDefinitionInfo[];
      }> = {
        success: true,
        data,
        meta: { timestamp: new Date().toISOString() },
      };
      return reply.status(200).send(response);
    } catch (err: unknown) {
      if (err instanceof McpServerServiceError) {
        return reply.status(err.statusCode).send({
          success: false,
          error: { code: err.code, message: err.message },
          meta: { timestamp: new Date().toISOString() },
        });
      }
      return reply.status(500).send({
        success: false,
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to fetch MCP connection details.",
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }
  });

  /**
   * PATCH /api/v1/mcp/connections/:id
   * Updates an MCP server connection.
   */
  fastify.patch<{
    Params: { id: string };
  }>("/api/v1/mcp/connections/:id", async (request, reply) => {
    const paramsResult = ConnectionParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.status(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Invalid connection ID." },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    const bodyResult = UpdateMcpConnectionSchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.status(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid update payload.",
          details: bodyResult.error.format(),
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    try {
      const updated = await mcpServerService.updateConnection(
        request.user.id,
        paramsResult.data.id,
        bodyResult.data,
        {
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"],
        }
      );

      const response: ApiResponse<McpServerConnectionInfo> = {
        success: true,
        data: updated,
        meta: { timestamp: new Date().toISOString() },
      };
      return reply.status(200).send(response);
    } catch (err: unknown) {
      if (err instanceof McpServerServiceError) {
        return reply.status(err.statusCode).send({
          success: false,
          error: { code: err.code, message: err.message },
          meta: { timestamp: new Date().toISOString() },
        });
      }
      return reply.status(500).send({
        success: false,
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to update MCP server connection.",
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }
  });

  /**
   * DELETE /api/v1/mcp/connections/:id
   * Deletes an MCP server connection.
   */
  fastify.delete<{
    Params: { id: string };
  }>("/api/v1/mcp/connections/:id", async (request, reply) => {
    const paramsResult = ConnectionParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.status(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Invalid connection ID." },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    try {
      await mcpServerService.deleteConnection(request.user.id, paramsResult.data.id, {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });

      const response: ApiResponse<{ id: string; deleted: true }> = {
        success: true,
        data: { id: paramsResult.data.id, deleted: true },
        meta: { timestamp: new Date().toISOString() },
      };
      return reply.status(200).send(response);
    } catch (err: unknown) {
      if (err instanceof McpServerServiceError) {
        return reply.status(err.statusCode).send({
          success: false,
          error: { code: err.code, message: err.message },
          meta: { timestamp: new Date().toISOString() },
        });
      }
      return reply.status(500).send({
        success: false,
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to delete MCP server connection.",
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }
  });

  /**
   * POST /api/v1/mcp/connections/:id/connect
   * Initiates MCP connection, discovers tools, and synchronizes definitions.
   */
  fastify.post<{
    Params: { id: string };
  }>("/api/v1/mcp/connections/:id/connect", async (request, reply) => {
    const paramsResult = ConnectionParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.status(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Invalid connection ID." },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    try {
      const result = await mcpServerService.connectAndDiscover(
        request.user.id,
        paramsResult.data.id,
        {
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"],
        }
      );

      const response: ApiResponse<{
        connection: McpServerConnectionInfo;
        discoveredToolsCount: number;
        tools: McpToolDefinitionInfo[];
      }> = {
        success: true,
        data: result,
        meta: { timestamp: new Date().toISOString() },
      };
      return reply.status(200).send(response);
    } catch (err: unknown) {
      if (err instanceof McpServerServiceError) {
        return reply.status(err.statusCode).send({
          success: false,
          error: { code: err.code, message: err.message },
          meta: { timestamp: new Date().toISOString() },
        });
      }
      return reply.status(500).send({
        success: false,
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to connect and discover tools.",
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }
  });

  /**
   * POST /api/v1/mcp/connections/:id/refresh
   * Re-syncs tool discovery and schema changes.
   */
  fastify.post<{
    Params: { id: string };
  }>("/api/v1/mcp/connections/:id/refresh", async (request, reply) => {
    const paramsResult = ConnectionParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.status(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Invalid connection ID." },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    try {
      const result = await mcpServerService.connectAndDiscover(
        request.user.id,
        paramsResult.data.id,
        {
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"],
        }
      );

      const response: ApiResponse<{
        connection: McpServerConnectionInfo;
        discoveredToolsCount: number;
        tools: McpToolDefinitionInfo[];
      }> = {
        success: true,
        data: result,
        meta: { timestamp: new Date().toISOString() },
      };
      return reply.status(200).send(response);
    } catch (err: unknown) {
      if (err instanceof McpServerServiceError) {
        return reply.status(err.statusCode).send({
          success: false,
          error: { code: err.code, message: err.message },
          meta: { timestamp: new Date().toISOString() },
        });
      }
      return reply.status(500).send({
        success: false,
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to refresh MCP tool discovery.",
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }
  });

  /**
   * POST /api/v1/mcp/connections/:id/test
   * Runs non-mutating health probe and latency test.
   */
  fastify.post<{
    Params: { id: string };
  }>("/api/v1/mcp/connections/:id/test", async (request, reply) => {
    const paramsResult = ConnectionParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.status(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Invalid connection ID." },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    try {
      const testResult = await mcpServerService.testConnection(
        request.user.id,
        paramsResult.data.id
      );

      const response: ApiResponse<McpTestConnectionResult> = {
        success: true,
        data: testResult,
        meta: { timestamp: new Date().toISOString() },
      };
      return reply.status(200).send(response);
    } catch (err: unknown) {
      if (err instanceof McpServerServiceError) {
        return reply.status(err.statusCode).send({
          success: false,
          error: { code: err.code, message: err.message },
          meta: { timestamp: new Date().toISOString() },
        });
      }
      return reply.status(500).send({
        success: false,
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to test MCP connection.",
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }
  });

  /**
   * GET /api/v1/mcp/tools
   * Lists all discovered tools across connections in a workspace.
   */
  fastify.get<{
    Querystring: { workspaceId?: string; connectionId?: string };
  }>("/api/v1/mcp/tools", async (request, reply) => {
    const parseResult = ListToolsQuerySchema.safeParse(request.query);
    if (!parseResult.success) {
      return reply.status(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Query parameter 'workspaceId' must be a valid UUID.",
          details: parseResult.error.format(),
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    try {
      const tools = await mcpServerService.listTools(
        request.user.id,
        parseResult.data.workspaceId,
        request.query.connectionId
      );

      const response: ApiResponse<McpToolDefinitionInfo[]> = {
        success: true,
        data: tools,
        meta: { timestamp: new Date().toISOString() },
      };
      return reply.status(200).send(response);
    } catch (err: unknown) {
      if (err instanceof McpServerServiceError) {
        return reply.status(err.statusCode).send({
          success: false,
          error: { code: err.code, message: err.message },
          meta: { timestamp: new Date().toISOString() },
        });
      }
      return reply.status(500).send({
        success: false,
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to list MCP tools.",
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }
  });

  /**
   * PATCH /api/v1/mcp/tools/:toolDefinitionId/permission
   * Updates authorization permission mode for a tool (require OWNER/ADMIN).
   */
  fastify.patch<{
    Params: { toolDefinitionId: string };
  }>("/api/v1/mcp/tools/:toolDefinitionId/permission", async (request, reply) => {
    const paramsResult = ToolPermissionParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.status(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Invalid tool definition ID." },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    const bodyResult = UpdateMcpToolPermissionSchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.status(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid permission payload.",
          details: bodyResult.error.format(),
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    try {
      const permission = await mcpServerService.updateToolPermission(
        request.user.id,
        paramsResult.data.toolDefinitionId,
        bodyResult.data,
        {
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"],
        }
      );

      const response: ApiResponse<McpToolPermissionInfo> = {
        success: true,
        data: permission,
        meta: { timestamp: new Date().toISOString() },
      };
      return reply.status(200).send(response);
    } catch (err: unknown) {
      if (err instanceof McpServerServiceError) {
        return reply.status(err.statusCode).send({
          success: false,
          error: { code: err.code, message: err.message },
          meta: { timestamp: new Date().toISOString() },
        });
      }
      return reply.status(500).send({
        success: false,
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to update MCP tool permission.",
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }
  });
};
