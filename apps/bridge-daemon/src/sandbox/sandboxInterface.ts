export interface SandboxCapabilities {
  hasFilesystemIsolation: boolean;
  hasNetworkIsolation: boolean;
  hasProcessTreeControl: boolean;
  hasResourceLimits: boolean;
  providerName: string;
}

export interface SandboxExecutionOptions {
  executable: string;
  args: string[];
  cwd: string;
  allowedMounts: string[];
  readOnlyMounts?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  networkAllowed?: boolean;
}

export interface SandboxExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  truncated: boolean;
}

export interface ISandboxProvider {
  readonly name: string;
  checkAvailability(): Promise<{ available: boolean; reason?: string }>;
  getCapabilities(): SandboxCapabilities;
  execute(
    options: SandboxExecutionOptions,
    onChunk?: (stream: "stdout" | "stderr", data: string) => void
  ): Promise<SandboxExecutionResult>;
  terminate(processId?: number): Promise<void>;
}
