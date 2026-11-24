import type { FastifyPluginAsync } from "fastify";
import { CancelRunSchema } from "@messiah/shared";
import { generationService } from "../../../services/chat/index.js";

export const runsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", fastify.authenticate);

  /**
   * GET /api/v1/generation-runs/:runId
   * Retrieve safe generation run status and token metrics.
   */
  fastify.get<{ Params: { runId: string } }>(
    "/generation-runs/:runId",
    async (request, reply) => {
      const run = await generationService.getRun(request.user.id, request.params.runId);
      return reply.send({
        success: true,
        data: run,
        meta: { timestamp: new Date().toISOString() },
      });
    }
  );

  /**
   * POST /api/v1/generation-runs/:runId/cancel
   * Cancel an active generation run.
   */
  fastify.post<{ Params: { runId: string }; Body: unknown }>(
    "/generation-runs/:runId/cancel",
    async (request, reply) => {
      const parseResult = CancelRunSchema.safeParse(request.body || {});
      const reason = parseResult.success ? parseResult.data.reason : undefined;

      const cancelledRun = await generationService.cancelRun(
        request.user.id,
        request.params.runId,
        reason
      );

      return reply.send({
        success: true,
        data: cancelledRun,
        meta: { timestamp: new Date().toISOString() },
      });
    }
  );
};
