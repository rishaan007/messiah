import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  ClearMemoriesSchema,
  CreateMemoryCollectionSchema,
  CreateMemorySchema,
  MemoryScopeSchema,
  ReembedMemoriesSchema,
  SearchMemorySchema,
  UpdateMemorySchema,
  UpdateMemorySettingsSchema,
} from "@messiah/shared";
import { MemoryServiceError, serverMemoryService } from "../../../services/memory/index.js";
import { workflowEventRouter } from "../../../services/workflows/index.js";

const WorkspaceQuerySchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  scope: MemoryScopeSchema.optional(),
  agentId: z.string().uuid().optional(),
  collectionId: z.string().uuid().optional(),
  search: z.string().optional(),
  includeArchived: z.coerce.boolean().optional(),
});

const MemoryParamsSchema = z.object({
  memoryId: z.string().uuid("Invalid memory ID"),
});

const CollectionParamsSchema = z.object({
  collectionId: z.string().uuid("Invalid collection ID"),
});

export const memoryRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", fastify.authenticate);

  const handleError = (err: unknown, reply: any) => {
    if (err instanceof MemoryServiceError) {
      return reply.code(err.statusCode).send({
        success: false,
        error: { code: err.code, message: err.message },
        meta: { timestamp: new Date().toISOString() },
      });
    }
    throw err;
  };

  /**
   * GET /api/v1/memories?workspaceId=...
   */
  fastify.get("/memories", async (request, reply) => {
    const query = WorkspaceQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Valid workspaceId query parameter is required.",
          details: query.error.format(),
        },
      });
    }

    try {
      const items = await serverMemoryService.listMemories({
        workspaceId: query.data.workspaceId,
        userId: request.user.id,
        scope: query.data.scope,
        agentId: query.data.agentId,
        collectionId: query.data.collectionId,
        search: query.data.search,
        includeArchived: query.data.includeArchived,
      });
      return reply.code(200).send({
        success: true,
        data: items,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * POST /api/v1/memories
   */
  fastify.post("/memories", async (request, reply) => {
    const body = CreateMemorySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid memory payload.",
          details: body.error.format(),
        },
      });
    }

    try {
      const created = await serverMemoryService.createMemory(request.user.id, body.data);
      workflowEventRouter
        .emitDomainEvent({
          workspaceId: body.data.workspaceId,
          eventType: "memory.created",
          dedupKey: `mem-created-${created.id}`,
          triggeredByUserId: request.user.id,
          payload: {
            memoryId: created.id,
            scope: created.scope,
            title: created.title,
            sourceType: created.sourceType,
          },
        })
        .catch(() => {});

      return reply.code(201).send({
        success: true,
        data: created,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * POST /api/v1/memories/search
   */
  fastify.post("/memories/search", async (request, reply) => {
    const body = SearchMemorySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid memory search query.",
          details: body.error.format(),
        },
      });
    }

    try {
      const results = await serverMemoryService.searchMemories({
        ...body.data,
        userId: request.user.id,
      });
      return reply.code(200).send({
        success: true,
        data: results,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * GET /api/v1/memories/collections?workspaceId=...
   */
  fastify.get("/memories/collections", async (request, reply) => {
    const query = WorkspaceQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Valid workspaceId is required." },
      });
    }

    try {
      const cols = await serverMemoryService.listCollections(
        query.data.workspaceId,
        request.user.id,
        query.data.scope
      );
      return reply.code(200).send({
        success: true,
        data: cols,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * POST /api/v1/memories/collections
   */
  fastify.post("/memories/collections", async (request, reply) => {
    const body = CreateMemoryCollectionSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid memory collection payload.",
          details: body.error.format(),
        },
      });
    }

    try {
      const col = await serverMemoryService.createCollection(request.user.id, body.data);
      return reply.code(201).send({
        success: true,
        data: col,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * DELETE /api/v1/memories/collections/:collectionId?workspaceId=...
   */
  fastify.delete("/memories/collections/:collectionId", async (request, reply) => {
    const params = CollectionParamsSchema.safeParse(request.params);
    const query = WorkspaceQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Valid collectionId and workspaceId required." },
      });
    }

    try {
      await serverMemoryService.deleteCollection(
        params.data.collectionId,
        query.data.workspaceId,
        request.user.id
      );
      return reply.code(200).send({
        success: true,
        data: { deleted: true },
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * GET /api/v1/memories/settings?workspaceId=...
   */
  fastify.get("/memories/settings", async (request, reply) => {
    const query = WorkspaceQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Valid workspaceId required." },
      });
    }

    try {
      const settings = await serverMemoryService.getSettings(
        query.data.workspaceId,
        request.user.id
      );
      return reply.code(200).send({
        success: true,
        data: settings,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * PUT /api/v1/memories/settings
   */
  fastify.put("/memories/settings", async (request, reply) => {
    const body = UpdateMemorySettingsSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid memory settings payload.",
          details: body.error.format(),
        },
      });
    }

    try {
      const updated = await serverMemoryService.updateSettings(request.user.id, body.data);
      return reply.code(200).send({
        success: true,
        data: updated,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * POST /api/v1/memories/reembed
   */
  fastify.post("/memories/reembed", async (request, reply) => {
    const body = ReembedMemoriesSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Invalid reembed payload." },
      });
    }

    try {
      const result = await serverMemoryService.reembedWorkspaceMemories(request.user.id, body.data);
      return reply.code(200).send({
        success: true,
        data: result,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * POST /api/v1/memories/clear
   */
  fastify.post("/memories/clear", async (request, reply) => {
    const body = ClearMemoriesSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Invalid clear payload." },
      });
    }

    try {
      const result = await serverMemoryService.clearMemories(request.user.id, body.data);
      return reply.code(200).send({
        success: true,
        data: result,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * GET /api/v1/memories/:memoryId?workspaceId=...
   */
  fastify.get("/memories/:memoryId", async (request, reply) => {
    const params = MemoryParamsSchema.safeParse(request.params);
    const query = WorkspaceQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Valid memoryId and workspaceId required." },
      });
    }

    try {
      const item = await serverMemoryService.getMemory(
        params.data.memoryId,
        query.data.workspaceId,
        request.user.id
      );
      return reply.code(200).send({
        success: true,
        data: item,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * PATCH /api/v1/memories/:memoryId
   */
  fastify.patch("/memories/:memoryId", async (request, reply) => {
    const params = MemoryParamsSchema.safeParse(request.params);
    const body = UpdateMemorySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid memory update parameters.",
          details: !body.success ? body.error.format() : undefined,
        },
      });
    }

    try {
      const updated = await serverMemoryService.updateMemory(
        params.data.memoryId,
        request.user.id,
        body.data
      );
      return reply.code(200).send({
        success: true,
        data: updated,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * DELETE /api/v1/memories/:memoryId?workspaceId=...
   */
  fastify.delete("/memories/:memoryId", async (request, reply) => {
    const params = MemoryParamsSchema.safeParse(request.params);
    const query = WorkspaceQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Valid memoryId and workspaceId required." },
      });
    }

    try {
      await serverMemoryService.deleteMemory(
        params.data.memoryId,
        query.data.workspaceId,
        request.user.id
      );
      return reply.code(200).send({
        success: true,
        data: { deleted: true },
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });
};
