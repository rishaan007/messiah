import type { FastifyPluginAsync } from "fastify";
import {
  PRODUCT_IDENTITY,
  type LivenessResponse,
  type ReadinessResponse,
} from "@messiah/shared";

const startTime = Date.now();
let totalHttpRequests = 0;

export function incrementHttpRequestMetric(): void {
  totalHttpRequests += 1;
}

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
   * Readiness probe: Verifies availability of PostgreSQL (+ pgvector) and Redis without leaking sensitive connection details.
   */
  fastify.get("/health/ready", async (_request, reply) => {
    const now = new Date().toISOString();

    const [dbResult, redisResult] = await Promise.all([
      fastify.checkDbHealth(),
      fastify.checkRedisHealth(),
    ]);

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

    const statusCode = isHealthy ? 200 : 503;
    return reply.status(statusCode).send(response);
  });

  /**
   * GET /metrics
   * Prometheus text exposition endpoint (protected by MESSIAH_METRICS_TOKEN in production if configured).
   */
  fastify.get("/metrics", async (request, reply) => {
    const expectedToken = process.env.MESSIAH_METRICS_TOKEN;
    if (expectedToken) {
      const auth = request.headers.authorization || "";
      if (auth !== `Bearer ${expectedToken}`) {
        return reply.status(401).send("Unauthorized");
      }
    }

    const mem = process.memoryUsage();
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
    const [dbResult, redisResult] = await Promise.all([
      fastify.checkDbHealth(),
      fastify.checkRedisHealth(),
    ]);

    let outboxPending = 0;
    let outboxFailed = 0;
    let activeDevices = 0;
    let activeWorkflows = 0;
    let pgvectorUp = 0;

    if (dbResult.isHealthy) {
      try {
        const [pendingCount, failedCount, deviceCount, wfCount, vecExt] = await Promise.all([
          fastify.prisma.outboxEvent.count({ where: { status: "PENDING" } }),
          fastify.prisma.outboxEvent.count({ where: { status: "FAILED" } }),
          fastify.prisma.bridgeDevice.count({ where: { status: "ACTIVE" } }),
          fastify.prisma.workflowDefinition.count({ where: { status: "ACTIVE" } }),
          fastify.prisma.$queryRawUnsafe<Array<{ extversion: string }>>(
            `SELECT extversion FROM pg_extension WHERE extname = 'vector'`
          ),
        ]);
        outboxPending = pendingCount;
        outboxFailed = failedCount;
        activeDevices = deviceCount;
        activeWorkflows = wfCount;
        pgvectorUp = vecExt.length > 0 ? 1 : 0;
      } catch {
        // Keep safe defaults on transient DB error
      }
    }

    const lines = [
      "# HELP messiah_uptime_seconds Process uptime in seconds",
      "# TYPE messiah_uptime_seconds gauge",
      `messiah_uptime_seconds ${uptimeSeconds}`,
      "# HELP messiah_process_resident_memory_bytes Process RSS memory usage in bytes",
      "# TYPE messiah_process_resident_memory_bytes gauge",
      `messiah_process_resident_memory_bytes ${mem.rss}`,
      "# HELP messiah_process_heap_used_bytes Node.js heap used in bytes",
      "# TYPE messiah_process_heap_used_bytes gauge",
      `messiah_process_heap_used_bytes ${mem.heapUsed}`,
      "# HELP messiah_http_requests_total Total HTTP requests handled since start",
      "# TYPE messiah_http_requests_total counter",
      `messiah_http_requests_total ${totalHttpRequests}`,
      "# HELP messiah_db_up PostgreSQL health state (1=up, 0=down)",
      "# TYPE messiah_db_up gauge",
      `messiah_db_up ${dbResult.isHealthy ? 1 : 0}`,
      "# HELP messiah_pgvector_enabled pgvector extension state (1=enabled, 0=absent)",
      "# TYPE messiah_pgvector_enabled gauge",
      `messiah_pgvector_enabled ${pgvectorUp}`,
      "# HELP messiah_redis_up Redis health state (1=up, 0=down)",
      "# TYPE messiah_redis_up gauge",
      `messiah_redis_up ${redisResult.isHealthy ? 1 : 0}`,
      "# HELP messiah_outbox_pending_total Pending transactional outbox events",
      "# TYPE messiah_outbox_pending_total gauge",
      `messiah_outbox_pending_total ${outboxPending}`,
      "# HELP messiah_outbox_failed_total Failed transactional outbox events",
      "# TYPE messiah_outbox_failed_total gauge",
      `messiah_outbox_failed_total ${outboxFailed}`,
      "# HELP messiah_active_devices_total Active paired bridge devices",
      "# TYPE messiah_active_devices_total gauge",
      `messiah_active_devices_total ${activeDevices}`,
      "# HELP messiah_active_workflows_total Active published workflows",
      "# TYPE messiah_active_workflows_total gauge",
      `messiah_active_workflows_total ${activeWorkflows}`,
      "",
    ];

    return reply
      .status(200)
      .header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
      .send(lines.join("\n"));
  });
};
