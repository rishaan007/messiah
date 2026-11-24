import type { FastifyPluginAsync } from "fastify";
import {
  PRODUCT_IDENTITY,
  type SystemInfo,
  type ApiResponse,
} from "@messiah/shared";

export const systemRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/system", async (_request, reply) => {
    const data: SystemInfo = {
      name: PRODUCT_IDENTITY.name,
      tagline: PRODUCT_IDENTITY.tagline,
      version: PRODUCT_IDENTITY.version,
      environment:
        (process.env["NODE_ENV"] as SystemInfo["environment"]) ?? "development",
    };

    const response: ApiResponse<SystemInfo> = {
      success: true,
      data,
      meta: {
        timestamp: new Date().toISOString(),
      },
    };

    return reply.status(200).send(response);
  });
};
