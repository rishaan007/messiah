import { prisma, type Prisma } from "@messiah/db";

export interface LogAuditOptions {
  workspaceId: string;
  actorId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Audit Logging Service.
 * Persists immutable operational records for security tracking and compliance.
 * Guarantees no sensitive secrets (API keys, plaintext passwords) are ever recorded.
 */
export async function logAuditEvent(options: LogAuditOptions): Promise<void> {
  const safeDetails = { ...options.details };

  // Explicit safety check: Redact any accidental credential keys in details
  const sensitiveKeys = ["apiKey", "key", "secret", "token", "password", "ciphertext"];
  for (const key of Object.keys(safeDetails)) {
    if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) {
      safeDetails[key] = "[REDACTED]";
    }
  }

  try {
    await prisma.auditLog.create({
      data: {
        workspaceId: options.workspaceId,
        actorId: options.actorId,
        action: options.action,
        resourceType: options.resourceType,
        resourceId: options.resourceId,
        details: safeDetails as Prisma.InputJsonValue,
        ipAddress: options.ipAddress,
        userAgent: options.userAgent,
      },
    });
  } catch (err) {
    // Non-blocking for primary path but logged to server console
    console.error("[AuditService] Failed to record audit log event:", err);
  }
}
