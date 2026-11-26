import fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { type ServerEnv } from "@messiah/shared";
import corsPlugin from "./plugins/cors.js";
import helmetPlugin from "./plugins/helmet.js";
import sensiblePlugin from "./plugins/sensible.js";
import prismaPlugin from "./plugins/prisma.js";
import redisPlugin from "./plugins/redis.js";
import authPlugin from "./plugins/auth.js";
import { healthRoutes } from "./routes/health.js";
import { systemRoutes } from "./routes/api/v1/system.js";
import { userRoutes } from "./routes/api/v1/user.js";
import { workspaceRoutes } from "./routes/api/v1/workspaces.js";
import { providerRoutes } from "./routes/api/v1/providers.js";
import { connectionRoutes } from "./routes/api/v1/connections.js";
import { threadsRoutes } from "./routes/api/v1/threads.js";
import { runsRoutes } from "./routes/api/v1/runs.js";
import { realtimeRoutes } from "./routes/api/v1/realtime.js";
import { mcpRoutes } from "./routes/api/v1/mcp.js";
import { toolApprovalRoutes } from "./routes/api/v1/toolApprovals.js";
import { deviceRoutes } from "./routes/api/v1/devices.js";
import { agentRoutes } from "./routes/api/v1/agents.js";
import { swarmRoutes } from "./routes/api/v1/swarms.js";
import { streamPublisher, ticketService, cancellationService, chatQueueManager, chatWorkerManager, ReconciliationService } from "./services/chat/index.js";
import { swarmStreamPublisher } from "./services/agents/index.js";
import { devicePresenceService } from "./services/devices/index.js";
import { createLogger } from "./utils/logger.js";

export interface BuildAppOptions {
  env: ServerEnv;
  logger?: boolean;
}

export async function buildApp(opts: BuildAppOptions) {
  const loggerInstance =
    opts.logger !== false
      ? createLogger(opts.env.NODE_ENV, opts.env.LOG_LEVEL)
      : undefined;

  const app = fastify({
    ...(loggerInstance ? { loggerInstance } : { logger: false }),
  });

  // Core Security Plugins
  await app.register(corsPlugin, { origin: opts.env.CORS_ORIGIN });
  await app.register(helmetPlugin);
  await app.register(sensiblePlugin);
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
  });

  // Persistence & Cache Plugins
  await app.register(prismaPlugin);
  await app.register(redisPlugin, { url: opts.env.REDIS_URL });

  // Authentication Plugin
  await app.register(authPlugin, {
    supabaseUrl: opts.env.SUPABASE_URL,
    supabaseJwtSecret: opts.env.SUPABASE_JWT_SECRET,
    isTestEnv: opts.env.NODE_ENV === 'test' || opts.env.NODE_ENV === 'development',
  });

  // Realtime WebSocket Plugin (must be registered before routes)
  await app.register(websocket, {
    options: {
      maxPayload: 1048576, // 1MB frame limit
    },
  });

  // Wire services with Redis
  streamPublisher.setRedis(app.redis);
  swarmStreamPublisher.setRedis(app.redis);
  ticketService.setRedis(app.redis);
  cancellationService.setRedis(app.redis);
  devicePresenceService.setRedis(app.redis);
  if (opts.env.REDIS_URL) {
    chatQueueManager.initialize(opts.env.REDIS_URL);
    // In test environment or when explicitly configured, run embedded worker to process jobs
    if (opts.env.NODE_ENV === "test" || process.env.ENABLE_EMBEDDED_WORKER === "true") {
      chatWorkerManager.start(opts.env.REDIS_URL);
    }
  }

  // Gracefully close BullMQ worker and queue connections on app close
  app.addHook("onClose", async () => {
    app.server.closeAllConnections?.();
    await chatWorkerManager.close();
    await chatQueueManager.close();
  });

  // Startup Run Reconciliation (heals orphaned runs left in STREAMING/PENDING)
  await ReconciliationService.reconcileOrphanedRuns();

  // Global 404 Handler
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      success: false,
      error: {
        code: "NOT_FOUND",
        message: `Route '${request.method} ${request.url}' not found`,
      },
      meta: {
        timestamp: new Date().toISOString(),
      },
    });
  });

  // Global Error Handler
  app.setErrorHandler((error, request, reply) => {
    app.log.error({ err: error, req: request.raw }, "Unhandled API Exception");

    const err = error as {
      statusCode?: number;
      code?: string;
      message?: string;
      validation?: unknown;
    };

    const statusCode =
      err.statusCode && err.statusCode >= 400 && err.statusCode < 600
        ? err.statusCode
        : 500;

    const isClientError = statusCode < 500;
    const message =
      isClientError || opts.env.NODE_ENV !== "production"
        ? err.message || "Error occurred"
        : "Internal server error";

    reply.status(statusCode).send({
      success: false,
      error: {
        code: err.code || "INTERNAL_SERVER_ERROR",
        message,
        details: isClientError ? err.validation : undefined,
      },
      meta: {
        timestamp: new Date().toISOString(),
      },
    });
  });

  // Route Handlers
  await app.register(healthRoutes);
  await app.register(systemRoutes);
  await app.register(userRoutes);
  await app.register(workspaceRoutes);
  await app.register(providerRoutes);
  await app.register(connectionRoutes);
  await app.register(threadsRoutes, { prefix: "/api/v1" });
  await app.register(runsRoutes, { prefix: "/api/v1" });
  await app.register(realtimeRoutes, { prefix: "/api/v1" });
  await app.register(mcpRoutes);
  await app.register(toolApprovalRoutes, { prefix: "/api/v1" });
  await app.register(deviceRoutes, { prefix: "/api/v1" });
  await app.register(agentRoutes, { prefix: "/api/v1" });
  await app.register(swarmRoutes, { prefix: "/api/v1" });

  return app;
}
