import WebSocket from "ws";
import { EventEmitter } from "node:events";
import os from "node:os";
import {
  DEVICE_API_ROUTES,
  DEVICE_CONSTANTS,
  ServerToDeviceFrameSchema,
  type ServerToDeviceFrame,
  type BridgeAuthProofFrame,
  type BridgeHeartbeatFrame,
  type BridgeStatusFrame,
  type BridgeDiagnosticsFrame,
  type BridgeDisconnectFrame,
  type BridgeCapabilitiesReportedFrame,
  type BridgeMcpDiscoveredFrame,
  type DeviceTaskDispatchFrame,
} from "@messiah/shared";
import { DeviceIdentityManager, type DeviceIdentity } from "../identity/deviceIdentity.js";
import { PairingClient, type PairingConfig } from "../pairing/pairingClient.js";
import { getPlatformKeystore, type IKeyStore } from "../keystore/index.js";
import { TaskExecutor } from "../tasks/taskExecutor.js";
import { SandboxDetector } from "../sandbox/sandboxDetector.js";
import { LogRedactor } from "../security/logRedactor.js";

export interface BridgeClientOptions {
  serverUrl?: string;
  keystore?: IKeyStore;
  customConfigDir?: string;
  autoReconnect?: boolean;
}

export class BridgeClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private pairingClient: PairingClient;
  private keystore: IKeyStore;
  private identity: DeviceIdentity | null = null;
  private config: PairingConfig | null = null;
  private taskExecutor: TaskExecutor;
  /** Per-device 256-bit HMAC signing key provisioned upon authenticated WSS handshake */
  private deviceTaskSigningKey: string | null = null;

  private isRunning = false;
  private isConnected = false;
  private isRevoked = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatSequence = 0;
  private startTime = Date.now();

  constructor(options: BridgeClientOptions = {}) {
    super();
    this.keystore = options.keystore || getPlatformKeystore(options.customConfigDir);
    this.pairingClient = new PairingClient(this.keystore, options.customConfigDir);
    this.taskExecutor = new TaskExecutor(options.customConfigDir);
  }

  public getTaskExecutor(): TaskExecutor {
    return this.taskExecutor;
  }

  public getIsConnected(): boolean {
    return this.isConnected;
  }

  public getIdentity(): DeviceIdentity | null {
    return this.identity;
  }

  public getConfig(): PairingConfig | null {
    return this.config;
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isRevoked = false;
    this.startTime = Date.now();

    this.config = this.pairingClient.getSavedConfig();
    if (!this.config) {
      throw new Error("Bridge is not paired with a Messiah workspace. Run `messiah-bridge pair` first.");
    }

    this.identity = await this.keystore.loadIdentity();
    if (!this.identity) {
      throw new Error("Device private key not found in local keystore or could not be unlocked.");
    }

    this.connect();
  }

  private connect(): void {
    if (!this.isRunning || this.isRevoked) return;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const serverUrl = this.config!.serverUrl;
    let wsUrl = serverUrl.replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://");
    wsUrl = `${wsUrl.replace(/\/+$/, "")}${DEVICE_API_ROUTES.connect}`;

    try {
      this.ws = new WebSocket(wsUrl, {
        headers: {
          "User-Agent": `messiah-bridge/${this.identity!.bridgeVersion} (${this.identity!.platform}; ${this.identity!.architecture})`,
        },
      });

      this.setupSocketHandlers();
    } catch {
      this.scheduleReconnect();
    }
  }

  private setupSocketHandlers(): void {
    if (!this.ws) return;

    this.ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.emit("socket_open");
    });

    this.ws.on("message", (raw: Buffer | string) => {
      this.handleIncomingMessage(raw.toString("utf-8"));
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      const reasonStr = reason.toString("utf-8") || "Connection closed";
      this.handleDisconnection(code, reasonStr);
    });

    this.ws.on("error", (err: Error) => {
      this.emit("error", err);
    });
  }

  private handleIncomingMessage(rawStr: string): void {
    try {
      const parsed = JSON.parse(rawStr);
      const frameResult = ServerToDeviceFrameSchema.safeParse(parsed);
      if (!frameResult.success) {
        return;
      }

      const frame: ServerToDeviceFrame = frameResult.data;

      switch (frame.type) {
        case "device.challenge": {
          this.handleServerChallenge(frame);
          break;
        }

        case "device.auth.success": {
          this.isConnected = true;
          this.deviceTaskSigningKey = frame.taskSigningKey || null;
          this.startHeartbeatLoop(frame.heartbeatIntervalMs);
          this.reportCapabilities();
          this.emit("connected", frame);
          break;
        }

        case "device.task.dispatch": {
          this.handleTaskDispatch(frame);
          break;
        }

        case "device.task.cancel": {
          this.handleTaskCancel(frame.taskId, frame.reason);
          break;
        }

        case "device.mcp.sync": {
          this.reportLocalMcp();
          break;
        }

        case "device.auth.failed": {
          this.isConnected = false;
          this.emit("auth_failed", frame);
          if (frame.code === "DEVICE_REVOKED") {
            this.isRevoked = true;
            this.stop();
          }
          break;
        }

        case "device.heartbeat.ack": {
          this.emit("heartbeat_ack", frame);
          break;
        }

        case "device.revoked": {
          this.isRevoked = true;
          this.isConnected = false;
          this.deviceTaskSigningKey = null;
          this.emit("revoked", frame);
          this.stop();
          break;
        }

        case "device.protocol.error": {
          this.emit("protocol_error", frame);
          break;
        }

        default:
          break;
      }
    } catch (err) {
      this.emit("error", err);
    }
  }

  private handleServerChallenge(challenge: {
    challengeId: string;
    nonce: string;
    serverAudience: string;
    protocolVersion: string;
    expiresAt: number;
  }): void {
    if (!this.identity || !this.ws) return;

    const canonicalPayload = DeviceIdentityManager.formatAuthPayload(
      this.identity.deviceId,
      challenge.challengeId,
      challenge.nonce,
      challenge.serverAudience,
      challenge.protocolVersion,
      challenge.expiresAt
    );

    const signature = DeviceIdentityManager.signPayload(canonicalPayload, this.identity.privateKey);

    const proofFrame: BridgeAuthProofFrame = {
      type: "device.auth.proof",
      deviceId: this.identity.deviceId,
      challengeId: challenge.challengeId,
      signature,
      timestamp: Date.now(),
      metadata: {
        platform: this.identity.platform,
        architecture: this.identity.architecture,
        bridgeVersion: this.identity.bridgeVersion,
      },
    };

    this.send(proofFrame);
  }

  private startHeartbeatLoop(intervalMs: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    this.heartbeatTimer = setInterval(() => {
      if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      this.heartbeatSequence++;
      const frame: BridgeHeartbeatFrame = {
        type: "device.heartbeat",
        timestamp: Date.now(),
        sequence: this.heartbeatSequence,
      };
      this.send(frame);
    }, intervalMs);
  }

  public sendStatus(status: "online" | "idle" | "busy" = "online"): void {
    if (!this.isConnected) return;
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    const memoryUsageMb = Math.round(process.memoryUsage().rss / (1024 * 1024));

    const statusFrame: BridgeStatusFrame = {
      type: "device.status",
      status,
      uptimeSeconds: uptime,
      memoryUsageMb,
    };
    this.send(statusFrame);
  }

  public sendDiagnostics(latencyMs?: number): void {
    if (!this.isConnected) return;
    const diagFrame: BridgeDiagnosticsFrame = {
      type: "device.diagnostics",
      nodeVersion: process.version,
      osRelease: os.release(),
      connectionLatencyMs: latencyMs,
    };
    this.send(diagFrame);
  }

  private send(frame: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  private handleDisconnection(code: number, reason: string): void {
    this.isConnected = false;
    this.deviceTaskSigningKey = null;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.emit("disconnected", { code, reason });

    if (this.isRunning && !this.isRevoked) {
      this.scheduleReconnect();
    }
  }

  /**
   * Reports accurate capabilities: sandbox-dependent capabilities (process.run, mcp.*, agent.start)
   * are omitted when the host fails closed with SANDBOX_UNAVAILABLE.
   */
  public async reportCapabilities(): Promise<void> {
    if (!this.isConnected) return;
    try {
      const sandboxStatus = await SandboxDetector.detect();
      const allDefs = this.taskExecutor.getCapabilityRegistry().getAll();
      const capabilities = allDefs
        .filter((cap) => !cap.requiresSandbox || sandboxStatus.available)
        .map((cap) => cap.name);
      const allowedRoots = this.taskExecutor.getPolicyService().getAllowedRoots();

      const frame: BridgeCapabilitiesReportedFrame = {
        type: "device.capabilities.reported",
        capabilities,
        allowedRoots,
        sandboxStatus: {
          available: sandboxStatus.available,
          provider: sandboxStatus.providerName,
          details: sandboxStatus.reason,
        },
        timestamp: Date.now(),
      };
      this.send(frame);
    } catch {}
  }

  public async reportLocalMcp(): Promise<void> {
    if (!this.isConnected) return;
    try {
      const mcpCap = this.taskExecutor.getCapabilityRegistry().get("mcp.discover");
      if (mcpCap) {
        const allowedRoots = this.taskExecutor.getPolicyService().getAllowedRoots();
        const res = await mcpCap.execute(
          {
            taskId: "local-mcp-sync",
            deviceId: this.identity?.deviceId || "",
            workspaceId: this.config?.workspaceId || "",
            policyService: this.taskExecutor.getPolicyService(),
            sandbox: new (await import("../sandbox/processSandbox.js")).ProcessSandbox(),
            allowedRoots,
          },
          {}
        );

        const frame: BridgeMcpDiscoveredFrame = {
          type: "device.mcp.discovered",
          servers: (res.servers as any) || [],
          timestamp: Date.now(),
        };
        this.send(frame);
      }
    } catch {}
  }

  private handleTaskDispatch(frame: DeviceTaskDispatchFrame): void {
    if (!this.deviceTaskSigningKey || !this.identity) {
      this.send({
        type: "device.task.failed",
        taskId: frame.taskId,
        code: "MISSING_SIGNING_KEY",
        message: "Device per-device HMAC signing key is not provisioned on this connection.",
        durationMs: 0,
        timestamp: Date.now(),
      });
      return;
    }

    this.taskExecutor.executeTask(
      frame,
      {
        hmacSecret: this.deviceTaskSigningKey,
        expectedDeviceId: this.identity.deviceId,
        expectedWorkspaceId: this.config?.workspaceId,
        expectedProtocolVersion: DEVICE_CONSTANTS.PROTOCOL_VERSION,
        expectedAudience: "messiah-bridge",
      },
      {
        onAccepted: (taskId) => {
          this.send({ type: "device.task.accepted", taskId, timestamp: Date.now() });
        },
        onStarted: (taskId, sandboxProfile) => {
          this.send({ type: "device.task.started", taskId, sandboxProfile, timestamp: Date.now() });
        },
        onProgress: (taskId, percent, message) => {
          this.send({ type: "device.task.progress", taskId, progressPercent: percent, message, timestamp: Date.now() });
        },
        onLog: (taskId, sequence, stream, chunk) => {
          this.send({
            type: "device.task.log",
            taskId,
            sequence,
            stream,
            chunk: LogRedactor.redact(chunk),
            timestamp: Date.now(),
          });
        },
        onApprovalRequired: (taskId, approval) => {
          this.send({
            type: "device.approval.required",
            taskId,
            ...approval,
          });
        },
        onCompleted: (taskId, result, durationMs) => {
          this.send({ type: "device.task.completed", taskId, result, durationMs, timestamp: Date.now() });
        },
        onFailed: (taskId, code, message, durationMs) => {
          this.send({
            type: "device.task.failed",
            taskId,
            code,
            message: LogRedactor.redact(message),
            durationMs,
            timestamp: Date.now(),
          });
        },
        onCancelled: (taskId, reason) => {
          this.send({ type: "device.task.cancelled", taskId, reason, timestamp: Date.now() });
        },
        onUnknownOutcome: (taskId, reason) => {
          this.send({ type: "device.task.unknown_outcome", taskId, reason, timestamp: Date.now() });
        },
      }
    );
  }

  private async handleTaskCancel(taskId: string, reason: string): Promise<void> {
    const res = await this.taskExecutor.cancelTask(taskId);
    if (res.confirmed) {
      this.send({
        type: "device.task.cancelled",
        taskId,
        reason: reason || "Process tree termination confirmed.",
        timestamp: Date.now(),
      });
    } else {
      this.send({
        type: "device.task.unknown_outcome",
        taskId,
        reason: "Could not confirm child process tree termination after cancellation request.",
        timestamp: Date.now(),
      });
    }
  }

  private scheduleReconnect(): void {
    if (!this.isRunning || this.isRevoked) return;

    this.reconnectAttempts++;
    const baseDelay = Math.min(30000, 1000 * Math.pow(2, Math.min(this.reconnectAttempts, 5)));
    const jitter = Math.floor(Math.random() * 1000);
    const delay = baseDelay + jitter;

    this.emit("reconnecting", { attempt: this.reconnectAttempts, delayMs: delay });

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  public async stop(reason = "Daemon shutting down"): Promise<void> {
    this.isRunning = false;
    this.deviceTaskSigningKey = null;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const disconnectFrame: BridgeDisconnectFrame = {
        type: "device.disconnect",
        reason,
      };
      try {
        this.ws.send(JSON.stringify(disconnectFrame));
      } catch {}
      try {
        this.ws.close(1000, reason);
      } catch {}
    }

    this.isConnected = false;
    this.ws = null;
  }
}
