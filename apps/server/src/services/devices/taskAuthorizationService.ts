import crypto from "node:crypto";
import { TASK_CONSTANTS, type DeviceTaskDispatchFrame } from "@messiah/shared";

export class TaskAuthorizationService {
  private readonly serverSecret: string;

  constructor(customSecret?: string) {
    this.serverSecret =
      customSecret ||
      process.env.MESSIAH_SERVER_SIGNING_KEY ||
      process.env.CREDENTIAL_VAULT_KEY_V2 ||
      "messiah_default_server_signing_secret_min_32_chars";
  }

  /**
   * Formats the canonical task authorization string that is signed by the server.
   */
  public formatTaskAuthPayload(
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
   * Signs a task authorization payload using the server's cryptographic key.
   */
  public signTaskPayload(payload: string): string {
    return crypto.createHmac("sha256", this.serverSecret).update(payload).digest("base64");
  }

  /**
   * Constructs and signs a complete DeviceTaskDispatchFrame for the target bridge device.
   */
  public createSignedTaskEnvelope(params: {
    taskId: string;
    deviceId: string;
    workspaceId: string;
    capability: string;
    resourceScopes: string[];
    parameters: Record<string, unknown>;
    approvalReference?: string;
    ttlMs?: number;
  }): DeviceTaskDispatchFrame {
    const issuedAt = Date.now();
    const expiresAt = issuedAt + (params.ttlMs || TASK_CONSTANTS.DEFAULT_TIMEOUT_MS);
    const nonce = crypto.randomBytes(16).toString("hex");
    const requestId = crypto.randomUUID();
    const policyVersion = "2026-08-01";

    const serializedParams = JSON.stringify(params.parameters);
    const argumentsHash = crypto.createHash("sha256").update(serializedParams).digest("hex");

    const payload = this.formatTaskAuthPayload(
      params.taskId,
      requestId,
      params.deviceId,
      params.workspaceId,
      params.capability,
      params.resourceScopes,
      argumentsHash,
      issuedAt,
      expiresAt,
      nonce,
      policyVersion,
      params.approvalReference
    );

    const serverSignature = this.signTaskPayload(payload);

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
      serverSignature,
    };
  }
}

export const taskAuthorizationService = new TaskAuthorizationService();
