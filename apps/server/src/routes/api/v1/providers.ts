import type { FastifyPluginAsync } from "fastify";
import type {
  ApiResponse,
  ProviderMetadataInfo,
  ModelInfo,
  SupportedProviderId,
} from "@messiah/shared";
import {
  providerConnectionService,
  ProviderConnectionServiceError,
} from "../../../services/providerConnectionService.js";
import { ProviderError } from "@messiah/providers";

export const providerRoutes: FastifyPluginAsync = async (fastify) => {
  // Enforce authentication across provider routes
  fastify.addHook("preHandler", fastify.authenticate);

  /**
   * GET /api/v1/providers
   * Returns supported provider registry and integration capabilities.
   */
  fastify.get("/api/v1/providers", async (_request, reply) => {
    const providers = providerConnectionService.listSupportedProviders();

    const response: ApiResponse<ProviderMetadataInfo[]> = {
      success: true,
      data: providers,
      meta: { timestamp: new Date().toISOString() },
    };

    return reply.status(200).send(response);
  });

  /**
   * GET /api/v1/providers/:providerId/models
   * Returns supported model metadata using the provider connection authorized for the specified workspace.
   */
  fastify.get<{
    Params: { providerId: string };
    Querystring: { workspaceId?: string };
  }>("/api/v1/providers/:providerId/models", async (request, reply) => {
    const { providerId } = request.params;
    const { workspaceId } = request.query;

    if (!workspaceId) {
      return reply.status(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Query parameter 'workspaceId' is required.",
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    try {
      const models = await providerConnectionService.getWorkspaceProviderModels(
        workspaceId,
        providerId as SupportedProviderId,
        request.user.id
      );

      const response: ApiResponse<ModelInfo[]> = {
        success: true,
        data: models,
        meta: { timestamp: new Date().toISOString() },
      };

      return reply.status(200).send(response);
    } catch (err: unknown) {
      if (err instanceof ProviderConnectionServiceError) {
        return reply.status(err.statusCode).send({
          success: false,
          error: {
            code: err.code,
            message: err.message,
          },
          meta: { timestamp: new Date().toISOString() },
        });
      }

      if (err instanceof ProviderError) {
        return reply.status(err.statusCode || 500).send({
          success: false,
          error: {
            code: err.code,
            message: err.message,
          },
          meta: { timestamp: new Date().toISOString() },
        });
      }

      return reply.status(500).send({
        success: false,
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: err instanceof Error ? err.message : "Failed to fetch models",
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }
  });
};
