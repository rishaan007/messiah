import crypto from "node:crypto";
import { TASK_CONSTANTS } from "@messiah/shared";

export class TaskSignatureVerifier {
  /**
   * Formats the canonical task authorization string that the server signs.
   */
  public static formatTaskAuthPayload(
    taskId: string,
    requestId: string,
    deviceId: string,
    workspaceId: string,
    capability: string,
    resourceScopes: string[],
    argumentsHash: string,
    issuedAt: number,
    expiresAt: number,
    nonce: string,
    policyVersion: string,
    approvalReference?: string
  ): string {
    const scopesSorted = [...resourceScopes].sort().join(",");
    return [
      TASK_CONSTANTS.SIGNING_PREFIX,
      taskId,
      requestId,
      deviceId,
      workspaceId,
      capability,
      scopesSorted,
      argumentsHash,
      issuedAt,
      expiresAt,
      nonce,
      policyVersion,
      approvalReference || "NONE",
    ].join(":");
  }

  /**
   * Verifies the server's cryptographic signature against the canonical task authorization payload.
   * Supports server public key (Ed25519) or shared HMAC verification secret.
   */
  public static verifyTaskSignature(
    payload: string,
    signature: string,
    serverPublicKeyPem: string
  ): boolean {
    try {
      const pubKey = crypto.createPublicKey(serverPublicKeyPem);
      const signatureBuffer = Buffer.from(signature, "base64");
      return crypto.verify(null, Buffer.from(payload, "utf-8"), pubKey, signatureBuffer);
    } catch {
      return false;
    }
  }

  /**
   * Helper to verify HMAC-SHA256 signature when HMAC mode is used.
   */
  public static verifyHmacSignature(
    payload: string,
    signature: string,
    hmacSecret: string
  ): boolean {
    try {
      const expected = crypto.createHmac("sha256", hmacSecret).update(payload).digest("base64");
      return crypto.timingSafeEqual(Buffer.from(signature, "utf-8"), Buffer.from(expected, "utf-8"));
    } catch {
      return false;
    }
  }
}
