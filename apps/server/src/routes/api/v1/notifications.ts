import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  AuditLogQuerySchema,
  MarkNotificationsReadSchema,
  RegisterNotificationDeviceSchema,
  UpdateNotificationPreferencesSchema,
} from "@messiah/shared";
import { NotificationServiceError, notificationService } from "../../../services/notifications/index.js";

const WorkspaceQuerySchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  unreadOnly: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const notificationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", fastify.authenticate);

  const handleError = (err: unknown, reply: any) => {
    if (err instanceof NotificationServiceError) {
      return reply.code(err.statusCode).send({
        success: false,
        error: { code: err.code, message: err.message },
        meta: { timestamp: new Date().toISOString() },
      });
    }
    throw err;
  };

  /**
   * GET /api/v1/notifications/vapid-public-key
   */
  fastify.get("/notifications/vapid-public-key", async (_request, reply) => {
    const publicKey = process.env.VAPID_PUBLIC_KEY || null;
    return reply.code(200).send({
      success: true,
      data: {
        configured: Boolean(publicKey),
        publicKey,
      },
      meta: { timestamp: new Date().toISOString() },
    });
  });

  /**
   * GET /api/v1/notifications?workspaceId=...
   */
  fastify.get("/notifications", async (request, reply) => {
    const query = WorkspaceQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Valid workspaceId query parameter is required." },
      });
    }

    try {
      const result = await notificationService.listNotifications({
        workspaceId: query.data.workspaceId,
        userId: request.user.id,
        unreadOnly: query.data.unreadOnly,
        limit: query.data.limit,
      });
      return reply.code(200).send({
        success: true,
        data: result,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * POST /api/v1/notifications/read
   */
  fastify.post("/notifications/read", async (request, reply) => {
    const body = MarkNotificationsReadSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Invalid mark-read payload.", details: body.error.format() },
      });
    }

    try {
      const result = await notificationService.markRead(request.user.id, body.data);
      return reply.code(200).send({
        success: true,
        data: result,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * GET /api/v1/notifications/preferences?workspaceId=...
   */
  fastify.get("/notifications/preferences", async (request, reply) => {
    const query = WorkspaceQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Valid workspaceId required." },
      });
    }

    try {
      const prefs = await notificationService.getPreferences(query.data.workspaceId, request.user.id);
      return reply.code(200).send({
        success: true,
        data: prefs,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * PUT /api/v1/notifications/preferences
   */
  fastify.put("/notifications/preferences", async (request, reply) => {
    const body = UpdateNotificationPreferencesSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Invalid preferences payload.", details: body.error.format() },
      });
    }

    try {
      const prefs = await notificationService.updatePreferences(request.user.id, body.data);
      return reply.code(200).send({
        success: true,
        data: prefs,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * GET /api/v1/notifications/devices
   */
  fastify.get("/notifications/devices", async (request, reply) => {
    const devices = await notificationService.listDevices(request.user.id);
    return reply.code(200).send({
      success: true,
      data: devices,
      meta: { timestamp: new Date().toISOString() },
    });
  });

  /**
   * POST /api/v1/notifications/devices
   */
  fastify.post("/notifications/devices", async (request, reply) => {
    const body = RegisterNotificationDeviceSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Invalid notification device payload.", details: body.error.format() },
      });
    }

    try {
      const device = await notificationService.registerDevice(request.user.id, body.data);
      return reply.code(201).send({
        success: true,
        data: device,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * DELETE /api/v1/notifications/devices/:deviceId
   */
  fastify.delete("/notifications/devices/:deviceId", async (request, reply) => {
    const params = z.object({ deviceId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Invalid deviceId." },
      });
    }

    try {
      await notificationService.revokeDevice(request.user.id, params.data.deviceId);
      return reply.code(200).send({
        success: true,
        data: { revoked: true },
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * GET /api/v1/approvals?workspaceId=...
   * Unified cross-device Human-in-the-Loop approvals triage queue.
   */
  fastify.get("/approvals", async (request, reply) => {
    const query = WorkspaceQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Valid workspaceId required." },
      });
    }

    try {
      const items = await notificationService.listUnifiedPendingApprovals(
        query.data.workspaceId,
        request.user.id
      );
      return reply.code(200).send({
        success: true,
        data: items,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * GET /api/v1/audit-logs?workspaceId=...
   * Workspace security & governance audit trail viewer.
   */
  fastify.get("/audit-logs", async (request, reply) => {
    const query = AuditLogQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Valid audit log query required.", details: query.error.format() },
      });
    }

    try {
      const logs = await notificationService.listAuditLogs({
        workspaceId: query.data.workspaceId,
        userId: request.user.id,
        action: query.data.action,
        resourceType: query.data.resourceType,
        limit: query.data.limit,
        cursor: query.data.cursor,
      });
      return reply.code(200).send({
        success: true,
        data: logs,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });
};
