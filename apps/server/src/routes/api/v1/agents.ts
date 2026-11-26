import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  CreateAgentSchema,
  UpdateAgentSchema,
  TestAgentSchema,
} from "@messiah/shared";
import { AgentRegistryError, agentRegistryService } from "../../../services/agents/index.js";

const WorkspaceQuerySchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  includeArchived: z
    .string()
    .optional()
    .transform((v) => v === "true"),
});

const AgentParamsSchema = z.object({
  agentId: z.string().uuid("Invalid agent ID"),
});

export const agentRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", fastify.authenticate);

  const handleServiceError = (err: unknown, reply: any) => {
    if (err instanceof AgentRegistryError) {
      return reply.code(err.statusCode).send({
        success: false,
        error: { code: err.code, message: err.message },
        meta: { timestamp: new Date().toISOString() },
      });
    }
    throw err;
  };

  /**
   * GET /api/v1/agents?workspaceId=...
   */
  fastify.get("/agents", async (request, reply) => {
    const query = WorkspaceQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Query parameter 'workspaceId' must be a valid UUID.",
          details: query.error.format(),
        },
      });
    }

    try {
      const data = await agentRegistryService.listAgents(query.data.workspaceId, request.user.id, {
        includeArchived: query.data.includeArchived,
      });
      return reply.code(200).send({
        success: true,
        data,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleServiceError(err, reply);
    }
  });

  /**
   * POST /api/v1/agents/templates/seed
   * Idempotently seeds default Supervisor, Research, Developer, Reviewer, Analyst, General Assistant templates.
   */
  fastify.post("/agents/templates/seed", async (request, reply) => {
    const parsed = z.object({ workspaceId: z.string().uuid("Invalid workspace ID") }).safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Invalid workspaceId", details: parsed.error.format() },
      });
    }

    try {
      const seeded = await agentRegistryService.seedDefaultTemplates(parsed.data.workspaceId, request.user.id);
      return reply.code(201).send({
        success: true,
        data: seeded,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleServiceError(err, reply);
    }
  });

  /**
   * POST /api/v1/agents
   */
  fastify.post("/agents", async (request, reply) => {
    const parsed = CreateAgentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid agent configuration.",
          details: parsed.error.format(),
        },
      });
    }

    try {
      const created = await agentRegistryService.createAgent(request.user.id, parsed.data);
      return reply.code(201).send({
        success: true,
        data: created,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleServiceError(err, reply);
    }
  });

  /**
   * GET /api/v1/agents/:agentId?workspaceId=...
   */
  fastify.get("/agents/:agentId", async (request, reply) => {
    const params = AgentParamsSchema.safeParse(request.params);
    const query = WorkspaceQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Valid workspaceId and agentId are required." },
      });
    }

    try {
      const agent = await agentRegistryService.getAgent(query.data.workspaceId, params.data.agentId, request.user.id);
      return reply.code(200).send({
        success: true,
        data: agent,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleServiceError(err, reply);
    }
  });

  /**
   * PATCH /api/v1/agents/:agentId?workspaceId=...
   */
  fastify.patch("/agents/:agentId", async (request, reply) => {
    const params = AgentParamsSchema.safeParse(request.params);
    const query = WorkspaceQuerySchema.safeParse(request.query);
    const body = UpdateAgentSchema.safeParse(request.body);
    if (!params.success || !query.success || !body.success) {
      return reply.code(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid agent update parameters.",
          details: !body.success ? body.error.format() : undefined,
        },
      });
    }

    try {
      const updated = await agentRegistryService.updateAgent(
        query.data.workspaceId,
        params.data.agentId,
        request.user.id,
        body.data
      );
      return reply.code(200).send({
        success: true,
        data: updated,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleServiceError(err, reply);
    }
  });

  /**
   * DELETE /api/v1/agents/:agentId?workspaceId=...
   */
  fastify.delete("/agents/:agentId", async (request, reply) => {
    const params = AgentParamsSchema.safeParse(request.params);
    const query = WorkspaceQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Valid workspaceId and agentId are required." },
      });
    }

    try {
      const result = await agentRegistryService.deleteOrArchiveAgent(
        query.data.workspaceId,
        params.data.agentId,
        request.user.id
      );
      return reply.code(200).send({
        success: true,
        data: result,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleServiceError(err, reply);
    }
  });

  /**
   * POST /api/v1/agents/:agentId/duplicate
   */
  fastify.post("/agents/:agentId/duplicate", async (request, reply) => {
    const params = AgentParamsSchema.safeParse(request.params);
    const body = z.object({ workspaceId: z.string().uuid() }).safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Valid workspaceId and agentId are required." },
      });
    }

    try {
      const duplicated = await agentRegistryService.duplicateAgent(
        body.data.workspaceId,
        params.data.agentId,
        request.user.id
      );
      return reply.code(201).send({
        success: true,
        data: duplicated,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleServiceError(err, reply);
    }
  });

  /**
   * POST /api/v1/agents/:agentId/test
   */
  fastify.post("/agents/:agentId/test", async (request, reply) => {
    const params = AgentParamsSchema.safeParse(request.params);
    const body = TestAgentSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Valid workspaceId, agentId, and test prompt are required.",
          details: !body.success ? body.error.format() : undefined,
        },
      });
    }

    try {
      const result = await agentRegistryService.testAgentPrompt(
        body.data.workspaceId,
        params.data.agentId,
        request.user.id,
        body.data.prompt
      );
      return reply.code(200).send({
        success: true,
        data: result,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleServiceError(err, reply);
    }
  });
};
