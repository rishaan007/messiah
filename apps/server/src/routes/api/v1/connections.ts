import type { FastifyPluginAsync } from "fastify";
import {
  CreateProviderConnectionSchema,
  UpdateProviderConnectionSchema,
  type ApiResponse,
  type ProviderConnectionInfo,
  type ConnectionValidationResult,
} from "@messiah/shared";
import {
  providerConnectionService,
  ProviderConnectionServiceError,
} from "../../../services/providerConnectionService.js";
import { ProviderError } from "@messiah/providers";

export const connectionRoutes: FastifyPluginAsync = async (fastify) => {
  // Enforce authentication across connection routes
  fastify.addHook("preHandler", fastify.authenticate);

  /**
   * GET /api/v1/provider-connections
   * Returns connections accessible in the specified workspace.
   */
  fastify.get<{
    Querystring: { workspaceId?: string };
  }>("/api/v1/provider-connections", async (request, reply) => {
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
      const connections = await providerConnectionService.listWorkspaceConnections(
        workspaceId,
        request.user.id
      );

      const response: ApiResponse<ProviderConnectionInfo[]> = {
        success: true,
        data: connections,
        meta: { timestamp: new Date().toISOString() },
      };

      return reply.status(200).send(response);
    } catch (err: unknown) {
      if (err instanceof ProviderConnectionServiceError) {
        return reply.status(err.statusCode).send({
          success: false,
          error: { code: err.code, message: err.message },
          meta: { timestamp: new Date().toISOString() },
        });
      }

      return reply.status(500).send({
        success: false,
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to list provider connections.",
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }
  });

  /**
   * POST /api/v1/provider-connections
   * Creates and securely encrypts a provider connection after validating credentials.
   */
  fastify.post("/api/v1/provider-connections", async (request, reply) => {
    const parseResult = CreateProviderConnectionSchema.safeParse(request.body);

    if (!parseResult.success) {
      return reply.status(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid connection input parameters.",
          details: parseResult.error.format(),
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    try {
      const created = await providerConnectionService.createConnection(
        request.user.id,
        parseResult.data,
        {
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"],
        }
      );

      const response: ApiResponse<ProviderConnectionInfo> = {
        success: true,
        data: created,
        meta: { timestamp: new Date().toISOString() },
      };

      return reply.status(201).send(response);
    } catch (err: unknown) {
      if (err instanceof ProviderConnectionServiceError) {
        return reply.status(err.statusCode).send({
          success: false,
          error: { code: err.code, message: err.message },
          meta: { timestamp: new Date().toISOString() },
        });
      }

      if (err instanceof ProviderError) {
        return reply.status(err.statusCode || 400).send({
          success: false,
          error: { code: err.code, message: err.message },
          meta: { timestamp: new Date().toISOString() },
        });
      }

      return reply.status(500).send({
        success: false,
        error: {
          code: "CONNECTION_CREATION_FAILED",
          message:
            err instanceof Error
              ? err.message
              : "Failed to create provider connection.",
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }
  });

  /**
   * POST /api/v1/provider-connections/:id/test
   * Tests an existing connection by decrypting credentials and testing with provider.
   */
  fastify.post<{
    Params: { id: string };
    Body: { workspaceId?: string };
    Querystring: { workspaceId?: string };
  }>("/api/v1/provider-connections/:id/test", async (request, reply) => {
    const { id } = request.params;
    const workspaceId = request.body?.workspaceId || request.query?.workspaceId;

    if (!workspaceId) {
      return reply.status(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "'workspaceId' must be provided in body or query.",
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    try {
      const result = await providerConnectionService.testConnection(
        workspaceId,
        id,
        request.user.id,
        {
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"],
        }
      );

      const response: ApiResponse<ConnectionValidationResult> = {
        success: true,
        data: result,
        meta: { timestamp: new Date().toISOString() },
      };

      return reply.status(200).send(response);
    } catch (err: unknown) {
      if (err instanceof ProviderConnectionServiceError) {
        return reply.status(err.statusCode).send({
          success: false,
          error: { code: err.code, message: err.message },
          meta: { timestamp: new Date().toISOString() },
        });
      }

      if (err instanceof ProviderError) {
        return reply.status(err.statusCode || 400).send({
          success: false,
          error: { code: err.code, message: err.message },
          meta: { timestamp: new Date().toISOString() },
        });
      }

      return reply.status(500).send({
        success: false,
        error: {
          code: "CONNECTION_TEST_FAILED",
          message: err instanceof Error ? err.message : "Connection test failed.",
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }
  });

  /**
   * PATCH /api/v1/provider-connections/:id
   * Updates an existing connection's display name or API key.
   */
  fastify.patch<{
    Params: { id: string };
    Body: { workspaceId?: string; displayName?: string; apiKey?: string };
    Querystring: { workspaceId?: string };
  }>("/api/v1/provider-connections/:id", async (request, reply) => {
    const { id } = request.params;
    const workspaceId = request.body?.workspaceId || request.query?.workspaceId;

    if (!workspaceId) {
      return reply.status(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "'workspaceId' must be provided in body or query.",
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    const parseResult = UpdateProviderConnectionSchema.safeParse(request.body);

    if (!parseResult.success) {
      return reply.status(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid update parameters.",
          details: parseResult.error.format(),
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    try {
      const updated = await providerConnectionService.updateConnection(
        workspaceId,
        id,
        request.user.id,
        parseResult.data,
        {
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"],
        }
      );

      const response: ApiResponse<ProviderConnectionInfo> = {
        success: true,
        data: updated,
        meta: { timestamp: new Date().toISOString() },
      };

      return reply.status(200).send(response);
    } catch (err: unknown) {
      if (err instanceof ProviderConnectionServiceError) {
        return reply.status(err.statusCode).send({
          success: false,
          error: { code: err.code, message: err.message },
          meta: { timestamp: new Date().toISOString() },
        });
      }

      if (err instanceof ProviderError) {
        return reply.status(err.statusCode || 400).send({
          success: false,
          error: { code: err.code, message: err.message },
          meta: { timestamp: new Date().toISOString() },
        });
      }

      return reply.status(500).send({
        success: false,
        error: {
          code: "CONNECTION_UPDATE_FAILED",
          message: err instanceof Error ? err.message : "Failed to update connection.",
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }
  });

  /**
   * DELETE /api/v1/provider-connections/:id
   * Deletes a provider connection and cascades to delete encrypted credential.
   */
  fastify.delete<{
    Params: { id: string };
    Querystring: { workspaceId?: string };
    Body: { workspaceId?: string };
  }>("/api/v1/provider-connections/:id", async (request, reply) => {
    const { id } = request.params;
    const workspaceId = request.query?.workspaceId || request.body?.workspaceId;

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
      await providerConnectionService.deleteConnection(
        workspaceId,
        id,
        request.user.id,
        {
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"],
        }
      );

      const response: ApiResponse<{ id: string; deleted: true }> = {
        success: true,
        data: { id, deleted: true },
        meta: { timestamp: new Date().toISOString() },
      };

      return reply.status(200).send(response);
    } catch (err: unknown) {
      if (err instanceof ProviderConnectionServiceError) {
        return reply.status(err.statusCode).send({
          success: false,
          error: { code: err.code, message: err.message },
          meta: { timestamp: new Date().toISOString() },
        });
      }

      return reply.status(500).send({
        success: false,
        error: {
          code: "CONNECTION_DELETION_FAILED",
          message: err instanceof Error ? err.message : "Failed to delete connection.",
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }
  });
};
