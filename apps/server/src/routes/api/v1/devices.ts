import type { FastifyPluginAsync } from "fastify";
import type { WebSocket } from "ws";
import {
  CreatePairingChallengeSchema,
  ClaimPairingChallengeSchema,
  ApprovePairingSchema,
  RejectPairingSchema,
  RenameDeviceSchema,
  DeviceActionSchema,
} from "@messiah/shared";
import {
  devicePairingService,
  deviceManagementService,
  deviceConnectionGateway,
  DevicePairingError,
  DeviceManagementError,
} from "../../../services/devices/index.js";

export const deviceRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * WebSocket /api/v1/devices/connect
   * Outbound WSS gateway initiated by the local Messiah Bridge daemon.
   */
  fastify.get(
    "/devices/connect",
    { websocket: true },
    (socket: WebSocket, req) => {
      deviceConnectionGateway.handleConnection(socket, req);
    }
  );

  /**
   * POST /api/v1/devices/pair/challenge
   * Generates a 256-bit pairing challenge (5m TTL).
   * Requires authenticated workspace OWNER or ADMIN.
   */
  fastify.post<{ Body: unknown }>(
    "/devices/pair/challenge",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const parseResult = CreatePairingChallengeSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(422).send({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: parseResult.error.errors[0]?.message || "Invalid request body",
          },
        });
      }

      try {
        const result = await devicePairingService.createPairingChallenge(
          parseResult.data.workspaceId,
          request.user.id
        );
        return reply.code(201).send({
          success: true,
          data: result,
        });
      } catch (err: unknown) {
        if (err instanceof DevicePairingError) {
          return reply.code(err.statusCode).send({
            success: false,
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    }
  );

  /**
   * POST /api/v1/devices/pair/claim
   * Public endpoint called by the Bridge daemon CLI during `messiah-bridge pair`.
   * Submits pairing secret and device public key.
   */
  fastify.post<{ Body: unknown }>(
    "/devices/pair/claim",
    async (request, reply) => {
      const parseResult = ClaimPairingChallengeSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(422).send({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: parseResult.error.errors[0]?.message || "Invalid pairing request payload",
          },
        });
      }

      try {
        const result = await devicePairingService.claimPairingChallenge(parseResult.data);
        return reply.code(200).send({
          success: true,
          data: result,
        });
      } catch (err: unknown) {
        if (err instanceof DevicePairingError) {
          return reply.code(err.statusCode).send({
            success: false,
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    }
  );

  /**
   * GET /api/v1/devices/pair/pending
   * Lists pending claimed pairings awaiting workspace admin approval.
   */
  fastify.get<{ Querystring: { workspaceId?: string } }>(
    "/devices/pair/pending",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const workspaceId = request.query.workspaceId;
      if (!workspaceId) {
        return reply.code(422).send({
          success: false,
          error: { code: "VALIDATION_ERROR", message: "workspaceId query parameter is required." },
        });
      }

      try {
        const result = await devicePairingService.getPendingChallenges(workspaceId, request.user.id);
        return reply.code(200).send({
          success: true,
          data: result,
        });
      } catch (err: unknown) {
        if (err instanceof DevicePairingError) {
          return reply.code(err.statusCode).send({
            success: false,
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    }
  );

  /**
   * POST /api/v1/devices/pair/:challengeId/approve
   * Workspace OWNER or ADMIN approves device registration, transitioning status to ACTIVE.
   */
  fastify.post<{ Params: { challengeId: string }; Body: unknown }>(
    "/devices/pair/:challengeId/approve",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const parseResult = ApprovePairingSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(422).send({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: parseResult.error.errors[0]?.message || "Invalid approve payload",
          },
        });
      }

      try {
        const device = await devicePairingService.approvePairing(
          request.params.challengeId,
          parseResult.data.workspaceId,
          request.user.id
        );
        return reply.code(200).send({
          success: true,
          data: device,
        });
      } catch (err: unknown) {
        if (err instanceof DevicePairingError) {
          return reply.code(err.statusCode).send({
            success: false,
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    }
  );

  /**
   * POST /api/v1/devices/pair/:challengeId/reject
   * Workspace OWNER or ADMIN rejects device registration.
   */
  fastify.post<{ Params: { challengeId: string }; Body: unknown }>(
    "/devices/pair/:challengeId/reject",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const parseResult = RejectPairingSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(422).send({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: parseResult.error.errors[0]?.message || "Invalid reject payload",
          },
        });
      }

      try {
        const result = await devicePairingService.rejectPairing(
          request.params.challengeId,
          parseResult.data.workspaceId,
          request.user.id,
          parseResult.data.reason
        );
        return reply.code(200).send({
          success: true,
          data: result,
        });
      } catch (err: unknown) {
        if (err instanceof DevicePairingError) {
          return reply.code(err.statusCode).send({
            success: false,
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    }
  );

  /**
   * GET /api/v1/devices
   * Lists devices for a workspace with computed online status.
   */
  fastify.get<{ Querystring: { workspaceId?: string } }>(
    "/devices",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const workspaceId = request.query.workspaceId;
      if (!workspaceId) {
        return reply.code(422).send({
          success: false,
          error: { code: "VALIDATION_ERROR", message: "workspaceId query parameter is required." },
        });
      }

      try {
        const result = await deviceManagementService.listDevices(workspaceId, request.user.id);
        return reply.code(200).send({
          success: true,
          data: result,
        });
      } catch (err: unknown) {
        if (err instanceof DeviceManagementError) {
          return reply.code(err.statusCode).send({
            success: false,
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    }
  );

  /**
   * GET /api/v1/devices/:deviceId
   * Retrieves single device detail with recent connection sessions.
   */
  fastify.get<{ Params: { deviceId: string }; Querystring: { workspaceId?: string } }>(
    "/devices/:deviceId",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const workspaceId = request.query.workspaceId;
      if (!workspaceId) {
        return reply.code(422).send({
          success: false,
          error: { code: "VALIDATION_ERROR", message: "workspaceId query parameter is required." },
        });
      }

      try {
        const result = await deviceManagementService.getDevice(
          request.params.deviceId,
          workspaceId,
          request.user.id
        );
        return reply.code(200).send({
          success: true,
          data: result,
        });
      } catch (err: unknown) {
        if (err instanceof DeviceManagementError) {
          return reply.code(err.statusCode).send({
            success: false,
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    }
  );

  /**
   * PATCH /api/v1/devices/:deviceId/rename
   * Renames a device.
   */
  fastify.patch<{ Params: { deviceId: string }; Body: unknown }>(
    "/devices/:deviceId/rename",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const parseResult = RenameDeviceSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(422).send({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: parseResult.error.errors[0]?.message || "Invalid rename payload",
          },
        });
      }

      try {
        const result = await deviceManagementService.renameDevice(
          request.params.deviceId,
          parseResult.data.workspaceId,
          request.user.id,
          parseResult.data.displayName
        );
        return reply.code(200).send({
          success: true,
          data: result,
        });
      } catch (err: unknown) {
        if (err instanceof DeviceManagementError) {
          return reply.code(err.statusCode).send({
            success: false,
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    }
  );

  /**
   * POST /api/v1/devices/:deviceId/pause
   * Pauses an active device.
   */
  fastify.post<{ Params: { deviceId: string }; Body: unknown }>(
    "/devices/:deviceId/pause",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const parseResult = DeviceActionSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(422).send({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: parseResult.error.errors[0]?.message || "Invalid action payload",
          },
        });
      }

      try {
        const result = await deviceManagementService.pauseDevice(
          request.params.deviceId,
          parseResult.data.workspaceId,
          request.user.id
        );
        deviceConnectionGateway.disconnectDevice(request.params.deviceId, "Device paused by administrator", 4403);

        return reply.code(200).send({
          success: true,
          data: result,
        });
      } catch (err: unknown) {
        if (err instanceof DeviceManagementError) {
          return reply.code(err.statusCode).send({
            success: false,
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    }
  );

  /**
   * POST /api/v1/devices/:deviceId/resume
   * Resumes a paused device.
   */
  fastify.post<{ Params: { deviceId: string }; Body: unknown }>(
    "/devices/:deviceId/resume",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const parseResult = DeviceActionSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(422).send({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: parseResult.error.errors[0]?.message || "Invalid action payload",
          },
        });
      }

      try {
        const result = await deviceManagementService.resumeDevice(
          request.params.deviceId,
          parseResult.data.workspaceId,
          request.user.id
        );
        return reply.code(200).send({
          success: true,
          data: result,
        });
      } catch (err: unknown) {
        if (err instanceof DeviceManagementError) {
          return reply.code(err.statusCode).send({
            success: false,
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    }
  );

  /**
   * POST /api/v1/devices/:deviceId/revoke
   * Permanently revokes a device.
   */
  fastify.post<{ Params: { deviceId: string }; Body: unknown }>(
    "/devices/:deviceId/revoke",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const parseResult = DeviceActionSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(422).send({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: parseResult.error.errors[0]?.message || "Invalid action payload",
          },
        });
      }

      try {
        const result = await deviceManagementService.revokeDevice(
          request.params.deviceId,
          parseResult.data.workspaceId,
          request.user.id
        );
        deviceConnectionGateway.disconnectDevice(request.params.deviceId, "Device permanently revoked by administrator", 4403);

        return reply.code(200).send({
          success: true,
          data: result,
        });
      } catch (err: unknown) {
        if (err instanceof DeviceManagementError) {
          return reply.code(err.statusCode).send({
            success: false,
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    }
  );
};
