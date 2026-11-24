import fp from "fastify-plugin";
import { Redis } from "ioredis";
import type { FastifyPluginAsync } from "fastify";

export interface RedisPluginOptions {
  url: string;
}

declare module "fastify" {
  interface FastifyInstance {
    redis: Redis;
    checkRedisHealth: () => Promise<{
      isHealthy: boolean;
      latencyMs: number;
      error?: string;
    }>;
  }
}

const redisPlugin: FastifyPluginAsync<RedisPluginOptions> = async (
  fastify,
  opts,
) => {
  const redis = new Redis(opts.url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
    retryStrategy(times) {
      const delay = Math.min(times * 200, 2000);
      return delay;
    },
  });

  // Connect cleanly
  try {
    await redis.connect();
    fastify.log.info("Connected to Redis successfully");
  } catch (err) {
    fastify.log.warn(
      { err },
      "Initial Redis connection failed; will retry on demand",
    );
  }

  const checkRedisHealth = async () => {
    const start = performance.now();
    try {
      const reply = await redis.ping();
      const latencyMs = Math.round(performance.now() - start);
      return {
        isHealthy: reply === "PONG",
        latencyMs,
      };
    } catch (err) {
      const latencyMs = Math.round(performance.now() - start);
      const errorMessage =
        err instanceof Error ? err.message : "Unknown Redis error";
      return {
        isHealthy: false,
        latencyMs,
        error: errorMessage,
      };
    }
  };

  fastify.decorate("redis", redis);
  fastify.decorate("checkRedisHealth", checkRedisHealth);

  fastify.addHook("onClose", async (instance) => {
    instance.log.info("Closing Redis client...");
    try {
      await instance.redis.quit();
    } catch {
      instance.redis.disconnect();
    }
  });
};

export default fp(redisPlugin, {
  name: "redis-plugin",
});
