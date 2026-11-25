import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface LocalMcpServerConfig {
  serverName: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  networkPolicy?: boolean;
}

export class LocalMcpRegistry {
  private readonly configPath: string;
  private servers = new Map<string, LocalMcpServerConfig>();

  constructor(customDir?: string) {
    const dir = customDir || path.join(os.homedir(), ".messiah", "bridge");
    this.configPath = path.join(dir, "mcp_servers.json");
    this.loadServers();
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

  public registerServer(config: LocalMcpServerConfig): void {
    this.servers.set(config.serverName, config);
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
