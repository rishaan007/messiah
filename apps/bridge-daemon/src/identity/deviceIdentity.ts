import crypto from "node:crypto";
import os from "node:os";
import { DEVICE_CONSTANTS } from "@messiah/shared";

export interface DeviceIdentity {
  deviceId: string;
  publicKey: string;
  privateKey: string;
  publicKeyFingerprint: string;
  displayName: string;
  platform: string;
  architecture: string;
  bridgeVersion: string;
  createdAt: string;
}

export class DeviceIdentityManager {
  public static readonly VERSION = "0.1.0";

  /**
   * Generates a new cryptographically bound Ed25519 device identity.
   */
  public static generateIdentity(displayName?: string): DeviceIdentity {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
      publicKeyEncoding: {
        type: "spki",
        format: "pem",
      },
      privateKeyEncoding: {
        type: "pkcs8",
        format: "pem",
      },
    });

    const pubKeyObj = crypto.createPublicKey(publicKey);
    const spkiDer = pubKeyObj.export({ type: "spki", format: "der" });
    const fingerprint = `SHA256:${crypto.createHash("sha256").update(spkiDer).digest("hex")}`;
    const deviceId = crypto.randomUUID();

    const resolvedDisplayName =
      displayName?.trim() ||
      `${os.hostname().replace(/\.local$/i, "")} (${os.platform()}-${os.arch()})`;

    return {
      deviceId,
      publicKey: publicKey.trim(),
      privateKey: privateKey.trim(),
      publicKeyFingerprint: fingerprint,
      displayName: resolvedDisplayName,
      platform: os.platform(),
      architecture: os.arch(),
      bridgeVersion: DeviceIdentityManager.VERSION,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Calculates the SHA-256 fingerprint of an Ed25519 public key.
   */
  public static calculateFingerprint(publicKeyPem: string): string {
    const pubKeyObj = crypto.createPublicKey(publicKeyPem);
    const spkiDer = pubKeyObj.export({ type: "spki", format: "der" });
    return `SHA256:${crypto.createHash("sha256").update(spkiDer).digest("hex")}`;
  }

  /**
   * Signs a canonical challenge payload using the device's Ed25519 private key.
   */
  public static signPayload(payload: string, privateKeyPem: string): string {
    const privateKey = crypto.createPrivateKey(privateKeyPem);
    const signature = crypto.sign(null, Buffer.from(payload, "utf-8"), privateKey);
    return signature.toString("base64");
  }

  /**
   * Verifies a signature against an Ed25519 public key.
   */
  public static verifySignature(payload: string, signatureBase64: string, publicKeyPem: string): boolean {
    try {
      const publicKey = crypto.createPublicKey(publicKeyPem);
      return crypto.verify(
        null,
        Buffer.from(payload, "utf-8"),
        publicKey,
        Buffer.from(signatureBase64, "base64")
      );
    } catch {
      return false;
    }
  }

  /**
   * Formats the canonical authentication payload bound to challenge parameters.
   */
  public static formatAuthPayload(
    deviceId: string,
    challengeId: string,
    nonce: string,
    serverAudience: string,
    protocolVersion: string,
    expiresAt: number
  ): string {
    return `${DEVICE_CONSTANTS.SIGNING_PREFIX}:${deviceId}:${challengeId}:${nonce}:${serverAudience}:${protocolVersion}:${expiresAt}`;
  }
}
