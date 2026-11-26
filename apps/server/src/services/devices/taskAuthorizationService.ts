import crypto from "node:crypto";
import { prisma } from "@messiah/db";
import { DEVICE_CONSTANTS, TASK_CONSTANTS, type DeviceTaskDispatchFrame } from "@messiah/shared";
import { LocalKmsService } from "../vaultService.js";

/**
 * Cryptographic Task Authorization Service (Symmetric Per-Device HMAC-SHA256).
 *
 * SECURITY MODEL:
 * - Each BridgeDevice possesses its own unique 256-bit HMAC signing key, generated via CSPRNG.
 * - No single global shared signing secret is ever used.
 * - Keys are stored encrypted at rest using AES-256-GCM bound to workspaceId, deviceId, and keyVersion.
 * - Keys can be explicitly rotated or revoked by workspace OWNER / ADMIN.
 */
export class TaskAuthorizationService {
  private getKmsKey(): Buffer {
    const kms = new LocalKmsService();
    return kms.getKey("v2");
  }

  private buildAad(workspaceId: string, deviceId: string, keyVersion: number): Buffer {
    return Buffer.from(`messiah:device_hmac:${workspaceId}:${deviceId}:${keyVersion}`, "utf-8");
  }

  private encryptDeviceKey(plaintextKey: string, workspaceId: string, deviceId: string, keyVersion: number): string {
    const kmsKey = this.getKmsKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", kmsKey, iv);
    cipher.setAAD(this.buildAad(workspaceId, deviceId, keyVersion));

    let ciphertext = cipher.update(plaintextKey, "utf-8", "hex");
    ciphertext += cipher.final("hex");
    const tag = cipher.getAuthTag();

    return JSON.stringify({
      v: 1,
      iv: iv.toString("hex"),
      tag: tag.toString("hex"),
      ct: ciphertext,
    });
  }

  private decryptDeviceKey(encryptedJson: string, workspaceId: string, deviceId: string, keyVersion: number): string {
    const kmsKey = this.getKmsKey();
    const parsed = JSON.parse(encryptedJson) as { iv: string; tag: string; ct: string };
    const decipher = crypto.createDecipheriv("aes-256-gcm", kmsKey, Buffer.from(parsed.iv, "hex"));
    decipher.setAuthTag(Buffer.from(parsed.tag, "hex"));
    decipher.setAAD(this.buildAad(workspaceId, deviceId, keyVersion));

    let decrypted = decipher.update(parsed.ct, "hex", "utf-8");
    decrypted += decipher.final("utf-8");
    return decrypted;
  }

  /**
   * Provisions a unique 256-bit HMAC signing key for a device if none exists yet,
   * or decrypts and returns its active signing key.
   */
  public async provisionOrGetDeviceSigningKey(deviceId: string): Promise<{ key: string; version: number }> {
    const device = await prisma.bridgeDevice.findUnique({
      where: { id: deviceId },
      select: {
        id: true,
        workspaceId: true,
        taskSigningKeyEncrypted: true,
        taskKeyVersion: true,
      },
    });

    if (!device) {
      throw new Error(`Device '${deviceId}' not found for signing key provisioning.`);
    }

    if (device.taskSigningKeyEncrypted) {
      const key = this.decryptDeviceKey(
        device.taskSigningKeyEncrypted,
        device.workspaceId,
        device.id,
        device.taskKeyVersion
      );
      return { key, version: device.taskKeyVersion };
    }

    const freshKey = crypto.randomBytes(32).toString("base64");
    const keyVersion = device.taskKeyVersion || 1;
    const encrypted = this.encryptDeviceKey(freshKey, device.workspaceId, device.id, keyVersion);

    await prisma.bridgeDevice.update({
      where: { id: device.id },
      data: {
        taskSigningKeyEncrypted: encrypted,
        taskKeyVersion: keyVersion,
      },
    });

    return { key: freshKey, version: keyVersion };
  }

  /**
   * Rotates a device's unique HMAC signing key, incrementing taskKeyVersion and invalidating old keys.
   */
  public async rotateDeviceSigningKey(deviceId: string): Promise<{ key: string; version: number }> {
    const device = await prisma.bridgeDevice.findUnique({
      where: { id: deviceId },
      select: { id: true, workspaceId: true, taskKeyVersion: true },
    });

    if (!device) {
      throw new Error(`Device '${deviceId}' not found for signing key rotation.`);
    }

    const nextVersion = (device.taskKeyVersion || 1) + 1;
    const freshKey = crypto.randomBytes(32).toString("base64");
    const encrypted = this.encryptDeviceKey(freshKey, device.workspaceId, device.id, nextVersion);

    await prisma.bridgeDevice.update({
      where: { id: device.id },
      data: {
        taskSigningKeyEncrypted: encrypted,
        taskKeyVersion: nextVersion,
      },
    });

    return { key: freshKey, version: nextVersion };
  }

  /**
   * Formats the versioned canonical payload string bound to all security-critical task parameters.
   */
  public formatTaskAuthPayload(params: {
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
  }): string {
    const scopesSorted = [...params.resourceScopes].sort().join(",");
    return [
      TASK_CONSTANTS.SIGNING_PREFIX,
      "V2",
      params.serverAudience || "messiah-bridge",
      params.protocolVersion || DEVICE_CONSTANTS.PROTOCOL_VERSION,
      params.taskId,
      params.requestId,
      params.deviceId,
      params.workspaceId,
      params.capability,
      scopesSorted,
      params.argumentsHash,
      params.issuedAt,
      params.expiresAt,
      params.nonce,
      params.policyVersion,
      params.approvalReference || "NONE",
      params.mcpServerName || "NONE",
      params.mcpSchemaHash || "NONE",
      params.executableIdentity || "NONE",
    ].join(":");
  }

  /**
   * Signs a task authorization payload using the target device's unique 256-bit HMAC key.
   */
  public signTaskPayload(payload: string, deviceHmacSecret: string): string {
    if (!deviceHmacSecret || deviceHmacSecret.length < 32) {
      throw new Error("Invalid per-device HMAC signing secret.");
    }
    return crypto.createHmac("sha256", deviceHmacSecret).update(payload, "utf-8").digest("base64");
  }

  /**
   * Constructs and signs a complete DeviceTaskDispatchFrame using the target device's unique HMAC key.
   */
  public async createSignedTaskEnvelope(params: {
    taskId: string;
    deviceId: string;
    workspaceId: string;
    capability: string;
    resourceScopes: string[];
    parameters: Record<string, unknown>;
    approvalReference?: string;
    ttlMs?: number;
    mcpServerName?: string;
    mcpSchemaHash?: string;
    executableIdentity?: string;
    overrideDeviceKey?: string;
  }): Promise<DeviceTaskDispatchFrame> {
    const issuedAt = Date.now();
    const expiresAt = issuedAt + (params.ttlMs || TASK_CONSTANTS.DEFAULT_TIMEOUT_MS);
    const nonce = crypto.randomBytes(16).toString("hex");
    const requestId = crypto.randomUUID();
    const policyVersion = "2026-08-01";
    const protocolVersion = DEVICE_CONSTANTS.PROTOCOL_VERSION;
    const serverAudience = "messiah-bridge";

    const serializedParams = JSON.stringify(params.parameters);
    const argumentsHash = crypto.createHash("sha256").update(serializedParams).digest("hex");

    const deviceKey =
      params.overrideDeviceKey || (await this.provisionOrGetDeviceSigningKey(params.deviceId)).key;

    const payload = this.formatTaskAuthPayload({
      taskId: params.taskId,
      requestId,
      deviceId: params.deviceId,
      workspaceId: params.workspaceId,
      capability: params.capability,
      resourceScopes: params.resourceScopes,
      argumentsHash,
      issuedAt,
      expiresAt,
      nonce,
      policyVersion,
      approvalReference: params.approvalReference,
      protocolVersion,
      serverAudience,
      mcpServerName: params.mcpServerName,
      mcpSchemaHash: params.mcpSchemaHash,
      executableIdentity: params.executableIdentity,
    });

    const serverSignature = this.signTaskPayload(payload, deviceKey);

    return {
      type: "device.task.dispatch",
      taskId: params.taskId,
      requestId,
      deviceId: params.deviceId,
      workspaceId: params.workspaceId,
      capability: params.capability,
      resourceScopes: params.resourceScopes,
      parameters: params.parameters,
      argumentsHash,
      issuedAt,
      expiresAt,
      nonce,
      policyVersion,
      approvalReference: params.approvalReference,
      protocolVersion,
      serverAudience,
      mcpServerName: params.mcpServerName,
      mcpSchemaHash: params.mcpSchemaHash,
      executableIdentity: params.executableIdentity,
      serverSignature,
    };
  }
}

export const taskAuthorizationService = new TaskAuthorizationService();
