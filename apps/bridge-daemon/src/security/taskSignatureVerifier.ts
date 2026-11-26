import crypto from "node:crypto";
import { DEVICE_CONSTANTS, TASK_CONSTANTS } from "@messiah/shared";

export interface TaskAuthEnvelopeFields {
  taskId: string;
  requestId: string;
  deviceId: string;
  workspaceId: string;
  capability: string;
  resourceScopes: string[];
  argumentsHash: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  policyVersion: string;
  approvalReference?: string;
  protocolVersion?: string;
  serverAudience?: string;
  mcpServerName?: string;
  mcpSchemaHash?: string;
  executableIdentity?: string;
}

/**
 * Cryptographic Task Authorization Verifier (Symmetric Per-Device HMAC-SHA256).
 *
 * SECURITY NOTE: Task envelopes use HMAC-SHA256 with a unique 256-bit key provisioned
 * per paired BridgeDevice (not a single global secret and not an asymmetric signature).
 */
export class TaskSignatureVerifier {
  public static readonly CANONICAL_VERSION = "V2";

  /**
   * Formats the versioned, deterministic canonical payload bound to all security-critical task fields.
   */
  public static formatCanonicalPayloadV2(fields: TaskAuthEnvelopeFields): string {
    const scopesSorted = [...fields.resourceScopes].sort().join(",");
    return [
      TASK_CONSTANTS.SIGNING_PREFIX,
      this.CANONICAL_VERSION,
      fields.serverAudience || "messiah-bridge",
      fields.protocolVersion || DEVICE_CONSTANTS.PROTOCOL_VERSION,
      fields.taskId,
      fields.requestId,
      fields.deviceId,
      fields.workspaceId,
      fields.capability,
      scopesSorted,
      fields.argumentsHash,
      fields.issuedAt,
      fields.expiresAt,
      fields.nonce,
      fields.policyVersion,
      fields.approvalReference || "NONE",
      fields.mcpServerName || "NONE",
      fields.mcpSchemaHash || "NONE",
      fields.executableIdentity || "NONE",
    ].join(":");
  }

  /**
   * Constant-time HMAC-SHA256 verification comparing decoded raw 32-byte MAC digests.
   */
  public static verifyHmacSignature(
    payload: string,
    signatureBase64: string,
    deviceHmacSecret: string
  ): boolean {
    if (!deviceHmacSecret || deviceHmacSecret.length < 32) {
      return false;
    }
    try {
      const expectedMac = crypto.createHmac("sha256", deviceHmacSecret).update(payload, "utf-8").digest();
      const providedMac = Buffer.from(signatureBase64, "base64");
      if (providedMac.length !== expectedMac.length) {
        return false;
      }
      return crypto.timingSafeEqual(providedMac, expectedMac);
    } catch {
      return false;
    }
  }
}
