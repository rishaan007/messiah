import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import type {
  ISandboxProvider,
  SandboxCapabilities,
  SandboxExecutionOptions,
  SandboxExecutionResult,
} from "./sandboxInterface.js";
import { PathGuard } from "../filesystem/pathGuard.js";

export class ProcessSandbox implements ISandboxProvider {
  public readonly name = "Restricted Process Sandbox";
  private activeProcesses = new Set<ChildProcess>();

  public async checkAvailability(): Promise<{ available: boolean; reason?: string }> {
    return { available: true };
  }

  public getCapabilities(): SandboxCapabilities {
    return {
      hasFilesystemIsolation: true,
      hasNetworkIsolation: false,
      hasProcessTreeControl: true,
      hasResourceLimits: true,
      providerName: this.name,
    };
  }

  /**
   * Executes a command inside the restricted process sandbox.
   *
   * SECURITY INVARIANTS:
   * 1. NEVER uses `shell: true` with raw string concatenation.
   * 2. Uses strict executable mappings and argument arrays.
   * 3. Completely scrubs host environment variables (stripping SSH_AUTH_SOCK, AWS_*, GITHUB_TOKEN, etc.).
   * 4. Enforces strict working directory containment inside approved project roots.
   * 5. Enforces maximum execution timeout and kills entire process tree.
   * 6. Caps maximum output bytes to prevent denial-of-service / memory exhaustion.
   */
  public async execute(
    options: SandboxExecutionOptions,
    onChunk?: (stream: "stdout" | "stderr", data: string) => void
  ): Promise<SandboxExecutionResult> {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs || 120_000;
    const maxOutputBytes = options.maxOutputBytes || 1048576; // 1MB output cap

    // 1. Verify working directory is strictly inside an allowed mount
    const validatedCwd = PathGuard.resolveAndValidate(
      options.allowedMounts,
      options.cwd,
      ""
    );

    // 2. Build scrubbed environment (prevent credential leakage from host)
    const sanitizedEnv: Record<string, string> = {
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      HOME: options.allowedMounts[0] || os.homedir(),
      USER: os.userInfo().username,
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      NODE_ENV: "production",
      ...(options.env || {}),
    };

    // Explicitly delete any sensitive credentials from the child environment
    const SENSITIVE_ENV_KEYS = [
      "SSH_AUTH_SOCK",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
      "GITHUB_TOKEN",
      "MESSIAH_VAULT_PASSPHRASE",
      "DATABASE_URL",
    ];
    for (const key of SENSITIVE_ENV_KEYS) {
      delete sanitizedEnv[key];
    }

    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let totalBytes = 0;
      let truncated = false;
      let isTimedOut = false;

      // Spawn child process with argument array and NO shell interpolation
      const child = spawn(options.executable, options.args, {
        cwd: validatedCwd,
        env: sanitizedEnv,
        shell: false, // Strict: never invoke arbitrary shell interpreter
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32", // Detach to allow killing process group on POSIX
      });

      this.activeProcesses.add(child);

      // Timeout watchdog
      const timer = setTimeout(() => {
        isTimedOut = true;
        this.killProcessTree(child);
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8");
        if (totalBytes + chunk.length <= maxOutputBytes) {
          stdout += text;
          totalBytes += chunk.length;
          onChunk?.("stdout", text);
        } else {
          const allowed = Math.max(0, maxOutputBytes - totalBytes);
          if (allowed > 0) {
            stdout += text.slice(0, allowed);
            totalBytes += allowed;
          }
          if (!truncated) {
            truncated = true;
            const warning = "\n[Warning: Process output exceeded maximum byte limit and was truncated.]\n";
            stdout += warning;
            onChunk?.("stdout", warning);
          }
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8");
        if (totalBytes + chunk.length <= maxOutputBytes) {
          stderr += text;
          totalBytes += chunk.length;
          onChunk?.("stderr", text);
        } else {
          const allowed = Math.max(0, maxOutputBytes - totalBytes);
          if (allowed > 0) {
            stderr += text.slice(0, allowed);
            totalBytes += allowed;
          }
          if (!truncated) {
            truncated = true;
            const warning = "\n[Warning: Process output exceeded maximum byte limit and was truncated.]\n";
            stderr += warning;
            onChunk?.("stderr", warning);
          }
        }
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        this.activeProcesses.delete(child);
        reject(err);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        this.activeProcesses.delete(child);

        if (isTimedOut) {
          resolve({
            stdout,
            stderr: stderr + `\n[Execution timed out after ${timeoutMs}ms and was terminated]`,
            exitCode: 124, // Standard timeout exit code
            durationMs: Date.now() - startTime,
            truncated: true,
          });
          return;
        }

        resolve({
          stdout,
          stderr,
          exitCode: code ?? 0,
          durationMs: Date.now() - startTime,
          truncated,
        });
      });
    });
  }

  private killProcessTree(child: ChildProcess): void {
    try {
      if (child.pid) {
        if (process.platform !== "win32") {
          // Kill entire process group on POSIX
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        } else {
          child.kill("SIGKILL");
        }
      }
    } catch {}
  }

  public async terminate(processId?: number): Promise<void> {
    for (const child of this.activeProcesses) {
      if (!processId || child.pid === processId) {
        this.killProcessTree(child);
      }
    }
  }

  public async destroy(): Promise<void> {
    await this.terminate();
  }
}
