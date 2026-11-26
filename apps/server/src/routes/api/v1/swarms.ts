import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { StartSwarmRunSchema, ApproveSwarmPlanSchema } from "@messiah/shared";
import { SwarmServiceError, swarmService } from "../../../services/agents/index.js";

const WorkspaceQuerySchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
});

const RunParamsSchema = z.object({
  runId: z.string().uuid("Invalid swarm run ID"),
});

export const swarmRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", fastify.authenticate);

  const handleError = (err: unknown, reply: any) => {
    if (err instanceof SwarmServiceError) {
      return reply.code(err.statusCode).send({
        success: false,
        error: { code: err.code, message: err.message },
        meta: { timestamp: new Date().toISOString() },
      });
    }
    throw err;
  };

  /**
   * GET /api/v1/swarms?workspaceId=...
   */
  fastify.get("/swarms", async (request, reply) => {
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
      const runs = await swarmService.listSwarmRuns(query.data.workspaceId, request.user.id);
      return reply.code(200).send({
        success: true,
        data: runs,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * POST /api/v1/swarms
   */
  fastify.post("/swarms", async (request, reply) => {
    const body = StartSwarmRunSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid swarm run launch parameters.",
          details: body.error.format(),
        },
      });
    }

    try {
      const created = await swarmService.startSwarmRun(request.user.id, body.data);
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
   * GET /api/v1/swarms/:runId?workspaceId=...
   */
  fastify.get("/swarms/:runId", async (request, reply) => {
    const params = RunParamsSchema.safeParse(request.params);
    const query = WorkspaceQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Valid runId and workspaceId are required." },
      });
    }

    try {
      const detail = await swarmService.getSwarmRunDetail(params.data.runId, query.data.workspaceId, request.user.id);
      return reply.code(200).send({
        success: true,
        data: detail,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * POST /api/v1/swarms/:runId/approve-plan
   */
  fastify.post("/swarms/:runId/approve-plan", async (request, reply) => {
    const params = RunParamsSchema.safeParse(request.params);
    const body = ApproveSwarmPlanSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Valid runId, workspaceId, and action are required." },
      });
    }

    try {
      const updated = await swarmService.approveOrRejectPlan(
        params.data.runId,
        body.data.workspaceId,
        request.user.id,
        body.data.action,
        body.data.rejectionReason
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
   * POST /api/v1/swarms/:runId/cancel
   */
  fastify.post("/swarms/:runId/cancel", async (request, reply) => {
    const params = RunParamsSchema.safeParse(request.params);
    const body = z.object({ workspaceId: z.string().uuid() }).safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Valid runId and workspaceId are required." },
      });
    }

    try {
      const cancelled = await swarmService.cancelSwarmRun(
        params.data.runId,
        body.data.workspaceId,
        request.user.id
      );
      return reply.code(200).send({
        success: true,
        data: cancelled,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });
};
