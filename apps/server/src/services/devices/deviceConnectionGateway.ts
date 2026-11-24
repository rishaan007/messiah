import crypto from "node:crypto";
import type { WebSocket } from "ws";
import type { FastifyRequest } from "fastify";
import { prisma } from "@messiah/db";
import {
  DEVICE_CONSTANTS,
  BridgeAuthProofFrameSchema,
  DeviceToServerFrameSchema,
  type ServerChallengeFrame,
  type ServerAuthSuccessFrame,
  type ServerAuthFailedFrame,
  type ServerHeartbeatAckFrame,
  type ServerDeviceRevokedFrame,
  type ServerProtocolErrorFrame,
  type DeviceToServerFrame,
} from "@messiah/shared";
import { devicePresenceService } from "./devicePresenceService.js";

interface PendingChallenge {
  nonce: string;
  serverAudience: string;
  protocolVersion: string;
  expiresAt: number;
}

export class DeviceConnectionGateway {
  // Ephemeral in-memory challenges pending authentication (keyed by challengeId)
  private activeChallenges = new Map<string, PendingChallenge>();

  // Active connected sockets (keyed by deviceId)
  private activeSockets = new Map<string, { socket: WebSocket; sessionId: string; cleanup: () => void }>();

  /**
   * Builds the canonical payload string bound to the authentication parameters.
   */
  public buildCanonicalPayload(
    deviceId: string,
    challengeId: string,
    nonce: string,
    serverAudience: string,
    protocolVersion: string,
    expiresAt: number
  ): string {
    return `${DEVICE_CONSTANTS.SIGNING_PREFIX}:${deviceId}:${challengeId}:${nonce}:${serverAudience}:${protocolVersion}:${expiresAt}`;
  }

  /**
   * Handles an incoming WebSocket connection on /api/v1/devices/connect.
   */
  public handleConnection(socket: WebSocket, req: FastifyRequest): void {
    let authenticatedDeviceId: string | null = null;
    let sessionId: string | null = null;
    let heartbeatTimeoutTimer: NodeJS.Timeout | null = null;
    let authTimeoutTimer: NodeJS.Timeout | null = null;
    let isTerminated = false;

    const remoteIp = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "unknown";
    const userAgent = req.headers["user-agent"] || "messiah-bridge";

    const sendFrame = (frame: object) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(frame));
      }
    };

    const cleanupAndClose = async (reason = "Connection closed", code = 1000) => {
      if (isTerminated) return;
      isTerminated = true;

      if (authTimeoutTimer) clearTimeout(authTimeoutTimer);
      if (heartbeatTimeoutTimer) clearTimeout(heartbeatTimeoutTimer);

      if (authenticatedDeviceId) {
        this.activeSockets.delete(authenticatedDeviceId);
        await devicePresenceService.setDeviceOffline(authenticatedDeviceId);

        if (sessionId) {
          await prisma.deviceConnectionSession.update({
            where: { id: sessionId },
            data: {
              disconnectedAt: new Date(),
              disconnectReason: reason,
            },
          }).catch(() => {});
        }

        await prisma.bridgeDevice.update({
          where: { id: authenticatedDeviceId },
          data: { lastSeenAt: new Date() },
        }).catch(() => {});
      }

      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
        try {
          socket.close(code, reason);
        } catch {}
      }
    };

    // 1. Generate fresh challenge
    const challengeId = crypto.randomUUID();
    const nonce = crypto.randomBytes(32).toString("hex");
    const now = Date.now();
    const expiresAt = now + DEVICE_CONSTANTS.WSS_CHALLENGE_TTL_MS;
    const serverAudience = "messiah-cloud";
    const protocolVersion = DEVICE_CONSTANTS.PROTOCOL_VERSION;

    this.activeChallenges.set(challengeId, {
      nonce,
      serverAudience,
      protocolVersion,
      expiresAt,
    });

    const challengeFrame: ServerChallengeFrame = {
      type: "device.challenge",
      challengeId,
      nonce,
      serverAudience,
      timestamp: now,
      protocolVersion,
      expiresAt,
    };

    sendFrame(challengeFrame);

    // 2. Set 10s authentication timeout
    authTimeoutTimer = setTimeout(() => {
      this.activeChallenges.delete(challengeId);
      const errFrame: ServerAuthFailedFrame = {
        type: "device.auth.failed",
        code: "AUTH_TIMEOUT",
        message: "Authentication timeout. No proof received within 10 seconds.",
      };
      sendFrame(errFrame);
      cleanupAndClose("Authentication timeout", 4408);
    }, 10000);

    const resetHeartbeatWatchdog = () => {
      if (heartbeatTimeoutTimer) clearTimeout(heartbeatTimeoutTimer);
      heartbeatTimeoutTimer = setTimeout(() => {
        const errFrame: ServerProtocolErrorFrame = {
          type: "device.protocol.error",
          code: "HEARTBEAT_TIMEOUT",
          message: "No heartbeat received within deadline.",
        };
        sendFrame(errFrame);
        cleanupAndClose("Heartbeat timeout", 4408);
      }, DEVICE_CONSTANTS.HEARTBEAT_TIMEOUT_MS);
    };

    // 3. Handle incoming frames
    socket.on("message", async (raw: Buffer | string) => {
      try {
        if (raw.length > DEVICE_CONSTANTS.MAX_FRAME_SIZE_BYTES) {
          const errFrame: ServerProtocolErrorFrame = {
            type: "device.protocol.error",
            code: "FRAME_TOO_LARGE",
            message: `Message exceeds maximum size limit of ${DEVICE_CONSTANTS.MAX_FRAME_SIZE_BYTES} bytes.`,
          };
          sendFrame(errFrame);
          cleanupAndClose("Frame too large", 1009);
          return;
        }

        const parsed = JSON.parse(raw.toString("utf-8"));

        // If not authenticated yet, we ONLY accept device.auth.proof
        if (!authenticatedDeviceId) {
          const proofResult = BridgeAuthProofFrameSchema.safeParse(parsed);
          if (!proofResult.success) {
            const errFrame: ServerAuthFailedFrame = {
              type: "device.auth.failed",
              code: "MALFORMED_AUTH_PROOF",
              message: "Expected device.auth.proof frame.",
            };
            sendFrame(errFrame);
            cleanupAndClose("Malformed auth proof", 4400);
            return;
          }

          if (authTimeoutTimer) {
            clearTimeout(authTimeoutTimer);
            authTimeoutTimer = null;
          }

          const proof = proofResult.data;
          const pendingChallenge = this.activeChallenges.get(proof.challengeId);
          this.activeChallenges.delete(proof.challengeId); // Atomic single-use consumption

          if (!pendingChallenge) {
            const errFrame: ServerAuthFailedFrame = {
              type: "device.auth.failed",
              code: "INVALID_CHALLENGE",
              message: "Challenge ID invalid or already consumed.",
            };
            sendFrame(errFrame);
            cleanupAndClose("Invalid challenge", 4401);
            return;
          }

          if (Date.now() > pendingChallenge.expiresAt) {
            const errFrame: ServerAuthFailedFrame = {
              type: "device.auth.failed",
              code: "CHALLENGE_EXPIRED",
              message: "Challenge expired.",
            };
            sendFrame(errFrame);
            cleanupAndClose("Challenge expired", 4401);
            return;
          }

          // Fetch device
          const device = await prisma.bridgeDevice.findUnique({
            where: { id: proof.deviceId },
          });

          if (!device) {
            const errFrame: ServerAuthFailedFrame = {
              type: "device.auth.failed",
              code: "DEVICE_NOT_FOUND",
              message: "Device not found in registry.",
            };
            sendFrame(errFrame);
            cleanupAndClose("Device not found", 4404);
            return;
          }

          if (device.status === "PENDING_APPROVAL") {
            const errFrame: ServerAuthFailedFrame = {
              type: "device.auth.failed",
              code: "DEVICE_PENDING_APPROVAL",
              message: "Device is pending administrator approval in Messiah.",
            };
            sendFrame(errFrame);
            cleanupAndClose("Device pending approval", 4403);
            return;
          }

          if (device.status === "PAUSED") {
            const errFrame: ServerAuthFailedFrame = {
              type: "device.auth.failed",
              code: "DEVICE_PAUSED",
              message: "Device is paused by administrator.",
            };
            sendFrame(errFrame);
            cleanupAndClose("Device paused", 4403);
            return;
          }

          if (device.status === "REVOKED") {
            const errFrame: ServerAuthFailedFrame = {
              type: "device.auth.failed",
              code: "DEVICE_REVOKED",
              message: "Device has been permanently revoked.",
            };
            sendFrame(errFrame);
            cleanupAndClose("Device revoked", 4403);
            return;
          }

          // Verify Ed25519 signature
          const canonicalPayload = this.buildCanonicalPayload(
            proof.deviceId,
            proof.challengeId,
            pendingChallenge.nonce,
            pendingChallenge.serverAudience,
            pendingChallenge.protocolVersion,
            pendingChallenge.expiresAt
          );

          try {
            const pubKeyObj = crypto.createPublicKey(device.publicKey);
            const isValid = crypto.verify(
              null,
              Buffer.from(canonicalPayload, "utf-8"),
              pubKeyObj,
              Buffer.from(proof.signature, "base64")
            );

            if (!isValid) {
              const errFrame: ServerAuthFailedFrame = {
                type: "device.auth.failed",
                code: "INVALID_SIGNATURE",
                message: "Cryptographic signature verification failed.",
              };
              sendFrame(errFrame);
              cleanupAndClose("Invalid signature", 4401);
              return;
            }
          } catch (cryptoErr) {
            const errFrame: ServerAuthFailedFrame = {
              type: "device.auth.failed",
              code: "SIGNATURE_VERIFICATION_ERROR",
              message: "Failed to verify signature.",
            };
            sendFrame(errFrame);
            cleanupAndClose("Signature error", 4401);
            return;
          }

          // Close any existing connection for this device
          const existing = this.activeSockets.get(device.id);
          if (existing) {
            existing.cleanup();
          }

          // Create session
          const session = await prisma.deviceConnectionSession.create({
            data: {
              deviceId: device.id,
              ipAddress: remoteIp.slice(0, 64),
              userAgent: userAgent.slice(0, 255),
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h session
            },
          });

          authenticatedDeviceId = device.id;
          sessionId = session.id;

          // Update device connected timestamps
          await prisma.bridgeDevice.update({
            where: { id: device.id },
            data: {
              lastConnectedAt: new Date(),
              lastSeenAt: new Date(),
              bridgeVersion: proof.metadata.bridgeVersion || device.bridgeVersion,
            },
          });

          // Mark online in presence service
          await devicePresenceService.setDeviceOnline(device.id, {
            connectedAt: new Date().toISOString(),
            lastHeartbeatAt: new Date().toISOString(),
            ipAddress: remoteIp,
            userAgent,
            platform: device.platform,
          });

          this.activeSockets.set(device.id, {
            socket,
            sessionId,
            cleanup: () => cleanupAndClose("Superseded by new connection", 4409),
          });

          // Send auth success
          const successFrame: ServerAuthSuccessFrame = {
            type: "device.auth.success",
            sessionId: session.id,
            deviceId: device.id,
            displayName: device.displayName,
            heartbeatIntervalMs: DEVICE_CONSTANTS.HEARTBEAT_INTERVAL_MS,
            sessionExpiresAt: session.expiresAt.toISOString(),
          };
          sendFrame(successFrame);

          resetHeartbeatWatchdog();
          return;
        }

        // Authenticated message processing
        const frameResult = DeviceToServerFrameSchema.safeParse(parsed);
        if (!frameResult.success) {
          const errFrame: ServerProtocolErrorFrame = {
            type: "device.protocol.error",
            code: "UNKNOWN_FRAME",
            message: "Unsupported or invalid frame type.",
          };
          sendFrame(errFrame);
          return;
        }

        const frame: DeviceToServerFrame = frameResult.data;

        switch (frame.type) {
          case "device.heartbeat": {
            resetHeartbeatWatchdog();
            await devicePresenceService.refreshHeartbeat(authenticatedDeviceId);

            const ackFrame: ServerHeartbeatAckFrame = {
              type: "device.heartbeat.ack",
              timestamp: Date.now(),
              sequence: frame.sequence,
            };
            sendFrame(ackFrame);
            break;
          }

          case "device.status": {
            resetHeartbeatWatchdog();
            break;
          }

          case "device.diagnostics": {
            resetHeartbeatWatchdog();
            break;
          }

          case "device.disconnect": {
            cleanupAndClose(frame.reason || "Client initiated disconnect", 1000);
            break;
          }

          default:
            break;
        }
      } catch (err) {
        const errFrame: ServerProtocolErrorFrame = {
          type: "device.protocol.error",
          code: "INTERNAL_ERROR",
          message: "Internal error processing frame.",
        };
        sendFrame(errFrame);
      }
    });

    socket.on("close", () => {
      cleanupAndClose("Socket closed by remote", 1000);
    });

    socket.on("error", () => {
      cleanupAndClose("Socket error", 1006);
    });
  }

  /**
   * Disconnects an active socket directly if connected.
   */
  public disconnectDevice(deviceId: string, reason = "Disconnected by server", code = 4403): void {
    const active = this.activeSockets.get(deviceId);
    if (active) {
      if (active.socket.readyState === active.socket.OPEN) {
        const revokedFrame: ServerDeviceRevokedFrame = {
          type: "device.revoked",
          reason,
        };
        try {
          active.socket.send(JSON.stringify(revokedFrame));
        } catch {}
      }
      try {
        active.socket.close(code, reason);
      } catch {}
      active.cleanup();
    }
  }
}

export const deviceConnectionGateway = new DeviceConnectionGateway();
