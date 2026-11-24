import crypto from "node:crypto";
import { prisma, type PairingChallengeStatus } from "@messiah/db";
import {
  DEVICE_CONSTANTS,
  type ClaimPairingChallengeInput,
  type ClaimPairingChallengeResponse,
  type CreatePairingChallengeResponse,
  type DevicePairingChallengeInfo,
} from "@messiah/shared";
import { workspaceService } from "../workspaceService.js";

export class DevicePairingError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "DevicePairingError";
  }
}

export class DevicePairingService {
  /**
   * Generates a high-entropy 256-bit pairing secret formatted as MSH-XXXX-XXXX-XXXX.
   */
  private generatePairingCode(): string {
    const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // Base32 crockford alphabet (unambiguous)
    const bytes = crypto.randomBytes(16);
    let code = "MSH";
    for (let i = 0; i < 12; i++) {
      if (i % 4 === 0) code += "-";
      code += chars[bytes[i]! % chars.length];
    }
    return code;
  }

  /**
   * Computes SHA-256 hash of normalized pairing code.
   */
  public hashPairingCode(code: string): string {
    const normalized = code.trim().toUpperCase();
    return crypto.createHash("sha256").update(normalized).digest("hex");
  }

  /**
   * Verifies that the public key is a valid Ed25519 public key and matches fingerprint.
   */
  public validateEd25519PublicKey(publicKey: string, providedFingerprint?: string): string {
    try {
      const pubKeyObj = crypto.createPublicKey(publicKey);
      if (pubKeyObj.asymmetricKeyType !== "ed25519") {
        throw new DevicePairingError(400, "INVALID_KEY_TYPE", "Only Ed25519 public keys are supported.");
      }

      const spkiDer = pubKeyObj.export({ type: "spki", format: "der" });
      const computedFingerprint = `SHA256:${crypto.createHash("sha256").update(spkiDer).digest("hex")}`;

      if (providedFingerprint && providedFingerprint.trim().toUpperCase() !== computedFingerprint.toUpperCase()) {
        throw new DevicePairingError(
          400,
          "FINGERPRINT_MISMATCH",
          `Public key fingerprint does not match computed fingerprint (${computedFingerprint}).`
        );
      }

      return computedFingerprint;
    } catch (err: unknown) {
      if (err instanceof DevicePairingError) throw err;
      throw new DevicePairingError(400, "INVALID_PUBLIC_KEY", "Failed to parse public key as Ed25519 format.");
    }
  }

  /**
   * Initiates a pairing challenge in a workspace.
   * Only workspace OWNER or ADMIN can create a pairing challenge.
   */
  public async createPairingChallenge(
    workspaceId: string,
    userId: string
  ): Promise<CreatePairingChallengeResponse> {
    const role = await workspaceService.getUserRole(workspaceId, userId);
    if (!role) {
      throw new DevicePairingError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }
    if (role !== "OWNER" && role !== "ADMIN") {
      throw new DevicePairingError(403, "FORBIDDEN_ROLE", "Only workspace OWNER or ADMIN can initiate device pairing.");
    }

    const pairingCode = this.generatePairingCode();
    const challengeHash = this.hashPairingCode(pairingCode);
    const expiresAt = new Date(Date.now() + DEVICE_CONSTANTS.PAIRING_CHALLENGE_TTL_SECONDS * 1000);

    const challenge = await prisma.devicePairingChallenge.create({
      data: {
        challengeHash,
        workspaceId,
        requestedByUserId: userId,
        status: "PENDING",
        expiresAt,
      },
    });

    return {
      challengeId: challenge.id,
      pairingCode,
      expiresAt: challenge.expiresAt.toISOString(),
    };
  }

  /**
   * Claims a pairing challenge from the Bridge daemon CLI.
   * Registers the device in PENDING_APPROVAL state.
   */
  public async claimPairingChallenge(
    input: ClaimPairingChallengeInput
  ): Promise<ClaimPairingChallengeResponse> {
    const challengeHash = this.hashPairingCode(input.pairingCode);

    const challenge = await prisma.devicePairingChallenge.findUnique({
      where: { challengeHash },
    });

    if (!challenge) {
      throw new DevicePairingError(404, "INVALID_PAIRING_CODE", "Pairing code not found or invalid.");
    }

    if (challenge.failedAttempts >= DEVICE_CONSTANTS.MAX_PAIRING_FAILED_ATTEMPTS) {
      await prisma.devicePairingChallenge.update({
        where: { id: challenge.id },
        data: { status: "EXPIRED" },
      });
      throw new DevicePairingError(429, "MAX_ATTEMPTS_EXCEEDED", "Pairing code has exceeded maximum failed attempts.");
    }

    if (challenge.status !== "PENDING") {
      throw new DevicePairingError(
        400,
        "CHALLENGE_ALREADY_USED",
        `Pairing challenge is no longer available (current status: ${challenge.status}).`
      );
    }

    if (new Date() > challenge.expiresAt) {
      await prisma.devicePairingChallenge.update({
        where: { id: challenge.id },
        data: { status: "EXPIRED" },
      });
      throw new DevicePairingError(400, "CHALLENGE_EXPIRED", "Pairing code has expired. Please request a new code.");
    }

    // Validate Ed25519 public key and verify fingerprint
    const verifiedFingerprint = this.validateEd25519PublicKey(input.publicKey, input.publicKeyFingerprint);

    // Atomically create the pending device and mark challenge as CLAIMED
    const result = await prisma.$transaction(async (tx) => {
      // Create BridgeDevice in PENDING_APPROVAL status
      const device = await tx.bridgeDevice.create({
        data: {
          workspaceId: challenge.workspaceId,
          ownerUserId: challenge.requestedByUserId,
          displayName: input.displayName.trim(),
          platform: input.platform.trim().toLowerCase(),
          architecture: input.architecture.trim().toLowerCase(),
          bridgeVersion: input.bridgeVersion.trim(),
          publicKey: input.publicKey.trim(),
          publicKeyFingerprint: verifiedFingerprint,
          protocolVersion: DEVICE_CONSTANTS.PROTOCOL_VERSION,
          status: "PENDING_APPROVAL",
        },
      });

      // Update challenge to CLAIMED
      await tx.devicePairingChallenge.update({
        where: { id: challenge.id },
        data: {
          claimedDeviceId: device.id,
          claimedDeviceName: input.displayName.trim(),
          claimedPlatform: input.platform.trim().toLowerCase(),
          claimedArchitecture: input.architecture.trim().toLowerCase(),
          claimedBridgeVersion: input.bridgeVersion.trim(),
          claimedPublicKey: input.publicKey.trim(),
          claimedFingerprint: verifiedFingerprint,
          status: "CLAIMED",
        },
      });

      return device;
    });

    return {
      deviceId: result.id,
      status: "PENDING_APPROVAL",
      message: "Device registration submitted. Awaiting approval by workspace administrator in Messiah.",
    };
  }

  /**
   * Lists pending claimed pairing challenges for a workspace.
   */
  public async getPendingChallenges(
    workspaceId: string,
    userId: string
  ): Promise<DevicePairingChallengeInfo[]> {
    const role = await workspaceService.getUserRole(workspaceId, userId);
    if (!role) {
      throw new DevicePairingError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }
    if (role !== "OWNER" && role !== "ADMIN") {
      throw new DevicePairingError(403, "FORBIDDEN_ROLE", "Only workspace OWNER or ADMIN can review pending pairings.");
    }

    const challenges = await prisma.devicePairingChallenge.findMany({
      where: {
        workspaceId,
        status: "CLAIMED",
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });

    return challenges.map((c) => ({
      id: c.id,
      workspaceId: c.workspaceId,
      requestedByUserId: c.requestedByUserId,
      claimedDeviceId: c.claimedDeviceId,
      claimedDeviceName: c.claimedDeviceName,
      claimedPlatform: c.claimedPlatform,
      claimedArchitecture: c.claimedArchitecture,
      claimedBridgeVersion: c.claimedBridgeVersion,
      claimedFingerprint: c.claimedFingerprint,
      status: c.status as PairingChallengeStatus,
      expiresAt: c.expiresAt.toISOString(),
      consumedAt: c.consumedAt ? c.consumedAt.toISOString() : null,
      createdAt: c.createdAt.toISOString(),
    }));
  }

  /**
   * Approves a claimed pairing challenge, activating the device.
   */
  public async approvePairing(
    challengeId: string,
    workspaceId: string,
    userId: string
  ) {
    const role = await workspaceService.getUserRole(workspaceId, userId);
    if (!role) {
      throw new DevicePairingError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }
    if (role !== "OWNER" && role !== "ADMIN") {
      throw new DevicePairingError(403, "FORBIDDEN_ROLE", "Only workspace OWNER or ADMIN can approve device pairing.");
    }

    const challenge = await prisma.devicePairingChallenge.findUnique({
      where: { id: challengeId },
    });

    if (!challenge || challenge.workspaceId !== workspaceId) {
      throw new DevicePairingError(404, "CHALLENGE_NOT_FOUND", "Pairing challenge not found.");
    }

    if (challenge.status !== "CLAIMED" || !challenge.claimedDeviceId) {
      throw new DevicePairingError(
        400,
        "INVALID_CHALLENGE_STATE",
        `Cannot approve pairing challenge in state ${challenge.status}.`
      );
    }

    if (new Date() > challenge.expiresAt) {
      await prisma.devicePairingChallenge.update({
        where: { id: challenge.id },
        data: { status: "EXPIRED" },
      });
      throw new DevicePairingError(400, "CHALLENGE_EXPIRED", "Pairing challenge has expired.");
    }

    const deviceId = challenge.claimedDeviceId;

    // Single atomic transaction to activate device and consume challenge
    const updatedDevice = await prisma.$transaction(async (tx) => {
      await tx.devicePairingChallenge.update({
        where: { id: challengeId },
        data: {
          status: "CONSUMED",
          consumedAt: new Date(),
        },
      });

      return await tx.bridgeDevice.update({
        where: { id: deviceId },
        data: {
          status: "ACTIVE",
          pairedAt: new Date(),
        },
      });
    });

    return updatedDevice;
  }

  /**
   * Rejects a claimed pairing challenge, revoking the pending device.
   */
  public async rejectPairing(
    challengeId: string,
    workspaceId: string,
    userId: string,
    _reason?: string
  ): Promise<{ success: boolean }> {
    const role = await workspaceService.getUserRole(workspaceId, userId);
    if (!role) {
      throw new DevicePairingError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }
    if (role !== "OWNER" && role !== "ADMIN") {
      throw new DevicePairingError(403, "FORBIDDEN_ROLE", "Only workspace OWNER or ADMIN can reject device pairing.");
    }

    const challenge = await prisma.devicePairingChallenge.findUnique({
      where: { id: challengeId },
    });

    if (!challenge || challenge.workspaceId !== workspaceId) {
      throw new DevicePairingError(404, "CHALLENGE_NOT_FOUND", "Pairing challenge not found.");
    }

    await prisma.$transaction(async (tx) => {
      await tx.devicePairingChallenge.update({
        where: { id: challengeId },
        data: { status: "REJECTED" },
      });

      if (challenge.claimedDeviceId) {
        await tx.bridgeDevice.update({
          where: { id: challenge.claimedDeviceId },
          data: {
            status: "REVOKED",
            revokedAt: new Date(),
          },
        });
      }
    });

    return { success: true };
  }
}

export const devicePairingService = new DevicePairingService();
