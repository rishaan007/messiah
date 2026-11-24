import type { FastifyPluginAsync } from "fastify";
import {
  CreateThreadSchema,
  UpdateThreadSchema,
  SendMessageSchema,
  CursorPaginationSchema,
} from "@messiah/shared";
import { threadService, messageService, chatService } from "../../../services/chat/index.js";
import { prisma } from "@messiah/db";

export const threadsRoutes: FastifyPluginAsync = async (fastify) => {
  // All thread routes require valid Supabase JWT authentication
  fastify.addHook("preHandler", fastify.authenticate);

  /**
   * GET /api/v1/threads?workspaceId=...
   * List conversations in an authorized workspace.
   */
  fastify.get<{ Querystring: { workspaceId?: string; includeArchived?: string } }>(
    "/threads",
    async (request, reply) => {
      const workspaceId = request.query.workspaceId;
      if (!workspaceId) {
        return reply.code(400).send({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Query parameter 'workspaceId' is required",
          },
        });
      }

      const threads = await threadService.listThreads(request.user.id, workspaceId, {
        includeArchived: request.query.includeArchived === "true",
      });

      return reply.send({
        success: true,
        data: threads,
        meta: { timestamp: new Date().toISOString() },
      });
    }
  );

  /**
   * POST /api/v1/threads
   * Create a new conversation thread.
   */
  fastify.post<{ Body: unknown }>("/threads", async (request, reply) => {
    const parseResult = CreateThreadSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.code(400).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: parseResult.error.errors[0]?.message || "Invalid thread payload",
          details: parseResult.error.flatten(),
        },
      });
    }

    const thread = await threadService.createThread(request.user.id, parseResult.data);
    return reply.code(201).send({
      success: true,
      data: thread,
      meta: { timestamp: new Date().toISOString() },
    });
  });

  /**
   * GET /api/v1/threads/:threadId
   * Retrieve thread information.
   */
  fastify.get<{ Params: { threadId: string } }>("/threads/:threadId", async (request, reply) => {
    const thread = await threadService.getThread(request.user.id, request.params.threadId);
    return reply.send({
      success: true,
      data: thread,
      meta: { timestamp: new Date().toISOString() },
    });
  });

  /**
   * PATCH /api/v1/threads/:threadId
   * Rename, archive, or update thread settings.
   */
  fastify.patch<{ Params: { threadId: string }; Body: unknown }>(
    "/threads/:threadId",
    async (request, reply) => {
      const parseResult = UpdateThreadSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: parseResult.error.errors[0]?.message || "Invalid thread update payload",
            details: parseResult.error.flatten(),
          },
        });
      }

      const updated = await threadService.updateThread(
        request.user.id,
        request.params.threadId,
        parseResult.data
      );

      return reply.send({
        success: true,
        data: updated,
        meta: { timestamp: new Date().toISOString() },
      });
    }
  );

  /**
   * DELETE /api/v1/threads/:threadId
   * Delete a thread and all associated messages.
   */
  fastify.delete<{ Params: { threadId: string } }>(
    "/threads/:threadId",
    async (request, reply) => {
      await threadService.deleteThread(request.user.id, request.params.threadId);
      return reply.send({
        success: true,
        data: { deleted: true, message: "Conversation thread deleted successfully" },
        meta: { timestamp: new Date().toISOString() },
      });
    }
  );

  /**
   * GET /api/v1/threads/:threadId/messages
   * List conversation messages with cursor pagination.
   */
  fastify.get<{
    Params: { threadId: string };
    Querystring: { cursor?: string; limit?: string };
  }>("/threads/:threadId/messages", async (request, reply) => {
    const parseQuery = CursorPaginationSchema.safeParse(request.query);
    const limit = parseQuery.success ? parseQuery.data.limit : 50;
    const cursor = parseQuery.success ? parseQuery.data.cursor : undefined;

    const result = await messageService.listMessages(request.user.id, request.params.threadId, {
      limit,
      cursor,
    });

    return reply.send({
      success: true,
      data: result.messages,
      meta: {
        nextCursor: result.nextCursor,
        count: result.messages.length,
        timestamp: new Date().toISOString(),
      },
    });
  });

  /**
   * POST /api/v1/threads/:threadId/messages
   * Send a user message and initiate AI generation.
   */
  fastify.post<{
    Params: { threadId: string };
    Body: unknown;
  }>("/threads/:threadId/messages", async (request, reply) => {
    const parseResult = SendMessageSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.code(400).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: parseResult.error.errors[0]?.message || "Invalid message payload",
          details: parseResult.error.flatten(),
        },
      });
    }

    const result = await chatService.sendMessage(
      request.user.id,
      request.params.threadId,
      parseResult.data,
      {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      }
    );

    return reply.code(201).send({
      success: true,
      data: result,
      meta: { timestamp: new Date().toISOString() },
    });
  });

  /**
   * GET /api/v1/threads/:threadId/tool-calls
   * List all MCP tool calls associated with a conversation thread.
   */
  fastify.get<{
    Params: { threadId: string };
  }>("/threads/:threadId/tool-calls", async (request, reply) => {
    // Verify user has access to thread
    await threadService.getThread(request.user.id, request.params.threadId);

    const toolCalls = await prisma.toolCall.findMany({
      where: { threadId: request.params.threadId },
      include: {
        approval: true,
      },
      orderBy: { createdAt: "asc" },
    });

    return reply.send({
      success: true,
      data: toolCalls,
      meta: {
        count: toolCalls.length,
        timestamp: new Date().toISOString(),
      },
    });
  });
};
