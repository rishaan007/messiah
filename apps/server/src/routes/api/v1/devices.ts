import type { FastifyPluginAsync } from "fastify";
import type { WebSocket } from "ws";
import {
  CreatePairingChallengeSchema,
  ClaimPairingChallengeSchema,
  ApprovePairingSchema,
  RejectPairingSchema,
  RenameDeviceSchema,
  DeviceActionSchema,
  CreateBridgeTaskSchema,
  BridgeTaskDecisionSchema,
  ConfigureDevicePolicySchema,
  RegisterLocalMcpServerSchema,
} from "@messiah/shared";
import {
  devicePairingService,
  deviceManagementService,
  deviceConnectionGateway,
  deviceTaskService,
  DevicePairingError,
  DeviceManagementError,
  DeviceTaskError,
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

  /**
   * POST /api/v1/devices/:deviceId/rotate-key
   * Rotates a device's unique 256-bit HMAC task signing key and terminates current WSS session
   * so the bridge picks up the new versioned key on reconnect.
   */
  fastify.post<{ Params: { deviceId: string }; Body: unknown }>(
    "/devices/:deviceId/rotate-key",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const parseResult = DeviceActionSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(422).send({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: parseResult.error.errors[0]?.message || "Invalid request payload",
          },
        });
      }

      try {
        const result = await deviceManagementService.rotateDeviceTaskKey(
          request.params.deviceId,
          parseResult.data.workspaceId,
          request.user.id
        );
        deviceConnectionGateway.disconnectDevice(
          request.params.deviceId,
          "Device HMAC signing key rotated by administrator",
          4000
        );
        return reply.code(200).send({ success: true, data: result });
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
   * GET /api/v1/devices/:deviceId/capabilities
   * Fetches capabilities, allowed project roots, policy, and registered local MCP servers.
   */
  fastify.get<{ Params: { deviceId: string }; Querystring: { workspaceId?: string } }>(
    "/devices/:deviceId/capabilities",
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
        const result = await deviceManagementService.getDeviceCapabilities(
          request.params.deviceId,
          workspaceId,
          request.user.id
        );
        return reply.code(200).send({ success: true, data: result });
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
   * POST /api/v1/devices/:deviceId/policy
   * Updates device execution policy, allowed project roots, and enabled capabilities.
   */
  fastify.post<{ Params: { deviceId: string }; Body: unknown }>(
    "/devices/:deviceId/policy",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const parseResult = ConfigureDevicePolicySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(422).send({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: parseResult.error.errors[0]?.message || "Invalid policy payload",
          },
        });
      }

      try {
        const result = await deviceManagementService.updateDevicePolicy(
          request.params.deviceId,
          parseResult.data.workspaceId,
          request.user.id,
          {
            allowedRoots: parseResult.data.allowedRoots,
            capabilities: parseResult.data.capabilities,
            devicePolicy: parseResult.data.devicePolicy as any,
          }
        );
        return reply.code(200).send({ success: true, data: result });
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
   * GET /api/v1/devices/:deviceId/mcp
   * Lists local MCP stdio servers registered for this device.
   */
  fastify.get<{ Params: { deviceId: string }; Querystring: { workspaceId?: string } }>(
    "/devices/:deviceId/mcp",
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
        const result = await deviceManagementService.listLocalMcpServers(
          request.params.deviceId,
          workspaceId,
          request.user.id
        );
        return reply.code(200).send({ success: true, data: result });
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
   * POST /api/v1/devices/:deviceId/mcp
   * Registers a new local stdio MCP server for the bridge daemon.
   */
  fastify.post<{ Params: { deviceId: string }; Body: unknown }>(
    "/devices/:deviceId/mcp",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const parseResult = RegisterLocalMcpServerSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(422).send({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: parseResult.error.errors[0]?.message || "Invalid local MCP payload",
          },
        });
      }

      try {
        const result = await deviceManagementService.registerLocalMcpServer(
          request.params.deviceId,
          parseResult.data.workspaceId,
          request.user.id,
          parseResult.data
        );
        return reply.code(201).send({ success: true, data: result });
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
   * POST /api/v1/devices/:deviceId/tasks
   * Creates and cryptographically authorizes a task to execute on the workstation.
   */
  fastify.post<{ Params: { deviceId: string }; Body: unknown }>(
    "/devices/:deviceId/tasks",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const parseResult = CreateBridgeTaskSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(422).send({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: parseResult.error.errors[0]?.message || "Invalid task request payload",
          },
        });
      }

      try {
        const result = await deviceTaskService.createAndDispatchTask({
          workspaceId: parseResult.data.workspaceId,
          userId: request.user.id,
          deviceId: request.params.deviceId,
          capability: parseResult.data.capability,
          resourceScopes: parseResult.data.resourceScopes,
          parameters: parseResult.data.parameters,
          threadId: parseResult.data.threadId,
          generationRunId: parseResult.data.generationRunId,
        });
        return reply.code(201).send({ success: true, data: result });
      } catch (err: unknown) {
        if (err instanceof DeviceTaskError) {
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
   * GET /api/v1/devices/:deviceId/tasks
   * Lists tasks executed or executing on a specific device.
   */
  fastify.get<{ Params: { deviceId: string }; Querystring: { workspaceId?: string; limit?: string } }>(
    "/devices/:deviceId/tasks",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const workspaceId = request.query.workspaceId;
      if (!workspaceId) {
        return reply.code(422).send({
          success: false,
          error: { code: "VALIDATION_ERROR", message: "workspaceId query parameter is required." },
        });
      }
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : 50;

      try {
        const result = await deviceTaskService.listTasks(
          workspaceId,
          request.params.deviceId,
          request.user.id,
          limit
        );
        return reply.code(200).send({ success: true, data: result });
      } catch (err: unknown) {
        if (err instanceof DeviceTaskError) {
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
   * GET /api/v1/devices/tasks/:taskId
   * Retrieves single task details with approval history.
   */
  fastify.get<{ Params: { taskId: string }; Querystring: { workspaceId?: string } }>(
    "/devices/tasks/:taskId",
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
        const result = await deviceTaskService.getTask(
          request.params.taskId,
          workspaceId,
          request.user.id
        );
        return reply.code(200).send({ success: true, data: result });
      } catch (err: unknown) {
        if (err instanceof DeviceTaskError) {
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
   * GET /api/v1/devices/tasks/:taskId/logs
   * Streams execution output chunks from stdout/stderr/system for a task.
   */
  fastify.get<{ Params: { taskId: string }; Querystring: { workspaceId?: string } }>(
    "/devices/tasks/:taskId/logs",
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
        const result = await deviceTaskService.getTaskLogs(
          request.params.taskId,
          workspaceId,
          request.user.id
        );
        return reply.code(200).send({ success: true, data: result });
      } catch (err: unknown) {
        if (err instanceof DeviceTaskError) {
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
   * POST /api/v1/devices/tasks/:taskId/approve
   * Workspace OWNER/ADMIN approves a pending sensitive workstation operation.
   */
  fastify.post<{ Params: { taskId: string }; Body: unknown }>(
    "/devices/tasks/:taskId/approve",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const parseResult = BridgeTaskDecisionSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(422).send({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: parseResult.error.errors[0]?.message || "Invalid approval decision payload",
          },
        });
      }

      try {
        const result = await deviceTaskService.handleApprovalDecision(
          request.params.taskId,
          parseResult.data.workspaceId,
          request.user.id,
          "approve"
        );
        return reply.code(200).send({ success: true, data: result });
      } catch (err: unknown) {
        if (err instanceof DeviceTaskError) {
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
   * POST /api/v1/devices/tasks/:taskId/reject
   * Workspace OWNER/ADMIN rejects a pending sensitive workstation operation.
   */
  fastify.post<{ Params: { taskId: string }; Body: unknown }>(
    "/devices/tasks/:taskId/reject",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const parseResult = BridgeTaskDecisionSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(422).send({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: parseResult.error.errors[0]?.message || "Invalid rejection decision payload",
          },
        });
      }

      try {
        const result = await deviceTaskService.handleApprovalDecision(
          request.params.taskId,
          parseResult.data.workspaceId,
          request.user.id,
          "reject",
          parseResult.data.rejectionReason
        );
        return reply.code(200).send({ success: true, data: result });
      } catch (err: unknown) {
        if (err instanceof DeviceTaskError) {
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
   * POST /api/v1/devices/tasks/:taskId/cancel
   * Cancels an active or queued bridge task.
   */
  fastify.post<{ Params: { taskId: string }; Body: { workspaceId?: string; reason?: string } }>(
    "/devices/tasks/:taskId/cancel",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const body = request.body || {};
      if (!body.workspaceId) {
        return reply.code(422).send({
          success: false,
          error: { code: "VALIDATION_ERROR", message: "workspaceId is required in body." },
        });
      }

      try {
        const result = await deviceTaskService.cancelTask(
          request.params.taskId,
          body.workspaceId,
          request.user.id,
          body.reason
        );
        return reply.code(200).send({ success: true, data: result });
      } catch (err: unknown) {
        if (err instanceof DeviceTaskError) {
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
