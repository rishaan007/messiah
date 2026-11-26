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
import { taskAuthorizationService } from "./taskAuthorizationService.js";
import { chatQueueManager } from "../chat/chatQueue.js";
import { LogRedactor } from "@messiah/bridge-daemon";

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

        // Any task actively RUNNING, ACCEPTED, or CANCEL_REQUESTED when socket dropped transitions to UNKNOWN_OUTCOME
        await prisma.bridgeTask.updateMany({
          where: {
            deviceId: authenticatedDeviceId,
            status: { in: ["RUNNING", "ACCEPTED", "CANCEL_REQUESTED"] },
          },
          data: {
            status: "UNKNOWN_OUTCOME",
            errorMessage: "Workstation disconnected mid-execution; operation side-effect outcome is indeterminate and will not be auto-retried.",
            completedAt: new Date(),
          },
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

    // 3. Handle incoming frames strictly sequentially per socket to prevent out-of-order DB updates
    let messageChain = Promise.resolve();
    const processIncomingMessage = async (raw: Buffer | string) => {
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

          // Provision or retrieve unique per-device 256-bit HMAC task signing key
          const signingKeyInfo = await taskAuthorizationService.provisionOrGetDeviceSigningKey(device.id);

          import("../notifications/index.js")
            .then(({ notificationService, notificationStreamPublisher }) => {
              notificationStreamPublisher
                .publish({
                  type: "device.status_changed",
                  workspaceId: device.workspaceId,
                  payload: { deviceId: device.id, status: "ONLINE", displayName: device.displayName },
                  timestamp: new Date().toISOString(),
                })
                .catch(() => {});
              return notificationService.emitWorkspaceNotification({
                workspaceId: device.workspaceId,
                category: "DEVICE_STATUS",
                title: `Workstation Online: ${device.displayName}`,
                preview: `${device.platform} (${device.architecture}) Local Agent Bridge connected cleanly.`,
                resourceType: "bridge_device",
                resourceId: device.id,
                deepLink: `/settings/devices`,
                dedupKey: `device-online-${device.id}-${session.id}`,
                specificUserId: device.ownerUserId,
              });
            })
            .catch(() => {});

          // Send auth success with per-device HMAC signing key over authenticated TLS/WSS channel
          const successFrame: ServerAuthSuccessFrame = {
            type: "device.auth.success",
            sessionId: session.id,
            deviceId: device.id,
            displayName: device.displayName,
            heartbeatIntervalMs: DEVICE_CONSTANTS.HEARTBEAT_INTERVAL_MS,
            sessionExpiresAt: session.expiresAt.toISOString(),
            taskSigningKey: signingKeyInfo.key,
            taskKeyVersion: signingKeyInfo.version,
            protocolVersion: DEVICE_CONSTANTS.PROTOCOL_VERSION,
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

          // Phase 4B: Device Task Execution & Capability Frames (forward-only transitions)
          case "device.task.accepted": {
            resetHeartbeatWatchdog();
            await prisma.bridgeTask.updateMany({
              where: { id: frame.taskId, status: { in: ["QUEUED", "DISPATCHED"] } },
              data: { status: "ACCEPTED" },
            }).catch(() => {});
            break;
          }

          case "device.task.started": {
            resetHeartbeatWatchdog();
            await prisma.bridgeTask.updateMany({
              where: { id: frame.taskId, status: { in: ["QUEUED", "DISPATCHED", "ACCEPTED"] } },
              data: {
                status: "RUNNING",
                startedAt: new Date(frame.timestamp),
              },
            }).catch(() => {});
            break;
          }

          case "device.task.progress": {
            resetHeartbeatWatchdog();
            break;
          }

          case "device.task.log": {
            resetHeartbeatWatchdog();
            await prisma.bridgeTaskLog.create({
              data: {
                taskId: frame.taskId,
                sequence: frame.sequence,
                stream: frame.stream,
                chunk: LogRedactor.redact(frame.chunk),
                timestamp: new Date(frame.timestamp),
              },
            }).catch(() => {});
            break;
          }

          case "device.approval.required": {
            resetHeartbeatWatchdog();
            const task = await prisma.bridgeTask.findUnique({ where: { id: frame.taskId } });
            if (task && task.deviceId === authenticatedDeviceId) {
              const details = (frame.details || {}) as Record<string, unknown>;
              await prisma.bridgeTaskApproval.create({
                data: {
                  taskId: task.id,
                  workspaceId: task.workspaceId,
                  deviceId: task.deviceId,
                  requestedByUserId: task.userId,
                  operation: frame.operation,
                  summary: frame.summary,
                  details: frame.details as any,
                  argumentsHash: frame.argumentsHash,
                  capability: task.capability,
                  resourceScopes: task.resourceScopes,
                  executableIdentity:
                    typeof details.executable === "string" ? details.executable : undefined,
                  mcpServerName:
                    typeof details.mcpServerName === "string"
                      ? details.mcpServerName
                      : typeof details.serverName === "string"
                      ? details.serverName
                      : undefined,
                  mcpSchemaHash:
                    typeof details.mcpSchemaHash === "string" ? details.mcpSchemaHash : undefined,
                  nonce: frame.nonce,
                  expiresAt: new Date(frame.expiresAt),
                },
              }).catch(() => {});
              await prisma.bridgeTask.update({
                where: { id: task.id },
                data: { status: "AWAITING_APPROVAL" },
              }).catch(() => {});

              import("../notifications/index.js")
                .then(({ notificationService }) =>
                  notificationService.emitWorkspaceNotification({
                    workspaceId: task.workspaceId,
                    category: "BRIDGE_APPROVAL",
                    title: `Workstation Approval: ${task.capability}`,
                    preview: frame.summary || `Sensitive workstation action '${task.capability}' requires sign-off.`,
                    resourceType: "bridge_task",
                    resourceId: task.id,
                    deepLink: `/approvals?kind=BRIDGE_TASK&id=${task.id}`,
                    dedupKey: `bridge-approval-${task.id}`,
                    expiresAt: new Date(frame.expiresAt),
                    approversOnly: true,
                    metadata: {
                      deviceId: task.deviceId,
                      capability: task.capability,
                    },
                  })
                )
                .catch(() => {});
            }
            break;
          }

          case "device.task.completed": {
            resetHeartbeatWatchdog();
            const completedTask = await prisma.bridgeTask
              .update({
                where: { id: frame.taskId },
                data: {
                  status: "SUCCEEDED",
                  result: frame.result as any,
                  exitCode: frame.exitCode ?? 0,
                  durationMs: frame.durationMs,
                  completedAt: new Date(frame.timestamp),
                },
              })
              .catch(() => null);
            if (completedTask?.agentRunId) {
              await this.resumeSwarmRunForBridgeTask(completedTask.agentRunId, completedTask.workspaceId, completedTask.userId);
            }
            if (completedTask?.workflowRunId) {
              await this.resumeWorkflowRunForBridgeTask(completedTask.workflowRunId, completedTask.workspaceId, completedTask.userId);
            }
            if (completedTask) {
              const { workflowEventRouter } = await import("../workflows/workflowEventRouter.js");
              workflowEventRouter
                .emitDomainEvent({
                  workspaceId: completedTask.workspaceId,
                  eventType: "bridge.task.completed",
                  dedupKey: `bridge-task-${completedTask.id}-completed`,
                  triggeredByUserId: completedTask.userId,
                  payload: {
                    taskId: completedTask.id,
                    capability: completedTask.capability,
                    status: completedTask.status,
                  },
                })
                .catch(() => {});
            }
            break;
          }

          case "device.task.failed": {
            resetHeartbeatWatchdog();
            const failedTask = await prisma.bridgeTask
              .update({
                where: { id: frame.taskId },
                data: {
                  status: "FAILED",
                  errorMessage: frame.message,
                  exitCode: frame.exitCode ?? 1,
                  durationMs: frame.durationMs,
                  completedAt: new Date(frame.timestamp),
                },
              })
              .catch(() => null);
            if (failedTask?.agentRunId) {
              await this.resumeSwarmRunForBridgeTask(failedTask.agentRunId, failedTask.workspaceId, failedTask.userId);
            }
            if (failedTask?.workflowRunId) {
              await this.resumeWorkflowRunForBridgeTask(failedTask.workflowRunId, failedTask.workspaceId, failedTask.userId);
            }
            if (failedTask) {
              const { workflowEventRouter } = await import("../workflows/workflowEventRouter.js");
              workflowEventRouter
                .emitDomainEvent({
                  workspaceId: failedTask.workspaceId,
                  eventType: "bridge.task.failed",
                  dedupKey: `bridge-task-${failedTask.id}-failed`,
                  triggeredByUserId: failedTask.userId,
                  payload: {
                    taskId: failedTask.id,
                    capability: failedTask.capability,
                    status: failedTask.status,
                    errorMessage: failedTask.errorMessage,
                  },
                })
                .catch(() => {});
            }
            break;
          }

          case "device.task.unknown_outcome": {
            resetHeartbeatWatchdog();
            const unknownTask = await prisma.bridgeTask
              .update({
                where: { id: frame.taskId },
                data: {
                  status: "UNKNOWN_OUTCOME",
                  errorMessage: frame.reason,
                  completedAt: new Date(frame.timestamp),
                },
              })
              .catch(() => null);
            if (unknownTask?.agentRunId) {
              await this.resumeSwarmRunForBridgeTask(unknownTask.agentRunId, unknownTask.workspaceId, unknownTask.userId);
            }
            if (unknownTask?.workflowRunId) {
              await this.resumeWorkflowRunForBridgeTask(unknownTask.workflowRunId, unknownTask.workspaceId, unknownTask.userId);
            }
            break;
          }

          case "device.task.cancelled": {
            resetHeartbeatWatchdog();
            const cancelledTask = await prisma.bridgeTask
              .update({
                where: { id: frame.taskId },
                data: {
                  status: "CANCELLED",
                  errorMessage: frame.reason,
                  completedAt: new Date(frame.timestamp),
                },
              })
              .catch(() => null);
            if (cancelledTask?.agentRunId) {
              await this.resumeSwarmRunForBridgeTask(cancelledTask.agentRunId, cancelledTask.workspaceId, cancelledTask.userId);
            }
            if (cancelledTask?.workflowRunId) {
              await this.resumeWorkflowRunForBridgeTask(cancelledTask.workflowRunId, cancelledTask.workspaceId, cancelledTask.userId);
            }
            break;
          }

          case "device.capabilities.reported": {
            resetHeartbeatWatchdog();
            await prisma.bridgeDevice.update({
              where: { id: authenticatedDeviceId },
              data: {
                capabilities: frame.capabilities,
                allowedRoots: frame.allowedRoots,
                lastSeenAt: new Date(),
              },
            }).catch(() => {});
            break;
          }

          case "device.mcp.discovered": {
            resetHeartbeatWatchdog();
            const dev = await prisma.bridgeDevice.findUnique({ where: { id: authenticatedDeviceId } });
            if (dev) {
              for (const s of frame.servers) {
                const existing = await prisma.bridgeLocalMcpServer.findUnique({
                  where: {
                    deviceId_serverName: {
                      deviceId: dev.id,
                      serverName: s.name,
                    },
                  },
                });
                const drift = Boolean(
                  existing?.approvedSchemaHash &&
                    s.schemaHash &&
                    existing.approvedSchemaHash !== s.schemaHash
                );
                await prisma.bridgeLocalMcpServer.upsert({
                  where: {
                    deviceId_serverName: {
                      deviceId: dev.id,
                      serverName: s.name,
                    },
                  },
                  create: {
                    deviceId: dev.id,
                    workspaceId: dev.workspaceId,
                    serverName: s.name,
                    command: s.command,
                    args: s.args,
                    status: s.status,
                    schemaHash: s.schemaHash,
                    approvedSchemaHash: s.schemaHash,
                    schemaDriftDetected: false,
                    tools: s.tools as any,
                    lastDiscoveredAt: new Date(),
                  },
                  update: {
                    command: s.command,
                    args: s.args,
                    status: s.status,
                    schemaHash: s.schemaHash,
                    schemaDriftDetected: drift,
                    tools: s.tools as any,
                    lastDiscoveredAt: new Date(),
                  },
                }).catch(() => {});
              }
            }
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
    };

    socket.on("message", (raw: Buffer | string) => {
      messageChain = messageChain.then(() => processIncomingMessage(raw)).catch(() => {});
    });

    socket.on("close", () => {
      cleanupAndClose("Socket closed by remote", 1000);
    });

    socket.on("error", () => {
      cleanupAndClose("Socket error", 1006);
    });
  }

  /**
   * Checks whether a device is currently connected with an active open WebSocket.
   */
  public isDeviceConnected(deviceId: string): boolean {
    const active = this.activeSockets.get(deviceId);
    return !!active && active.socket.readyState === active.socket.OPEN;
  }

  /**
   * Dispatches a typed server frame to an active bridge device.
   */
  public sendToDevice(deviceId: string, frame: object): boolean {
    const active = this.activeSockets.get(deviceId);
    if (!active || active.socket.readyState !== active.socket.OPEN) {
      return false;
    }
    try {
      active.socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
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

  private async resumeSwarmRunForBridgeTask(
    agentRunId: string,
    workspaceId: string,
    userId: string
  ): Promise<void> {
    try {
      const outbox = await prisma.outboxEvent.create({
        data: {
          eventType: "swarm.resume",
          aggregateType: "AgentRun",
          aggregateId: agentRunId,
          payload: {
            kind: "swarm.execute",
            runId: agentRunId,
            workspaceId,
            userId,
          },
          status: "PENDING",
        },
      });
      await prisma.agentRun.updateMany({
        where: { id: agentRunId, status: "AWAITING_APPROVAL" },
        data: { status: "PENDING" },
      });
      await chatQueueManager
        .enqueueSwarmRun(
          {
            kind: "swarm.execute",
            runId: agentRunId,
            workspaceId,
            userId,
            outboxEventId: outbox.id,
          },
          `swarm-${agentRunId}-bridge-${outbox.id}`
        )
        .catch(() => {});
    } catch {}
  }

  private async resumeWorkflowRunForBridgeTask(
    workflowRunId: string,
    workspaceId: string,
    userId: string
  ): Promise<void> {
    try {
      const outbox = await prisma.outboxEvent.create({
        data: {
          eventType: "workflow.resume",
          aggregateType: "WorkflowRun",
          aggregateId: workflowRunId,
          payload: {
            kind: "workflow.execute",
            runId: workflowRunId,
            workspaceId,
            userId,
          },
          status: "PENDING",
        },
      });
      await prisma.workflowRun.updateMany({
        where: { id: workflowRunId, status: "AWAITING_APPROVAL" },
        data: { status: "RUNNING" },
      });
      await chatQueueManager
        .enqueueWorkflowRun(
          {
            kind: "workflow.execute",
            runId: workflowRunId,
            workspaceId,
            userId,
            outboxEventId: outbox.id,
          },
          `workflow-${workflowRunId}-bridge-${outbox.id}`
        )
        .catch(() => {});
    } catch {}
  }
}

export const deviceConnectionGateway = new DeviceConnectionGateway();
