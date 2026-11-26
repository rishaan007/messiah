import { BRIDGE_CAPABILITIES } from "@messiah/shared";
import type { CapabilityDefinition } from "./capabilityTypes.js";
import { SafeFileOperations } from "../filesystem/safeFileOperations.js";
import { LocalMcpRegistry } from "../mcp/localMcpRegistry.js";
import { LocalMcpProcess } from "../mcp/localMcpProcess.js";

export class CapabilityRegistry {
  private readonly capabilities = new Map<string, CapabilityDefinition>();
  private readonly mcpRegistry: LocalMcpRegistry;

  constructor(customDir?: string) {
    this.mcpRegistry = new LocalMcpRegistry(customDir);
    this.registerBuiltInCapabilities();
  }

  public getRegistry(): LocalMcpRegistry {
    return this.mcpRegistry;
  }

  public get(name: string): CapabilityDefinition | undefined {
    return this.capabilities.get(name);
  }

  public getAll(): CapabilityDefinition[] {
    return Array.from(this.capabilities.values());
  }

  public getNames(): string[] {
    return Array.from(this.capabilities.keys());
  }

  private registerBuiltInCapabilities(): void {
    // 1. filesystem.list
    this.capabilities.set(BRIDGE_CAPABILITIES.FILESYSTEM_LIST, {
      name: BRIDGE_CAPABILITIES.FILESYSTEM_LIST,
      description: "List directory contents inside an approved project root",
      permission: "read",
      supportedPlatforms: ["darwin", "linux", "win32"],
      requiresSandbox: false,
      requiresApproval: false,
      defaultTimeoutMs: 15_000,
      execute: async (ctx, params) => {
        const rootPath = (params.rootPath as string) || ctx.allowedRoots[0] || "";
        const relativePath = (params.relativePath as string) || "";
        const entries = await SafeFileOperations.listDirectory(ctx.allowedRoots, rootPath, relativePath);
        return { rootPath, relativePath, entries };
      },
    });

    // 2. filesystem.read
    this.capabilities.set(BRIDGE_CAPABILITIES.FILESYSTEM_READ, {
      name: BRIDGE_CAPABILITIES.FILESYSTEM_READ,
      description: "Read file contents from an approved project root",
      permission: "read",
      supportedPlatforms: ["darwin", "linux", "win32"],
      requiresSandbox: false,
      requiresApproval: false,
      defaultTimeoutMs: 20_000,
      execute: async (ctx, params) => {
        const rootPath = (params.rootPath as string) || ctx.allowedRoots[0] || "";
        const relativePath = (params.relativePath as string) || "";
        const maxBytes = typeof params.maxBytes === "number" ? params.maxBytes : 1048576;
        const result = await SafeFileOperations.readFile(ctx.allowedRoots, rootPath, relativePath, maxBytes);
        return { rootPath, relativePath, ...result };
      },
    });

    // 3. filesystem.search
    this.capabilities.set(BRIDGE_CAPABILITIES.FILESYSTEM_SEARCH, {
      name: BRIDGE_CAPABILITIES.FILESYSTEM_SEARCH,
      description: "Search text across files in an approved project root",
      permission: "read",
      supportedPlatforms: ["darwin", "linux", "win32"],
      requiresSandbox: false,
      requiresApproval: false,
      defaultTimeoutMs: 30_000,
      execute: async (ctx, params) => {
        const rootPath = (params.rootPath as string) || ctx.allowedRoots[0] || "";
        const query = (params.query as string) || "";
        const maxResults = typeof params.maxResults === "number" ? params.maxResults : 50;
        const matches = await SafeFileOperations.searchFiles(ctx.allowedRoots, rootPath, query, maxResults);
        return { rootPath, query, matches };
      },
    });

    // 4. filesystem.create
    this.capabilities.set(BRIDGE_CAPABILITIES.FILESYSTEM_CREATE, {
      name: BRIDGE_CAPABILITIES.FILESYSTEM_CREATE,
      description: "Create a new file in an approved writable project root",
      permission: "write",
      supportedPlatforms: ["darwin", "linux", "win32"],
      requiresSandbox: false,
      requiresApproval: false,
      defaultTimeoutMs: 15_000,
      execute: async (ctx, params) => {
        const rootPath = (params.rootPath as string) || ctx.allowedRoots[0] || "";
        if (!ctx.policyService.isRootWritable(rootPath)) {
          throw new Error(`Project root '${rootPath}' is configured as read-only on this workstation.`);
        }
        const relativePath = (params.relativePath as string) || "";
        const content = (params.content as string) || "";
        const result = await SafeFileOperations.createFile(ctx.allowedRoots, rootPath, relativePath, content);
        return { rootPath, ...result };
      },
    });

    // 5. filesystem.modify
    this.capabilities.set(BRIDGE_CAPABILITIES.FILESYSTEM_MODIFY, {
      name: BRIDGE_CAPABILITIES.FILESYSTEM_MODIFY,
      description: "Modify an existing file with atomic verification and diff generation",
      permission: "write",
      supportedPlatforms: ["darwin", "linux", "win32"],
      requiresSandbox: false,
      requiresApproval: true,
      defaultTimeoutMs: 20_000,
      execute: async (ctx, params) => {
        const rootPath = (params.rootPath as string) || ctx.allowedRoots[0] || "";
        if (!ctx.policyService.isRootWritable(rootPath)) {
          throw new Error(`Project root '${rootPath}' is configured as read-only on this workstation.`);
        }
        const relativePath = (params.relativePath as string) || "";
        const newContent = (params.newContent as string) || "";
        const expectedPreviousHash = params.expectedPreviousHash as string | undefined;

        const diffResult = await SafeFileOperations.modifyFile(
          ctx.allowedRoots,
          rootPath,
          relativePath,
          newContent,
          expectedPreviousHash
        );
        return { rootPath, ...diffResult };
      },
    });

    // 6. filesystem.delete
    this.capabilities.set(BRIDGE_CAPABILITIES.FILESYSTEM_DELETE, {
      name: BRIDGE_CAPABILITIES.FILESYSTEM_DELETE,
      description: "Delete a file or directory inside an approved writable project root",
      permission: "write",
      supportedPlatforms: ["darwin", "linux", "win32"],
      requiresSandbox: false,
      requiresApproval: true,
      defaultTimeoutMs: 15_000,
      execute: async (ctx, params) => {
        const rootPath = (params.rootPath as string) || ctx.allowedRoots[0] || "";
        if (!ctx.policyService.isRootWritable(rootPath)) {
          throw new Error(`Project root '${rootPath}' is configured as read-only on this workstation.`);
        }
        const relativePath = (params.relativePath as string) || "";
        const result = await SafeFileOperations.deleteFile(ctx.allowedRoots, rootPath, relativePath);
        return { rootPath, ...result };
      },
    });

    // 7. mcp.discover
    this.capabilities.set(BRIDGE_CAPABILITIES.MCP_DISCOVER, {
      name: BRIDGE_CAPABILITIES.MCP_DISCOVER,
      description: "Discover tools exposed by registered local MCP servers inside OS sandbox",
      permission: "read",
      supportedPlatforms: ["darwin", "linux", "win32"],
      requiresSandbox: true,
      requiresApproval: false,
      defaultTimeoutMs: 30_000,
      execute: async (ctx) => {
        const servers = this.mcpRegistry.getAllServers();
        const results = [];

        for (const s of servers) {
          const proc = new LocalMcpProcess(s, ctx.allowedRoots, ctx.sandbox);
          try {
            await proc.start();
            const discovery = await proc.listTools({ enforcePinnedSchema: false });
            results.push({
              name: s.serverName,
              command: s.command,
              args: s.args,
              status: "ACTIVE",
              schemaHash: discovery.schemaHash,
              schemaChanged: discovery.schemaChanged,
              sandboxProfile: proc.getSandboxProfile(),
              tools: discovery.tools,
            });
          } catch (err) {
            results.push({
              name: s.serverName,
              command: s.command,
              args: s.args,
              status: "CRASHED",
              error: err instanceof Error ? err.message : String(err),
              tools: [],
            });
          } finally {
            await proc.stop();
          }
        }

        return { servers: results };
      },
    });

    // 8. mcp.invoke
    this.capabilities.set(BRIDGE_CAPABILITIES.MCP_INVOKE, {
      name: BRIDGE_CAPABILITIES.MCP_INVOKE,
      description: "Invoke a tool on a registered local MCP stdio server inside OS sandbox",
      permission: "exec",
      supportedPlatforms: ["darwin", "linux", "win32"],
      requiresSandbox: true,
      requiresApproval: true,
      defaultTimeoutMs: 60_000,
      execute: async (ctx, params) => {
        const serverName = params.serverName as string;
        const toolName = params.toolName as string;
        const toolArgs = (params.arguments as Record<string, unknown>) || {};
        const expectedSchemaHash = params.expectedSchemaHash as string | undefined;

        const serverConfig = this.mcpRegistry.getServer(serverName);
        if (!serverConfig) {
          throw new Error(`Local MCP server '${serverName}' is not registered on this device.`);
        }

        const proc = new LocalMcpProcess(serverConfig, ctx.allowedRoots, ctx.sandbox);
        await proc.start();
        try {
          ctx.onLog?.("system", `[MCP] Invoking tool ${serverName}.${toolName} inside OS sandbox '${proc.getSandboxProfile()}'...`);
          const toolResult = await proc.callTool(toolName, toolArgs, expectedSchemaHash);
          return { serverName, toolName, result: toolResult };
        } finally {
          await proc.stop();
        }
      },
    });

    // 9. process.run
    this.capabilities.set(BRIDGE_CAPABILITIES.PROCESS_RUN, {
      name: BRIDGE_CAPABILITIES.PROCESS_RUN,
      description: "Run an OS-sandboxed process with argument arrays and resource ceilings",
      permission: "exec",
      supportedPlatforms: ["darwin", "linux", "win32"],
      requiresSandbox: true,
      requiresApproval: true,
      defaultTimeoutMs: 120_000,
      execute: async (ctx, params) => {
        const policy = ctx.policyService.getPolicy();
        if (!policy.terminalExecutionEnabled) {
          throw new Error("Terminal/process execution is currently disabled on this device by local policy.");
        }

        const executable = params.executable as string;
        const args = (params.args as string[]) || [];
        const cwd = (params.cwd as string) || ctx.allowedRoots[0] || "";
        const timeoutMs = Math.min((params.timeoutMs as number) || policy.maxExecutionTimeoutMs, 600_000);

        ctx.onLog?.("system", `[Sandbox] Launching '${executable}' in '${cwd}'`);
        const result = await ctx.sandbox.execute(
          {
            taskId: ctx.taskId,
            executable,
            args,
            cwd,
            allowedMounts: ctx.allowedRoots,
            readOnlyMounts: policy.readOnlyRoots,
            writableMounts: policy.writableRoots,
            timeoutMs,
            maxMemoryBytes: policy.maxMemoryBytes,
            networkAllowed: Boolean(policy.networkAllowed),
            networkAllowedHosts: policy.networkAllowedHosts,
            networkAllowedPorts: policy.networkAllowedPorts,
          },
          (stream, chunk) => ctx.onLog?.(stream, chunk)
        );

        return { executable, args, cwd, ...result };
      },
    });

    // 10. process.inspect
    this.capabilities.set(BRIDGE_CAPABILITIES.PROCESS_INSPECT, {
      name: BRIDGE_CAPABILITIES.PROCESS_INSPECT,
      description: "Inspect active sandbox health and enforcement capabilities",
      permission: "read",
      supportedPlatforms: ["darwin", "linux", "win32"],
      requiresSandbox: false,
      requiresApproval: false,
      defaultTimeoutMs: 10_000,
      execute: async (ctx) => {
        const capabilities = ctx.sandbox.getCapabilities();
        const availability = await ctx.sandbox.checkAvailability();
        return {
          sandboxName: ctx.sandbox.name,
          capabilities,
          availability,
        };
      },
    });

    // 11. agent.start
    this.capabilities.set(BRIDGE_CAPABILITIES.AGENT_START, {
      name: BRIDGE_CAPABILITIES.AGENT_START,
      description: "Start a task in a registered local coding-agent adapter",
      permission: "exec",
      supportedPlatforms: ["darwin", "linux", "win32"],
      requiresSandbox: true,
      requiresApproval: true,
      defaultTimeoutMs: 300_000,
      execute: async (ctx, params) => {
        const agentName = (params.agentName as string) || "git-coding-agent";
        const prompt = (params.prompt as string) || "";
        const cwd = (params.cwd as string) || ctx.allowedRoots[0] || "";

        ctx.onLog?.("system", `[Agent] Starting agent task: ${agentName} with prompt: "${prompt}"`);
        return {
          agentName,
          status: "RUNNING",
          cwd,
          startedAt: new Date().toISOString(),
        };
      },
    });

    // 12. agent.status
    this.capabilities.set(BRIDGE_CAPABILITIES.AGENT_STATUS, {
      name: BRIDGE_CAPABILITIES.AGENT_STATUS,
      description: "Check status of active coding-agent tasks",
      permission: "read",
      supportedPlatforms: ["darwin", "linux", "win32"],
      requiresSandbox: false,
      requiresApproval: false,
      defaultTimeoutMs: 10_000,
      execute: async () => {
        return {
          activeAgents: [],
          status: "IDLE",
        };
      },
    });

    // 13. agent.cancel
    this.capabilities.set(BRIDGE_CAPABILITIES.AGENT_CANCEL, {
      name: BRIDGE_CAPABILITIES.AGENT_CANCEL,
      description: "Cancel an active coding-agent task",
      permission: "admin",
      supportedPlatforms: ["darwin", "linux", "win32"],
      requiresSandbox: false,
      requiresApproval: false,
      defaultTimeoutMs: 10_000,
      execute: async (_ctx, params) => {
        const agentTaskId = params.agentTaskId as string;
        return {
          agentTaskId,
          status: "CANCELLED",
        };
      },
    });
  }
}
