import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { BridgeDevicePolicy } from "@messiah/shared";

export class LocalDevicePolicyService {
  private readonly configPath: string;
  private policy: BridgeDevicePolicy;

  constructor(customDir?: string) {
    const dir = customDir || path.join(os.homedir(), ".messiah", "bridge");
    this.configPath = path.join(dir, "policy.json");
    this.policy = this.loadPolicy();
  }

  public getPolicy(): BridgeDevicePolicy {
    return { ...this.policy };
  }

  private getDefaultPolicy(): BridgeDevicePolicy {
    return {
      readOnlyRoots: [],
      writableRoots: [],
      allowedMcpServers: [],
      terminalExecutionEnabled: false, // Security invariant: terminal execution disabled by default until verified
      maxExecutionTimeoutMs: 120_000, // 2 minutes
      maxMemoryBytes: 1024 * 1024 * 1024, // 1GB
      maxCpuPercent: 80,
      maxProcesses: 5,
      networkAllowed: false,
      allowedAgentAdapters: [],
    };
  }

  public loadPolicy(): BridgeDevicePolicy {
    if (!fs.existsSync(this.configPath)) {
      const defaultPolicy = this.getDefaultPolicy();
      this.savePolicy(defaultPolicy);
      return defaultPolicy;
    }

    try {
      const raw = fs.readFileSync(this.configPath, "utf-8");
      const parsed = JSON.parse(raw);
      return {
        ...this.getDefaultPolicy(),
        ...parsed,
      };
    } catch {
      return this.getDefaultPolicy();
    }
  }

  public savePolicy(policy: BridgeDevicePolicy): void {
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(this.configPath, JSON.stringify(policy, null, 2), { mode: 0o600 });
    this.policy = policy;
  }

  public addProjectRoot(folderPath: string, writable = false): void {
    const resolved = path.resolve(folderPath);
    if (writable) {
      if (!this.policy.writableRoots.includes(resolved)) {
        this.policy.writableRoots.push(resolved);
      }
      // Remove from readOnly if present
      this.policy.readOnlyRoots = this.policy.readOnlyRoots.filter((r) => r !== resolved);
    } else {
      if (!this.policy.readOnlyRoots.includes(resolved)) {
        this.policy.readOnlyRoots.push(resolved);
      }
    }
    this.savePolicy(this.policy);
  }

  public removeProjectRoot(folderPath: string): void {
    const resolved = path.resolve(folderPath);
    this.policy.readOnlyRoots = this.policy.readOnlyRoots.filter((r) => r !== resolved);
    this.policy.writableRoots = this.policy.writableRoots.filter((r) => r !== resolved);
    this.savePolicy(this.policy);
  }

  public getAllowedRoots(): string[] {
    return Array.from(new Set([...this.policy.readOnlyRoots, ...this.policy.writableRoots]));
  }

  public isRootWritable(folderPath: string): boolean {
    const resolved = path.resolve(folderPath);
    return this.policy.writableRoots.some((w) => resolved.startsWith(w));
  }

  public isRootAllowed(folderPath: string): boolean {
    const resolved = path.resolve(folderPath);
    return this.getAllowedRoots().some((root) => resolved.startsWith(root));
  }
}
