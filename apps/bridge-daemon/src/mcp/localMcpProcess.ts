import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { LocalMcpServerConfig } from "./localMcpRegistry.js";
import { PathGuard } from "../filesystem/pathGuard.js";

export interface McpToolItem {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export class LocalMcpProcess {
  private child: ChildProcess | null = null;
  private pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();
  private messageId = 1;
  private rl: readline.Interface | null = null;

  constructor(
    private readonly config: LocalMcpServerConfig,
    private readonly allowedMounts: string[]
  ) {}

  public async start(): Promise<void> {
    const cwd = this.config.cwd
      ? PathGuard.resolveAndValidate(this.allowedMounts, this.config.cwd, "")
      : this.allowedMounts[0] || process.cwd();

    const sanitizedEnv = {
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      NODE_ENV: "production",
      ...(this.config.env || {}),
    };

    this.child = spawn(this.config.command, this.config.args, {
      cwd,
      env: sanitizedEnv,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (!this.child.stdout || !this.child.stdin) {
      throw new Error(`Failed to initialize stdio streams for MCP server '${this.config.serverName}'.`);
    }

    // Line-delimited JSON-RPC parser on stdout (never corrupted by stderr)
    this.rl = readline.createInterface({
      input: this.child.stdout,
      terminal: false,
    });

    this.rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        if (msg.id && this.pendingRequests.has(msg.id)) {
          const handler = this.pendingRequests.get(msg.id)!;
          this.pendingRequests.delete(msg.id);
          if (msg.error) {
            handler.reject(new Error(msg.error.message || "MCP RPC Error"));
          } else {
            handler.resolve(msg.result);
          }
        }
      } catch {}
    });

    // Stderr logging: captures errors and diagnostics without polluting JSON-RPC channel
    this.child.stderr?.on("data", () => {
      // Intentionally separated from stdout
    });

    this.child.on("error", (err) => {
      for (const [, handler] of this.pendingRequests) {
        handler.reject(err);
      }
      this.pendingRequests.clear();
    });

    // Send MCP initialize handshake
    await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "messiah-bridge-daemon", version: "0.1.0" },
    });

    // Send initialized notification
    this.sendNotification("notifications/initialized", {});
  }

  public async listTools(): Promise<McpToolItem[]> {
    const res = await this.sendRequest("tools/list", {});
    return (res?.tools as McpToolItem[]) || [];
  }

  public async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    return this.sendRequest("tools/call", { name, arguments: args });
  }

  private sendRequest(method: string, params: Record<string, unknown>): Promise<any> {
    if (!this.child || !this.child.stdin) {
      return Promise.reject(new Error("Local MCP process is not running."));
    }

    const id = this.messageId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Timeout waiting for local MCP response to '${method}'.`));
        }
      }, 30_000);

      this.pendingRequests.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.child!.stdin!.write(payload);
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    if (!this.child || !this.child.stdin) return;
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this.child.stdin.write(payload);
  }

  public async stop(): Promise<void> {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.child) {
      this.child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.child?.kill("SIGKILL");
          resolve();
        }, 3_000);

        this.child?.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      this.child = null;
    }
  }
}
