import os from "node:os";
import { getPlatformKeystore, type IKeyStore } from "../keystore/index.js";
import { PairingClient } from "../pairing/pairingClient.js";
import { DeviceIdentityManager } from "../identity/deviceIdentity.js";

export interface DiagnosticsReport {
  timestamp: string;
  bridgeVersion: string;
  platform: string;
  architecture: string;
  osRelease: string;
  nodeVersion: string;
  memoryUsageMb: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
  };
  keystore: {
    type: string;
    isHardwareBacked: boolean;
    identityLoaded: boolean;
    publicKeyFingerprint: string | null;
  };
  pairing: {
    isPaired: boolean;
    serverUrl: string | null;
    deviceId: string | null;
    pairedAt: string | null;
  };
  networkConnectivity?: {
    endpoint: string;
    reachable: boolean;
    latencyMs?: number;
    error?: string;
  };
}

export class DiagnosticsService {
  private keystore: IKeyStore;
  private pairingClient: PairingClient;

  constructor(keystore?: IKeyStore, customConfigDir?: string) {
    this.keystore = keystore || getPlatformKeystore(customConfigDir);
    this.pairingClient = new PairingClient(this.keystore, customConfigDir);
  }

  public async runDiagnostics(): Promise<DiagnosticsReport> {
    const memory = process.memoryUsage();
    const identity = await this.keystore.loadIdentity();
    const config = this.pairingClient.getSavedConfig();

    let networkCheck: DiagnosticsReport["networkConnectivity"] | undefined;
    if (config?.serverUrl) {
      const target = `${config.serverUrl.replace(/\/+$/, "")}/health/live`;
      const start = Date.now();
      try {
        const res = await fetch(target, { method: "GET", signal: AbortSignal.timeout(5000) });
        const latency = Date.now() - start;
        networkCheck = {
          endpoint: target,
          reachable: res.ok,
          latencyMs: latency,
        };
      } catch (err: unknown) {
        networkCheck = {
          endpoint: target,
          reachable: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    return {
      timestamp: new Date().toISOString(),
      bridgeVersion: DeviceIdentityManager.VERSION,
      platform: os.platform(),
      architecture: os.arch(),
      osRelease: os.release(),
      nodeVersion: process.version,
      memoryUsageMb: {
        rss: Math.round(memory.rss / (1024 * 1024)),
        heapTotal: Math.round(memory.heapTotal / (1024 * 1024)),
        heapUsed: Math.round(memory.heapUsed / (1024 * 1024)),
      },
      keystore: {
        type: this.keystore.name,
        isHardwareBacked: this.keystore.isHardwareBacked ? this.keystore.isHardwareBacked() : false,
        identityLoaded: !!identity,
        publicKeyFingerprint: identity?.publicKeyFingerprint ?? null,
      },
      pairing: {
        isPaired: !!config,
        serverUrl: config?.serverUrl ?? null,
        deviceId: config?.deviceId ?? null,
        pairedAt: config?.pairedAt ?? null,
      },
      networkConnectivity: networkCheck,
    };
  }
}
