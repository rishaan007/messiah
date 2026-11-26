import type { ChildProcess } from "node:child_process";
import readline from "node:readline";
import crypto from "node:crypto";
import { LocalMcpRegistry, type LocalMcpServerConfig } from "./localMcpRegistry.js";
import { PathGuard } from "../filesystem/pathGuard.js";
import { ProcessSandbox } from "../sandbox/processSandbox.js";
import { SandboxUnavailableError, type ISandboxProvider } from "../sandbox/sandboxInterface.js";
import { LogRedactor } from "../security/logRedactor.js";

export interface McpToolItem {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export class McpSecurityError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "McpSecurityError";
  }
}

export class LocalMcpProcess {
  private child: ChildProcess | null = null;
  private sandboxCleanup: (() => Promise<void>) | null = null;
  private sandboxProfile = "unknown";
  private stderrLogs: string[] = [];
  private pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();
  private messageId = 1;
  private rl: readline.Interface | null = null;

  constructor(
    private readonly config: LocalMcpServerConfig,
    private readonly allowedMounts: string[],
    private readonly sandbox: ISandboxProvider = new ProcessSandbox()
  ) {}

  public getStderrLogs(): string[] {
    return [...this.stderrLogs];
  }

  public getSandboxProfile(): string {
    return this.sandboxProfile;
  }

  public static computeToolsSchemaHash(tools: McpToolItem[]): string {
    const normalized = [...tools]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
        name: t.name,
        description: t.description || "",
        inputSchema: t.inputSchema,
      }));
    return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  }

  /**
   * Verifies executable pinning and launch configuration integrity before startup.
   */
  private verifyConfigurationIntegrity(): string {
    if (LocalMcpRegistry.isAutoInstallCommand(this.config.command, this.config.args) && !this.config.userConfirmedAt) {
      throw new McpSecurityError(
        "UNCONFIRMED_AUTO_INSTALL",
        `Local MCP server '${this.config.serverName}' uses auto-install command without user confirmation.`
      );
    }

    if (this.config.approvedArgsHash) {
      const currentArgsHash = LocalMcpRegistry.computeArgsHash(this.config.command, this.config.args);
      if (currentArgsHash !== this.config.approvedArgsHash) {
        throw new McpSecurityError(
          "MCP_CONFIG_DRIFT",
          `Launch configuration for '${this.config.serverName}' changed since approval.`
        );
      }
    }

    const resolvedExe = LocalMcpRegistry.resolveExecutablePath(this.config.command) || this.config.command;

    if (this.config.pinnedExecutablePath) {
      const currentResolved = LocalMcpRegistry.resolveExecutablePath(this.config.command);
      if (currentResolved && currentResolved !== this.config.pinnedExecutablePath) {
        throw new McpSecurityError(
          "MCP_EXECUTABLE_DRIFT",
          `Executable path changed for '${this.config.serverName}': expected '${this.config.pinnedExecutablePath}', got '${currentResolved}'.`
        );
      }
    }

    const targetBinary = this.config.pinnedExecutablePath || resolvedExe;
    const preSpawnMeta = LocalMcpRegistry.verifyAndHashExecutable(targetBinary);

    if (this.config.pinnedExecutableSha256) {
      if (!preSpawnMeta || preSpawnMeta.sha256 !== this.config.pinnedExecutableSha256) {
        throw new McpSecurityError(
          "MCP_EXECUTABLE_HASH_MISMATCH",
          `Executable binary SHA-256 changed for '${this.config.serverName}'. Renewed approval required.`
        );
      }
    }

    return resolvedExe;
  }

  /**
   * Starts the local MCP stdio server strictly inside the OS-enforced sandbox.
   * Fails closed if no OS sandbox is available.
   */
  public async start(): Promise<void> {
    if (!this.sandbox.spawnInteractive) {
      throw new SandboxUnavailableError("Configured sandbox provider does not support isolated stdio MCP processes.");
    }

    const resolvedExe = this.verifyConfigurationIntegrity();

    const cwd = this.config.cwd
      ? PathGuard.resolveAndValidate(this.allowedMounts, this.config.cwd, "")
      : PathGuard.resolveAndValidate(this.allowedMounts, this.allowedMounts[0] || "", "");

    // Spawn strictly inside OS sandbox (read-only authorized mounts by default, no network by default)
    const spawned = await this.sandbox.spawnInteractive({
      taskId: `mcp-${this.config.serverName}-${crypto.randomUUID().slice(0, 8)}`,
      executable: resolvedExe,
      args: this.config.args,
      cwd,
      allowedMounts: this.allowedMounts,
      writableMounts: this.config.writableMounts || [],
      env: this.config.env,
      explicitAllowedEnvKeys: this.config.allowedEnvKeys,
      networkAllowed: Boolean(this.config.networkPolicy),
      networkAllowedHosts: this.config.networkAllowedHosts,
      networkAllowedPorts: this.config.networkAllowedPorts,
    });

    // Post-spawn integrity double-check on pinned executable against TOCTOU race
    if (this.config.pinnedExecutableSha256) {
      const postSpawnMeta = LocalMcpRegistry.verifyAndHashExecutable(this.config.pinnedExecutablePath || resolvedExe);
      if (!postSpawnMeta || postSpawnMeta.sha256 !== this.config.pinnedExecutableSha256) {
        await spawned.cleanup();
        throw new McpSecurityError(
          "MCP_EXECUTABLE_HASH_MISMATCH",
          `Executable binary changed during spawn window (TOCTOU detected) for '${this.config.serverName}'.`
        );
      }
    }

    this.child = spawned.child;
    this.sandboxCleanup = spawned.cleanup;
    this.sandboxProfile = spawned.sandboxProfile;

    if (!this.child.stdout || !this.child.stdin) {
      await this.stop();
      throw new Error(`Failed to initialize stdio streams for sandboxed MCP server '${this.config.serverName}'.`);
    }

    // Line-delimited JSON-RPC parser strictly on stdout
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
            handler.reject(new Error(LogRedactor.redact(msg.error.message || "MCP RPC Error")));
          } else {
            handler.resolve(msg.result);
          }
        }
      } catch {
        // Ignore malformed lines on stdout without crashing protocol loop
      }
    });

    // Stderr separated purely for redacted diagnostic logs (never mixed into JSON-RPC)
    this.child.stderr?.on("data", (chunk: Buffer) => {
      const redacted = LogRedactor.redact(chunk.toString("utf-8"));
      if (this.stderrLogs.length < 200) {
        this.stderrLogs.push(redacted);
      }
    });

    this.child.on("error", (err) => {
      for (const [, handler] of this.pendingRequests) {
        handler.reject(err);
      }
      this.pendingRequests.clear();
    });

    this.child.on("close", (code) => {
      for (const [, handler] of this.pendingRequests) {
        handler.reject(new Error(`Sandboxed MCP process '${this.config.serverName}' exited (code=${code}).`));
      }
      this.pendingRequests.clear();
    });

    // Send MCP initialize handshake
    await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "messiah-bridge-daemon", version: "0.1.0" },
    });

    this.sendNotification("notifications/initialized", {});
  }

  /**
   * Lists tools and verifies schema against previously approved schemaHash if present.
   */
  public async listTools(options?: { enforcePinnedSchema?: boolean }): Promise<{
    tools: McpToolItem[];
    schemaHash: string;
    schemaChanged: boolean;
  }> {
    const res = await this.sendRequest("tools/list", {});
    const tools = ((res?.tools as McpToolItem[]) || []).map((t) => ({
      ...t,
      // Sanitize untrusted descriptions so prompt injections aren't treated as trusted commands
      description: t.description ? LogRedactor.redact(String(t.description)) : undefined,
    }));

    const schemaHash = LocalMcpProcess.computeToolsSchemaHash(tools);
    const schemaChanged = Boolean(
      this.config.approvedSchemaHash && this.config.approvedSchemaHash !== schemaHash
    );

    if (schemaChanged && options?.enforcePinnedSchema) {
      throw new McpSecurityError(
        "MCP_SCHEMA_CHANGED",
        `Tool schema hash changed for MCP server '${this.config.serverName}' (approved: ${this.config.approvedSchemaHash}, current: ${schemaHash}). Renewed human authorization required.`
      );
    }

    return { tools, schemaHash, schemaChanged };
  }

  /**
   * Executes a tool call only after verifying schema has not drifted, returning redacted untrusted output.
   */
  public async callTool(
    name: string,
    args: Record<string, unknown>,
    expectedSchemaHash?: string
  ): Promise<{
    untrustedToolOutput: true;
    serverName: string;
    toolName: string;
    schemaHash: string;
    rawResult: unknown;
  }> {
    const effectiveExpectedHash = expectedSchemaHash || this.config.approvedSchemaHash;
    const discovery = await this.listTools({ enforcePinnedSchema: false });

    if (effectiveExpectedHash && discovery.schemaHash !== effectiveExpectedHash) {
      throw new McpSecurityError(
        "MCP_SCHEMA_CHANGED",
        `Tool schema hash mismatch for '${this.config.serverName}' before invoking '${name}'. Expected ${effectiveExpectedHash}, got ${discovery.schemaHash}.`
      );
    }

    const result = await this.sendRequest("tools/call", { name, arguments: args });

    // Redact any accidentally leaked credentials inside MCP tool output
    let sanitizedResult: unknown = result;
    try {
      const jsonStr = JSON.stringify(result);
      sanitizedResult = JSON.parse(LogRedactor.redact(jsonStr));
    } catch {}

    return {
      untrustedToolOutput: true,
      serverName: this.config.serverName,
      toolName: name,
      schemaHash: discovery.schemaHash,
      rawResult: sanitizedResult,
    };
  }

  private sendRequest(method: string, params: Record<string, unknown>): Promise<any> {
    if (!this.child || !this.child.stdin || this.child.killed) {
      return Promise.reject(new Error("Sandboxed local MCP process is not running."));
    }

    const id = this.messageId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Timeout waiting for sandboxed MCP response to '${method}'.`));
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
    if (!this.child || !this.child.stdin || this.child.killed) return;
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this.child.stdin.write(payload);
  }

  public async stop(): Promise<void> {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.sandboxCleanup) {
      await this.sandboxCleanup();
      this.sandboxCleanup = null;
    } else if (this.child) {
      try {
        this.child.kill("SIGKILL");
      } catch {}
    }
    this.child = null;
  }
}
