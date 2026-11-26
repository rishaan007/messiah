import crypto from "node:crypto";
import * as webpushNs from "web-push";

const webpush = ((webpushNs as unknown as { default?: typeof import("web-push") }).default ??
  webpushNs) as unknown as typeof import("web-push");
import { prisma, type NotificationCategory, type Prisma } from "@messiah/db";
import type {
  AuditLogEntryInfo,
  MarkNotificationsReadDto,
  NotificationDeviceInfo,
  NotificationItemInfo,
  NotificationPreferenceInfo,
  RegisterNotificationDeviceDto,
  UnifiedApprovalItem,
  UpdateNotificationPreferencesDto,
} from "@messiah/shared";
import { workspaceService } from "../workspaceService.js";
import { logAuditEvent } from "../auditService.js";
import { notificationStreamPublisher } from "./notificationStreamPublisher.js";

export class NotificationServiceError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "NotificationServiceError";
  }
}

const SECRET_PREVIEW_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{12,}/g,
  /AIza[a-zA-Z0-9_-]{16,}/g,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(postgresql|postgres|mysql|redis|rediss|amqp):\/\/[^:\s]+:[^@\s]+@[^\s]+/gi,
];

/**
 * Strips credentials/secrets and bounds notification preview length so no sensitive
 * arguments or tokens ever appear in browser, OS, or push notification banners.
 */
export function sanitizeNotificationPreview(raw: string, maxLen = 240): string {
  let clean = String(raw || "").trim();
  for (const pat of SECRET_PREVIEW_PATTERNS) {
    clean = clean.replace(pat, "[REDACTED]");
  }
  clean = clean.replace(/\s+/g, " ");
  if (clean.length > maxLen) {
    return `${clean.slice(0, maxLen - 3)}...`;
  }
  return clean;
}

function isWithinQuietHours(start?: string | null, end?: string | null, now = new Date()): boolean {
  if (!start || !end) return false;
  const hhmm = `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;
  if (start <= end) {
    return hhmm >= start && hhmm <= end;
  }
  return hhmm >= start || hhmm <= end;
}

function formatNotificationItem(row: {
  id: string;
  workspaceId: string;
  recipientUserId: string;
  category: NotificationCategory;
  title: string;
  preview: string;
  resourceType: string;
  resourceId: string;
  deepLink: string;
  metadata: unknown;
  expiresAt: Date | null;
  readAt: Date | null;
  createdAt: Date;
}): NotificationItemInfo {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    recipientUserId: row.recipientUserId,
    category: row.category,
    title: row.title,
    preview: row.preview,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    deepLink: row.deepLink,
    metadata: (row.metadata as Record<string, unknown>) || {},
    expiresAt: row.expiresAt?.toISOString() ?? null,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

let vapidConfigured = false;
function ensureVapidConfigured(): boolean {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subj = process.env.VAPID_SUBJECT || "mailto:security@messiah.local";
  if (!pub || !priv) return false;
  if (!vapidConfigured) {
    try {
      webpush.setVapidDetails(subj, pub, priv);
      vapidConfigured = true;
    } catch {
      return false;
    }
  }
  return true;
}

export class NotificationService {
  public async getPreferences(workspaceId: string, userId: string): Promise<NotificationPreferenceInfo> {
    const isMember = await workspaceService.isUserMember(workspaceId, userId);
    if (!isMember) {
      throw new NotificationServiceError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }

    let pref = await prisma.notificationPreference.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
    });

    if (!pref) {
      pref = await prisma.notificationPreference.create({
        data: { userId, workspaceId },
      });
    }

    return {
      id: pref.id,
      userId: pref.userId,
      workspaceId: pref.workspaceId,
      inAppEnabled: pref.inAppEnabled,
      webPushEnabled: pref.webPushEnabled,
      desktopEnabled: pref.desktopEnabled,
      mobilePushEnabled: pref.mobilePushEnabled,
      notifyApprovals: pref.notifyApprovals,
      notifyCompletions: pref.notifyCompletions,
      notifyFailures: pref.notifyFailures,
      notifyDeviceStatus: pref.notifyDeviceStatus,
      quietHoursStart: pref.quietHoursStart,
      quietHoursEnd: pref.quietHoursEnd,
      updatedAt: pref.updatedAt.toISOString(),
    };
  }

  public async updatePreferences(
    userId: string,
    dto: UpdateNotificationPreferencesDto
  ): Promise<NotificationPreferenceInfo> {
    const isMember = await workspaceService.isUserMember(dto.workspaceId, userId);
    if (!isMember) {
      throw new NotificationServiceError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }

    const pref = await prisma.notificationPreference.upsert({
      where: { userId_workspaceId: { userId, workspaceId: dto.workspaceId } },
      create: {
        userId,
        workspaceId: dto.workspaceId,
        inAppEnabled: dto.inAppEnabled ?? true,
        webPushEnabled: dto.webPushEnabled ?? true,
        desktopEnabled: dto.desktopEnabled ?? true,
        mobilePushEnabled: dto.mobilePushEnabled ?? true,
        notifyApprovals: dto.notifyApprovals ?? true,
        notifyCompletions: dto.notifyCompletions ?? true,
        notifyFailures: dto.notifyFailures ?? true,
        notifyDeviceStatus: dto.notifyDeviceStatus ?? true,
        quietHoursStart: dto.quietHoursStart ?? null,
        quietHoursEnd: dto.quietHoursEnd ?? null,
      },
      update: {
        ...(dto.inAppEnabled !== undefined ? { inAppEnabled: dto.inAppEnabled } : {}),
        ...(dto.webPushEnabled !== undefined ? { webPushEnabled: dto.webPushEnabled } : {}),
        ...(dto.desktopEnabled !== undefined ? { desktopEnabled: dto.desktopEnabled } : {}),
        ...(dto.mobilePushEnabled !== undefined ? { mobilePushEnabled: dto.mobilePushEnabled } : {}),
        ...(dto.notifyApprovals !== undefined ? { notifyApprovals: dto.notifyApprovals } : {}),
        ...(dto.notifyCompletions !== undefined ? { notifyCompletions: dto.notifyCompletions } : {}),
        ...(dto.notifyFailures !== undefined ? { notifyFailures: dto.notifyFailures } : {}),
        ...(dto.notifyDeviceStatus !== undefined ? { notifyDeviceStatus: dto.notifyDeviceStatus } : {}),
        ...(dto.quietHoursStart !== undefined ? { quietHoursStart: dto.quietHoursStart } : {}),
        ...(dto.quietHoursEnd !== undefined ? { quietHoursEnd: dto.quietHoursEnd } : {}),
      },
    });

    return {
      id: pref.id,
      userId: pref.userId,
      workspaceId: pref.workspaceId,
      inAppEnabled: pref.inAppEnabled,
      webPushEnabled: pref.webPushEnabled,
      desktopEnabled: pref.desktopEnabled,
      mobilePushEnabled: pref.mobilePushEnabled,
      notifyApprovals: pref.notifyApprovals,
      notifyCompletions: pref.notifyCompletions,
      notifyFailures: pref.notifyFailures,
      notifyDeviceStatus: pref.notifyDeviceStatus,
      quietHoursStart: pref.quietHoursStart,
      quietHoursEnd: pref.quietHoursEnd,
      updatedAt: pref.updatedAt.toISOString(),
    };
  }

  public async registerDevice(userId: string, dto: RegisterNotificationDeviceDto): Promise<NotificationDeviceInfo> {
    if (dto.workspaceId) {
      const isMember = await workspaceService.isUserMember(dto.workspaceId, userId);
      if (!isMember) {
        throw new NotificationServiceError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
      }
    }

    if (dto.pushProvider === "webpush") {
      if (!dto.pushEndpoint || !dto.pushP256dh || !dto.pushAuth) {
        throw new NotificationServiceError(
          422,
          "INVALID_WEBPUSH_SUBSCRIPTION",
          "Web Push registration requires pushEndpoint, pushP256dh, and pushAuth."
        );
      }
      const parsed = new URL(dto.pushEndpoint);
      if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
        throw new NotificationServiceError(422, "INSECURE_PUSH_ENDPOINT", "Web Push endpoints must use HTTPS.");
      }
    }

    const identitySeed =
      dto.pushEndpoint ||
      dto.nativePushToken ||
      `${dto.platform}:${dto.deviceLabel}`;

    const subscriptionHash = crypto
      .createHash("sha256")
      .update(`${userId}:${dto.pushProvider}:${identitySeed}`)
      .digest("hex");

    const device = await prisma.notificationDevice.upsert({
      where: { subscriptionHash },
      create: {
        userId,
        workspaceId: dto.workspaceId || null,
        platform: dto.platform,
        deviceLabel: dto.deviceLabel,
        pushProvider: dto.pushProvider,
        subscriptionHash,
        pushEndpoint: dto.pushEndpoint || null,
        pushP256dh: dto.pushP256dh || null,
        pushAuth: dto.pushAuth || null,
        nativePushToken: dto.nativePushToken || null,
        appVersion: dto.appVersion || null,
        isActive: true,
        revokedAt: null,
        lastSeenAt: new Date(),
      },
      update: {
        workspaceId: dto.workspaceId ?? undefined,
        deviceLabel: dto.deviceLabel,
        pushEndpoint: dto.pushEndpoint ?? undefined,
        pushP256dh: dto.pushP256dh ?? undefined,
        pushAuth: dto.pushAuth ?? undefined,
        nativePushToken: dto.nativePushToken ?? undefined,
        appVersion: dto.appVersion ?? undefined,
        isActive: true,
        revokedAt: null,
        lastSeenAt: new Date(),
      },
    });

    if (dto.workspaceId) {
      await logAuditEvent({
        workspaceId: dto.workspaceId,
        actorId: userId,
        action: "notification_device.registered",
        resourceType: "notification_device",
        resourceId: device.id,
        details: { platform: dto.platform, pushProvider: dto.pushProvider, label: dto.deviceLabel },
      });
    }

    return {
      id: device.id,
      userId: device.userId,
      workspaceId: device.workspaceId,
      platform: device.platform,
      deviceLabel: device.deviceLabel,
      pushProvider: device.pushProvider,
      appVersion: device.appVersion,
      isActive: device.isActive,
      lastSeenAt: device.lastSeenAt.toISOString(),
      revokedAt: device.revokedAt?.toISOString() ?? null,
      createdAt: device.createdAt.toISOString(),
    };
  }

  public async listDevices(userId: string): Promise<NotificationDeviceInfo[]> {
    const devices = await prisma.notificationDevice.findMany({
      where: { userId },
      orderBy: { lastSeenAt: "desc" },
    });

    return devices.map((d) => ({
      id: d.id,
      userId: d.userId,
      workspaceId: d.workspaceId,
      platform: d.platform,
      deviceLabel: d.deviceLabel,
      pushProvider: d.pushProvider,
      appVersion: d.appVersion,
      isActive: d.isActive,
      lastSeenAt: d.lastSeenAt.toISOString(),
      revokedAt: d.revokedAt?.toISOString() ?? null,
      createdAt: d.createdAt.toISOString(),
    }));
  }

  public async revokeDevice(userId: string, deviceId: string): Promise<void> {
    const existing = await prisma.notificationDevice.findUnique({ where: { id: deviceId } });
    if (!existing || existing.userId !== userId) {
      throw new NotificationServiceError(404, "NOTIFICATION_DEVICE_NOT_FOUND", "Registered device not found.");
    }

    await prisma.notificationDevice.update({
      where: { id: deviceId },
      data: { isActive: false, revokedAt: new Date() },
    });

    if (existing.workspaceId) {
      await logAuditEvent({
        workspaceId: existing.workspaceId,
        actorId: userId,
        action: "notification_device.revoked",
        resourceType: "notification_device",
        resourceId: deviceId,
        details: { platform: existing.platform },
      });
    }
  }

  public async listNotifications(params: {
    workspaceId: string;
    userId: string;
    unreadOnly?: boolean;
    limit?: number;
  }): Promise<{ notifications: NotificationItemInfo[]; unreadCount: number }> {
    const isMember = await workspaceService.isUserMember(params.workspaceId, params.userId);
    if (!isMember) {
      throw new NotificationServiceError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }

    const [items, unreadCount] = await Promise.all([
      prisma.notificationItem.findMany({
        where: {
          workspaceId: params.workspaceId,
          recipientUserId: params.userId,
          ...(params.unreadOnly ? { readAt: null } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: Math.min(params.limit || 50, 100),
      }),
      prisma.notificationItem.count({
        where: {
          workspaceId: params.workspaceId,
          recipientUserId: params.userId,
          readAt: null,
        },
      }),
    ]);

    return {
      notifications: items.map(formatNotificationItem),
      unreadCount,
    };
  }

  public async markRead(userId: string, dto: MarkNotificationsReadDto): Promise<{ updated: number }> {
    const isMember = await workspaceService.isUserMember(dto.workspaceId, userId);
    if (!isMember) {
      throw new NotificationServiceError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }

    const res = await prisma.notificationItem.updateMany({
      where: {
        workspaceId: dto.workspaceId,
        recipientUserId: userId,
        readAt: null,
        ...(!dto.markAll && dto.notificationIds && dto.notificationIds.length > 0
          ? { id: { in: dto.notificationIds } }
          : {}),
      },
      data: { readAt: new Date() },
    });

    return { updated: res.count };
  }

  /**
   * Emits workspace-aware privacy-scrubbed notifications with database duplicate suppression,
   * real-time WebSocket publishing, and Web Push delivery when configured.
   */
  public async emitWorkspaceNotification(params: {
    workspaceId: string;
    category: NotificationCategory;
    title: string;
    preview: string;
    resourceType: string;
    resourceId: string;
    deepLink: string;
    dedupKey: string;
    expiresAt?: Date | null;
    metadata?: Record<string, unknown>;
    approversOnly?: boolean;
    specificUserId?: string | null;
  }): Promise<{ createdCount: number }> {
    const sanitizedPreview = sanitizeNotificationPreview(params.preview);
    const sanitizedTitle = sanitizeNotificationPreview(params.title, 150);

    // Ensure deepLink stays strictly relative app path (prevents open redirects)
    const safeDeepLink = params.deepLink.startsWith("/") ? params.deepLink.slice(0, 250) : "/";

    let recipientUserIds: string[] = [];
    if (params.specificUserId) {
      const role = await workspaceService.getWorkspaceMembership(params.specificUserId, params.workspaceId);
      if (role) recipientUserIds = [params.specificUserId];
    } else {
      const members = await prisma.workspaceMember.findMany({
        where: {
          workspaceId: params.workspaceId,
          ...(params.approversOnly ? { role: { in: ["OWNER", "ADMIN"] } } : {}),
        },
        select: { userId: true },
      });
      recipientUserIds = members.map((m) => m.userId);
    }

    if (recipientUserIds.length === 0) return { createdCount: 0 };

    const prefs = await prisma.notificationPreference.findMany({
      where: {
        workspaceId: params.workspaceId,
        userId: { in: recipientUserIds },
      },
    });
    const prefByUser = new Map(prefs.map((p) => [p.userId, p]));

    let createdCount = 0;
    const pushTargets: string[] = [];

    for (const recipientUserId of recipientUserIds) {
      const pref = prefByUser.get(recipientUserId);
      if (pref) {
        if (!pref.inAppEnabled) continue;
        if (params.category.endsWith("_APPROVAL") && !pref.notifyApprovals) continue;
        if (params.category.endsWith("_COMPLETED") && !pref.notifyCompletions) continue;
        if (params.category.endsWith("_FAILED") && !pref.notifyFailures) continue;
        if (params.category === "DEVICE_STATUS" && !pref.notifyDeviceStatus) continue;
        if (isWithinQuietHours(pref.quietHoursStart, pref.quietHoursEnd)) continue;
      }

      try {
        const created = await prisma.notificationItem.create({
          data: {
            workspaceId: params.workspaceId,
            recipientUserId,
            category: params.category,
            title: sanitizedTitle,
            preview: sanitizedPreview,
            resourceType: params.resourceType,
            resourceId: params.resourceId,
            deepLink: safeDeepLink,
            dedupKey: params.dedupKey.slice(0, 160),
            metadata: (params.metadata || {}) as Prisma.InputJsonValue,
            expiresAt: params.expiresAt || null,
          },
        });
        createdCount++;
        pushTargets.push(recipientUserId);

        const formatted = formatNotificationItem(created);
        await notificationStreamPublisher.publish({
          type: "notification.created",
          workspaceId: params.workspaceId,
          recipientUserId,
          notification: formatted,
          timestamp: new Date().toISOString(),
        });
      } catch (err: unknown) {
        // Unique constraint on (recipientUserId, dedupKey) cleanly suppresses duplicate notifications
        if ((err as { code?: string })?.code === "P2002") {
          continue;
        }
      }
    }

    // Dispatch Web Push if VAPID keys are configured
    if (pushTargets.length > 0 && ensureVapidConfigured()) {
      const webPushDevices = await prisma.notificationDevice.findMany({
        where: {
          userId: { in: pushTargets },
          isActive: true,
          pushProvider: "webpush",
          pushEndpoint: { not: null },
          pushP256dh: { not: null },
          pushAuth: { not: null },
        },
      });

      const payloadStr = JSON.stringify({
        title: sanitizedTitle,
        body: sanitizedPreview,
        deepLink: safeDeepLink,
        category: params.category,
        resourceType: params.resourceType,
        resourceId: params.resourceId,
      });

      await Promise.all(
        webPushDevices.map(async (dev) => {
          const userPref = prefByUser.get(dev.userId);
          if (userPref && !userPref.webPushEnabled) return;
          try {
            await webpush.sendNotification(
              {
                endpoint: dev.pushEndpoint!,
                keys: {
                  p256dh: dev.pushP256dh!,
                  auth: dev.pushAuth!,
                },
              },
              payloadStr
            );
          } catch (err: unknown) {
            const status = (err as { statusCode?: number })?.statusCode;
            if (status === 404 || status === 410) {
              await prisma.notificationDevice
                .update({
                  where: { id: dev.id },
                  data: { isActive: false, revokedAt: new Date() },
                })
                .catch(() => {});
            }
          }
        })
      );
    }

    return { createdCount };
  }

  /**
   * Aggregates all pending Human-in-the-Loop approvals across MCP tools,
   * Local Bridge workstation tasks, Swarm plans, and Workflow approval gates.
   */
  public async listUnifiedPendingApprovals(
    workspaceId: string,
    userId: string
  ): Promise<UnifiedApprovalItem[]> {
    const isMember = await workspaceService.isUserMember(workspaceId, userId);
    if (!isMember) {
      throw new NotificationServiceError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }

    const [toolApprovals, bridgeApprovals, workflowApprovals, swarmPlans] = await Promise.all([
      prisma.toolApproval.findMany({
        where: { workspaceId, status: "PENDING" },
        include: {
          toolCall: {
            select: {
              id: true,
              toolName: true,
              threadId: true,
              generationRunId: true,
              argumentsPreview: true,
              connection: { select: { name: true, endpointUrl: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      prisma.bridgeTaskApproval.findMany({
        where: { workspaceId, status: "PENDING" },
        include: {
          device: { select: { displayName: true, platform: true } },
          task: { select: { id: true, capability: true, threadId: true, agentRunId: true, workflowRunId: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      prisma.workflowApproval.findMany({
        where: { workspaceId, status: "PENDING" },
        include: {
          workflow: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      prisma.agentRun.findMany({
        where: { workspaceId, status: "AWAITING_PLAN_APPROVAL" },
        include: {
          supervisorAgent: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 25,
      }),
    ]);

    const items: UnifiedApprovalItem[] = [];

    for (const ta of toolApprovals) {
      items.push({
        id: ta.id,
        kind: "MCP_TOOL",
        workspaceId,
        title: `Approve MCP Tool: ${ta.toolCall.toolName}`,
        summary: `Remote tool on ${ta.toolCall.connection.name} awaiting authorization.`,
        status: ta.status,
        expiresAt: ta.expiresAt.toISOString(),
        createdAt: ta.createdAt.toISOString(),
        deepLink: ta.toolCall.threadId ? `/chat/${ta.toolCall.threadId}` : `/approvals`,
        resourceId: ta.id,
        parentRunId: ta.toolCall.generationRunId,
        threadId: ta.toolCall.threadId,
        toolName: ta.toolCall.toolName,
        previewDetails: {
          endpointUrl: ta.toolCall.connection.endpointUrl,
          argumentsPreview: ta.toolCall.argumentsPreview as Record<string, unknown>,
          argumentsHash: ta.argumentsHash,
          schemaHash: ta.schemaHash,
        },
      });
    }

    for (const ba of bridgeApprovals) {
      items.push({
        id: ba.taskId,
        kind: "BRIDGE_TASK",
        workspaceId,
        title: `Approve Workstation Action: ${ba.capability || ba.operation}`,
        summary: sanitizeNotificationPreview(ba.summary),
        status: ba.status,
        expiresAt: ba.expiresAt.toISOString(),
        createdAt: ba.createdAt.toISOString(),
        deepLink: ba.task.workflowRunId
          ? `/workflows/runs/${ba.task.workflowRunId}`
          : ba.task.agentRunId
          ? `/swarms/${ba.task.agentRunId}`
          : ba.task.threadId
          ? `/chat/${ba.task.threadId}`
          : `/approvals`,
        resourceId: ba.taskId,
        parentRunId: ba.task.agentRunId || ba.task.workflowRunId,
        threadId: ba.task.threadId,
        deviceName: ba.device.displayName,
        capability: ba.capability || ba.operation,
        previewDetails: (ba.details as Record<string, unknown>) || {},
      });
    }

    for (const wa of workflowApprovals) {
      items.push({
        id: wa.id,
        kind: "WORKFLOW_GATE",
        workspaceId,
        title: wa.title,
        summary: sanitizeNotificationPreview(wa.summary),
        status: wa.status,
        expiresAt: wa.expiresAt.toISOString(),
        createdAt: wa.createdAt.toISOString(),
        deepLink: `/workflows/runs/${wa.runId}`,
        resourceId: wa.id,
        parentRunId: wa.runId,
        previewDetails: {
          workflowName: wa.workflow.name,
          nodeId: wa.nodeId,
          contextPreview: wa.contextPreview,
        },
      });
    }

    for (const sr of swarmPlans) {
      items.push({
        id: sr.id,
        kind: "SWARM_PLAN",
        workspaceId,
        title: `Approve Swarm Plan (${sr.supervisorAgent.name})`,
        summary: sanitizeNotificationPreview(sr.objective),
        status: sr.status,
        expiresAt: null,
        createdAt: sr.createdAt.toISOString(),
        deepLink: `/swarms/${sr.id}`,
        resourceId: sr.id,
        parentRunId: sr.id,
        threadId: sr.threadId,
        previewDetails: {
          objective: sanitizeNotificationPreview(sr.objective, 200),
          maxTotalTokens: sr.maxTotalTokens,
          maxCostUsd: sr.maxCostUsd,
        },
      });
    }

    items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return items;
  }

  public async listAuditLogs(params: {
    workspaceId: string;
    userId: string;
    action?: string;
    resourceType?: string;
    limit?: number;
    cursor?: string;
  }): Promise<AuditLogEntryInfo[]> {
    const role = await workspaceService.getWorkspaceMembership(params.userId, params.workspaceId);
    if (!role) {
      throw new NotificationServiceError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }
    if (role === "VIEWER") {
      throw new NotificationServiceError(
        403,
        "FORBIDDEN_ROLE",
        "Workspace audit logs require MEMBER, ADMIN, or OWNER permissions."
      );
    }

    const logs = await prisma.auditLog.findMany({
      where: {
        workspaceId: params.workspaceId,
        ...(params.action ? { action: params.action } : {}),
        ...(params.resourceType ? { resourceType: params.resourceType } : {}),
      },
      include: {
        actor: {
          select: { email: true, fullName: true },
        },
      },
      orderBy: { createdAt: "desc" },
      take: Math.min(params.limit || 50, 100),
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    });

    return logs.map((l) => ({
      id: l.id,
      workspaceId: l.workspaceId,
      actorId: l.actorId,
      actorEmail: l.actor?.email || null,
      actorName: l.actor?.fullName || null,
      action: l.action,
      resourceType: l.resourceType,
      resourceId: l.resourceId,
      details: (l.details as Record<string, unknown>) || {},
      ipAddress: l.ipAddress,
      createdAt: l.createdAt.toISOString(),
    }));
  }
}

export const notificationService = new NotificationService();
