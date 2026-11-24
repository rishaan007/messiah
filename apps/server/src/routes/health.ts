import type { FastifyPluginAsync } from "fastify";
import {
  PRODUCT_IDENTITY,
  type LivenessResponse,
  type ReadinessResponse,
} from "@messiah/shared";

const startTime = Date.now();

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /health/live
   * Liveness probe: Confirms that the Node.js/Fastify process is running and responding.
   */
  fastify.get("/health/live", async (_request, reply) => {
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
    const response: LivenessResponse = {
      status: "alive",
      uptimeSeconds,
      timestamp: new Date().toISOString(),
      version: PRODUCT_IDENTITY.version,
    };
    return reply.status(200).send(response);
  });

  /**
   * GET /health/ready
   * Readiness probe: Verifies availability of PostgreSQL and Redis without leaking sensitive connection details.
   */
  fastify.get("/health/ready", async (_request, reply) => {
    const now = new Date().toISOString();

    // Probe PostgreSQL
    const dbResult = await fastify.checkDbHealth();

    // Probe Redis
    const redisResult = await fastify.checkRedisHealth();

    const isHealthy = dbResult.isHealthy && redisResult.isHealthy;

    const response: ReadinessResponse = {
      status: isHealthy ? "healthy" : "unhealthy",
      timestamp: now,
      version: PRODUCT_IDENTITY.version,
      checks: {
        database: {
          status: dbResult.isHealthy ? "healthy" : "unhealthy",
          latencyMs: dbResult.latencyMs,
          message: dbResult.isHealthy
            ? "Database responsive"
            : "Database connection failed",
          timestamp: now,
        },
        redis: {
          status: redisResult.isHealthy ? "healthy" : "unhealthy",
          latencyMs: redisResult.latencyMs,
          message: redisResult.isHealthy
            ? "Redis responsive"
            : "Redis connection failed",
          timestamp: now,
        },
      },
    };

    // Return 200 if all dependencies healthy, 503 Service Unavailable if any dependency fails
    const statusCode = isHealthy ? 200 : 503;
    return reply.status(statusCode).send(response);
  });
};
