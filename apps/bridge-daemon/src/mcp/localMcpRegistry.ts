import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export interface LocalMcpServerConfig {
  serverName: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  allowedEnvKeys?: string[];
  writableMounts?: string[];
  networkPolicy?: boolean;
  /** Cryptographic & supply-chain pinning fields */
  pinnedExecutablePath?: string;
  pinnedExecutableSha256?: string;
  packageName?: string;
  packageVersion?: string;
  approvedArgsHash?: string;
  approvedSchemaHash?: string;
  userConfirmedAt?: string;
}

export class LocalMcpRegistry {
  private readonly configPath: string;
  private servers = new Map<string, LocalMcpServerConfig>();

  constructor(customDir?: string) {
    const dir = customDir || path.join(os.homedir(), ".messiah", "bridge");
    this.configPath = path.join(dir, "mcp_servers.json");
    this.loadServers();
  }

  public static resolveExecutablePath(command: string): string | null {
    if (path.isAbsolute(command)) {
      return fs.existsSync(command) ? fs.realpathSync(command) : null;
    }
    try {
      const cmd = os.platform() === "win32" ? "where" : "which";
      const out = execFileSync(cmd, [command], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
      const firstLine = out.split(/\r?\n/)[0]?.trim();
      if (firstLine && fs.existsSync(firstLine)) {
        return fs.realpathSync(firstLine);
      }
    } catch {}
    return null;
  }

  public static computeFileSha256(filePath: string): string | null {
    try {
      const data = fs.readFileSync(filePath);
      return crypto.createHash("sha256").update(data).digest("hex");
    } catch {
      return null;
    }
  }

  public static computeArgsHash(command: string, args: string[]): string {
    return crypto.createHash("sha256").update(JSON.stringify({ command, args })).digest("hex");
  }

  /**
   * Blocks autonomous package auto-install patterns unless explicitly confirmed by the user.
   */
  public static isAutoInstallCommand(command: string, args: string[]): boolean {
    const base = path.basename(command).toLowerCase();
    const joined = args.join(" ").toLowerCase();
    if ((base === "npx" || base === "bunx") && (args.includes("-y") || args.includes("--yes"))) {
      return true;
    }
    if ((base === "npm" || base === "pnpm" || base === "yarn") && /\b(install|add|dlx)\b/.test(joined)) {
      return true;
    }
    if ((base === "pip" || base === "pip3" || base === "uv") && /\binstall\b/.test(joined)) {
      return true;
    }
    return false;
  }

  public loadServers(): void {
    if (!fs.existsSync(this.configPath)) {
      this.servers.clear();
      return;
    }

    try {
      const raw = fs.readFileSync(this.configPath, "utf-8");
      const list = JSON.parse(raw) as LocalMcpServerConfig[];
      this.servers.clear();
      for (const item of list) {
        this.servers.set(item.serverName, item);
      }
    } catch {
      this.servers.clear();
    }
  }

  public saveServers(): void {
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const list = Array.from(this.servers.values());
    fs.writeFileSync(this.configPath, JSON.stringify(list, null, 2), { mode: 0o600 });
  }

  /**
   * Registers a local MCP server after verifying explicit user confirmation and pinning executable identity.
   */
  public registerServer(config: LocalMcpServerConfig, options?: { userConfirmed?: boolean }): LocalMcpServerConfig {
    const confirmed = Boolean(options?.userConfirmed || config.userConfirmedAt);
    if (LocalMcpRegistry.isAutoInstallCommand(config.command, config.args) && !confirmed) {
      throw new Error(
        `Refusing automatic package installation command '${config.command} ${config.args.join(" ")}' without explicit user confirmation.`
      );
    }

    const resolvedExe = config.pinnedExecutablePath || LocalMcpRegistry.resolveExecutablePath(config.command);
    const exeHash =
      config.pinnedExecutableSha256 || (resolvedExe ? LocalMcpRegistry.computeFileSha256(resolvedExe) || undefined : undefined);

    const pinned: LocalMcpServerConfig = {
      ...config,
      pinnedExecutablePath: resolvedExe || undefined,
      pinnedExecutableSha256: exeHash,
      approvedArgsHash: config.approvedArgsHash || LocalMcpRegistry.computeArgsHash(config.command, config.args),
      userConfirmedAt: config.userConfirmedAt || (confirmed ? new Date().toISOString() : undefined),
    };

    this.servers.set(pinned.serverName, pinned);
    this.saveServers();
    return pinned;
  }

  public updateApprovedSchemaHash(serverName: string, schemaHash: string): void {
    const existing = this.servers.get(serverName);
    if (!existing) return;
    existing.approvedSchemaHash = schemaHash;
    this.servers.set(serverName, existing);
    this.saveServers();
  }

  public unregisterServer(serverName: string): boolean {
    const deleted = this.servers.delete(serverName);
    if (deleted) this.saveServers();
    return deleted;
  }

  public getServer(serverName: string): LocalMcpServerConfig | undefined {
    return this.servers.get(serverName);
  }

  public getAllServers(): LocalMcpServerConfig[] {
    return Array.from(this.servers.values());
  }
}
