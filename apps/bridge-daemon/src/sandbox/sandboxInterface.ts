export class SandboxUnavailableError extends Error {
  public readonly code = "SANDBOX_UNAVAILABLE";

  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

export interface SandboxCapabilities {
  hasFilesystemIsolation: boolean;
  hasNetworkIsolation: boolean;
  hasProcessTreeControl: boolean;
  hasResourceLimits: boolean;
  providerName: string;
}

export interface SandboxExecutionOptions {
  taskId?: string;
  executable: string;
  args: string[];
  cwd: string;
  allowedMounts: string[];
  readOnlyMounts?: string[];
  writableMounts?: string[];
  env?: Record<string, string>;
  explicitAllowedEnvKeys?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxMemoryBytes?: number;
  maxCpuSeconds?: number;
  networkAllowed?: boolean;
}

export interface SandboxExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  truncated: boolean;
  sandboxProfile?: string;
  killedReason?: string;
}

export interface ISandboxProvider {
  readonly name: string;
  checkAvailability(): Promise<{ available: boolean; reason?: string }>;
  getCapabilities(): SandboxCapabilities;
  execute(
    options: SandboxExecutionOptions,
    onChunk?: (stream: "stdout" | "stderr", data: string) => void
  ): Promise<SandboxExecutionResult>;
  spawnInteractive?(options: SandboxExecutionOptions): Promise<{
    child: import("node:child_process").ChildProcess;
    cleanup: () => Promise<void>;
    sandboxProfile: string;
  }>;
  terminate(taskIdOrPid?: string | number): Promise<boolean>;
}
