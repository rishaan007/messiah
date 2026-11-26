import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  SandboxUnavailableError,
  type ISandboxProvider,
  type SandboxCapabilities,
  type SandboxExecutionOptions,
  type SandboxExecutionResult,
} from "./sandboxInterface.js";
import { SandboxDetector } from "./sandboxDetector.js";
import { EnvAllowlist } from "./envAllowlist.js";
import { PathGuard } from "../filesystem/pathGuard.js";
import { LogRedactor } from "../security/logRedactor.js";

interface ActiveTaskHandle {
  taskId: string;
  child: ChildProcess;
  killedReason?: string;
  cleanup: () => Promise<void>;
  exitPromise: Promise<void>;
}

function escapeSeatbeltLiteral(value: string): string {
  if (/[\0\r\n]/.test(value)) {
    throw new Error("Invalid control characters in Seatbelt mount path.");
  }
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export class ProcessSandbox implements ISandboxProvider {
  public readonly name = "OS-Enforced Workstation Sandbox";
  private activeTasks = new Map<string, ActiveTaskHandle>();
  private cachedProviderName: string | null = null;

  public async checkAvailability(): Promise<{ available: boolean; reason?: string }> {
    const status = await SandboxDetector.detect();
    if (status.available) {
      this.cachedProviderName = status.providerName;
    }
    return { available: status.available, reason: status.reason };
  }

  public getCapabilities(): SandboxCapabilities {
    const platform = os.platform();
    return {
      hasFilesystemIsolation: true,
      hasNetworkIsolation: true,
      hasProcessTreeControl: true,
      hasResourceLimits: true,
      providerName:
        this.cachedProviderName ||
        (platform === "darwin"
          ? "macos-seatbelt"
          : platform === "linux"
          ? "linux-bubblewrap"
          : platform === "win32"
          ? "windows-appcontainer"
          : "unsupported"),
    };
  }

  /**
   * Prepares OS-level sandbox command wrapper, isolated temporary home/tmp dirs,
   * and allowlisted environment variables. Fails closed with SandboxUnavailableError
   * if an OS-enforced sandbox cannot be initialized on the host.
   */
  private async prepareSandboxedInvocation(options: SandboxExecutionOptions): Promise<{
    spawnCommand: string;
    spawnArgs: string[];
    validatedCwd: string;
    sanitizedEnv: Record<string, string>;
    sandboxProfileName: string;
    cleanup: () => Promise<void>;
  }> {
    // 1. Verify genuine OS-enforced sandbox is available (FAIL CLOSED)
    const status = await SandboxDetector.detect();
    if (!status.available) {
      throw new SandboxUnavailableError(
        status.reason || `OS-enforced sandbox unavailable on platform '${status.platform}'.`
      );
    }
    this.cachedProviderName = status.providerName;

    // 2. Validate working directory and canonicalize mounts
    const validatedCwd = PathGuard.resolveAndValidate(options.allowedMounts, options.cwd, "");

    const canonicalWritable = (options.writableMounts || [])
      .map((p) => {
        const resolved = path.resolve(p.normalize("NFC"));
        return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
      })
      .filter(Boolean);

    const writableSet = new Set(canonicalWritable);
    const canonicalReadOnly = Array.from(
      new Set(
        [...(options.allowedMounts || []), ...(options.readOnlyMounts || [])]
          .map((p) => {
            const resolved = path.resolve(p.normalize("NFC"));
            return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
          })
          .filter((p) => p && !writableSet.has(p))
      )
    );

    // 3. Create ephemeral isolated HOME and TMPDIR for this sandboxed invocation
    const sandboxRunId = options.taskId || crypto.randomUUID();
    const sandboxRoot = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), `messiah-sb-${sandboxRunId.slice(0, 8)}-`)
    );
    fs.chmodSync(sandboxRoot, 0o700);
    const isolatedHome = path.join(sandboxRoot, "home");
    const isolatedTmp = path.join(sandboxRoot, "tmp");
    fs.mkdirSync(isolatedHome, { mode: 0o700 });
    fs.mkdirSync(isolatedTmp, { mode: 0o700 });

    // 4. Construct strict allowlist environment (never copy host secrets)
    const sanitizedEnv = EnvAllowlist.build({
      isolatedHome,
      isolatedTmp,
      customEnv: options.env,
      explicitAllowedKeys: options.explicitAllowedEnvKeys,
    });

    const cleanup = async () => {
      try {
        await fs.promises.rm(sandboxRoot, { recursive: true, force: true });
      } catch {}
    };

    // 5. Build OS-enforced wrapper invocation
    if (status.providerName === "macos-seatbelt") {
      const roSubpaths = canonicalReadOnly
        .map((p) => `  (subpath "${escapeSeatbeltLiteral(p)}")`)
        .join("\n");
      const rwSubpaths = [isolatedHome, isolatedTmp, ...canonicalWritable]
        .map((p) => `  (subpath "${escapeSeatbeltLiteral(p)}")`)
        .join("\n");

      const networkRule = options.networkAllowed ? "(allow network-outbound)" : "";
      const profileContent = `(version 1)
(deny default)
(import "system.sb")
(allow process-exec)
(allow process-fork)
(allow signal (target self))
(allow process-info* (target self))
(allow file-read-metadata)
${networkRule}
(allow file-read*
  (subpath "/usr")
  (subpath "/bin")
  (subpath "/sbin")
  (subpath "/System")
  (subpath "/Library")
  (subpath "/opt/homebrew")
  (subpath "/private/var/db")
  (subpath "/private/var/select")
  (subpath "/dev")
${roSubpaths})
(allow file-write*
  (literal "/dev/null")
  (literal "/dev/dtracehelper"))
(allow file-read* file-write*
${rwSubpaths})
(deny file-read* file-write*
  (regex #"/(?:\\.ssh|\\.aws|\\.gcp|\\.azure|\\.kube|\\.gnupg)(?:/|$)")
  (regex #"/\\.env(?:\\..*)?$")
  (regex #"/\\.messiah/bridge/device\\.")
  (regex #"\\.(?:kdbx|keychain)$"))
`;

      const profilePath = path.join(sandboxRoot, "sandbox.sb");
      fs.writeFileSync(profilePath, profileContent, { mode: 0o600 });

      return {
        spawnCommand: "/usr/bin/sandbox-exec",
        spawnArgs: ["-f", profilePath, options.executable, ...options.args],
        validatedCwd,
        sanitizedEnv,
        sandboxProfileName: "macos-seatbelt",
        cleanup,
      };
    }

    if (status.providerName === "linux-bubblewrap") {
      const bwrapArgs: string[] = [
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        ...(!options.networkAllowed ? ["--unshare-net"] : []),
        "--die-with-parent",
        "--new-session",
        "--clearenv",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
      ];

      // Read-only OS runtime trees
      for (const sysDir of ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc/ssl", "/etc/alternatives"]) {
        if (fs.existsSync(sysDir)) {
          bwrapArgs.push("--ro-bind", sysDir, sysDir);
        }
      }

      // Bind isolated HOME / TMP read-write
      bwrapArgs.push("--bind", isolatedHome, isolatedHome);
      bwrapArgs.push("--bind", isolatedTmp, isolatedTmp);

      // Bind authorized roots (read-only vs writable)
      for (const ro of canonicalReadOnly) {
        if (fs.existsSync(ro)) {
          bwrapArgs.push("--ro-bind", ro, ro);
        }
      }
      for (const rw of canonicalWritable) {
        if (fs.existsSync(rw)) {
          bwrapArgs.push("--bind", rw, rw);
        }
      }

      // Inject strict allowlisted environment
      for (const [k, v] of Object.entries(sanitizedEnv)) {
        bwrapArgs.push("--setenv", k, v);
      }

      bwrapArgs.push("--chdir", validatedCwd);
      bwrapArgs.push("--", options.executable, ...options.args);

      return {
        spawnCommand: "bwrap",
        spawnArgs: bwrapArgs,
        validatedCwd,
        sanitizedEnv,
        sandboxProfileName: "linux-bubblewrap",
        cleanup,
      };
    }

    if (status.providerName === "windows-appcontainer") {
      const helperPath = process.env.MESSIAH_WIN_APPCONTAINER_HELPER!;
      const helperConfigPath = path.join(sandboxRoot, "appcontainer.json");
      fs.writeFileSync(
        helperConfigPath,
        JSON.stringify({
          executable: options.executable,
          args: options.args,
          cwd: validatedCwd,
          readOnlyMounts: canonicalReadOnly,
          writableMounts: [isolatedHome, isolatedTmp, ...canonicalWritable],
          networkAllowed: Boolean(options.networkAllowed),
          env: sanitizedEnv,
        }),
        { mode: 0o600 }
      );

      return {
        spawnCommand: helperPath,
        spawnArgs: ["--run", helperConfigPath],
        validatedCwd,
        sanitizedEnv,
        sandboxProfileName: "windows-appcontainer",
        cleanup,
      };
    }

    await cleanup();
    throw new SandboxUnavailableError(`No OS sandbox driver for provider '${status.providerName}'.`);
  }

  /**
   * Spawns a long-lived sandboxed interactive stdio process (used for Local MCP stdio servers).
   * Exposes stdin/stdout/stderr pipes and lifecycle cleanup strictly inside the OS sandbox.
   */
  public async spawnInteractive(options: SandboxExecutionOptions): Promise<{
    child: ChildProcess;
    cleanup: () => Promise<void>;
    sandboxProfile: string;
  }> {
    const prep = await this.prepareSandboxedInvocation(options);
    const taskId = options.taskId || `mcp-${crypto.randomUUID()}`;

    const child = spawn(prep.spawnCommand, prep.spawnArgs, {
      cwd: prep.validatedCwd,
      env: prep.sanitizedEnv,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let resolveExit!: () => void;
    const exitPromise = new Promise<void>((res) => {
      resolveExit = res;
    });

    const handle: ActiveTaskHandle = {
      taskId,
      child,
      cleanup: prep.cleanup,
      exitPromise,
    };
    this.activeTasks.set(taskId, handle);

    child.once("close", async () => {
      this.activeTasks.delete(taskId);
      await prep.cleanup();
      resolveExit();
    });

    return {
      child,
      cleanup: async () => {
        await this.terminate(taskId);
        await prep.cleanup();
      },
      sandboxProfile: prep.sandboxProfileName,
    };
  }

  /**
   * Executes a bounded command inside the genuine OS-enforced sandbox.
   */
  public async execute(
    options: SandboxExecutionOptions,
    onChunk?: (stream: "stdout" | "stderr", data: string) => void
  ): Promise<SandboxExecutionResult> {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs || 120_000;
    const maxOutputBytes = options.maxOutputBytes || 1048576; // 1MB output cap
    const maxMemoryBytes = options.maxMemoryBytes;
    const taskId = options.taskId || crypto.randomUUID();

    const prep = await this.prepareSandboxedInvocation({ ...options, taskId });

    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let totalBytes = 0;
      let truncated = false;
      let killedReason: string | undefined;

      const child = spawn(prep.spawnCommand, prep.spawnArgs, {
        cwd: prep.validatedCwd,
        env: prep.sanitizedEnv,
        shell: false, // Never invoke shell interpreter
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32", // Allow killing entire process group
      });

      let resolveExit!: () => void;
      const exitPromise = new Promise<void>((res) => {
        resolveExit = res;
      });

      const handle: ActiveTaskHandle = {
        taskId,
        child,
        cleanup: prep.cleanup,
        exitPromise,
      };
      this.activeTasks.set(taskId, handle);

      // Timeout watchdog
      const timer = setTimeout(() => {
        killedReason = `TIMEOUT_EXCEEDED (${timeoutMs}ms)`;
        handle.killedReason = killedReason;
        this.killProcessTreeSync(child);
      }, timeoutMs);

      // Optional Memory RSS Watchdog (checks every 250ms)
      let memoryInterval: NodeJS.Timeout | null = null;
      if (maxMemoryBytes && child.pid && process.platform !== "win32") {
        memoryInterval = setInterval(() => {
          if (!child.pid) return;
          import("node:child_process").then(({ execFile }) => {
            execFile("ps", ["-o", "rss=", "-p", String(child.pid)], (err, out) => {
              if (err || !out) return;
              const rssKb = parseInt(out.trim(), 10);
              if (!Number.isNaN(rssKb) && rssKb * 1024 > maxMemoryBytes) {
                killedReason = `MEMORY_LIMIT_EXCEEDED (${Math.round(rssKb / 1024)}MB > ${Math.round(
                  maxMemoryBytes / (1024 * 1024)
                )}MB)`;
                handle.killedReason = killedReason;
                this.killProcessTreeSync(child);
              }
            });
          });
        }, 250);
      }

      const handleStreamChunk = (stream: "stdout" | "stderr", chunk: Buffer) => {
        const redactedText = LogRedactor.redact(chunk.toString("utf-8"));
        const byteLen = Buffer.byteLength(redactedText, "utf-8");

        if (totalBytes + byteLen <= maxOutputBytes) {
          if (stream === "stdout") stdout += redactedText;
          else stderr += redactedText;
          totalBytes += byteLen;
          onChunk?.(stream, redactedText);
        } else {
          const allowed = Math.max(0, maxOutputBytes - totalBytes);
          if (allowed > 0) {
            const slice = redactedText.slice(0, allowed);
            if (stream === "stdout") stdout += slice;
            else stderr += slice;
            totalBytes += Buffer.byteLength(slice, "utf-8");
          }
          if (!truncated) {
            truncated = true;
            const warning = "\n[Warning: Process output exceeded maximum byte limit and was truncated.]\n";
            if (stream === "stdout") stdout += warning;
            else stderr += warning;
            onChunk?.(stream, warning);
          }
        }
      };

      child.stdout?.on("data", (chunk: Buffer) => handleStreamChunk("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => handleStreamChunk("stderr", chunk));

      child.on("error", async (err) => {
        clearTimeout(timer);
        if (memoryInterval) clearInterval(memoryInterval);
        this.activeTasks.delete(taskId);
        await prep.cleanup();
        resolveExit();
        reject(err);
      });

      child.on("close", async (code) => {
        clearTimeout(timer);
        if (memoryInterval) clearInterval(memoryInterval);
        this.activeTasks.delete(taskId);
        await prep.cleanup();
        resolveExit();

        const effectiveReason = killedReason || handle.killedReason;
        if (effectiveReason) {
          resolve({
            stdout: LogRedactor.redact(stdout),
            stderr: LogRedactor.redact(stderr + `\n[Execution terminated: ${effectiveReason}]`),
            exitCode: effectiveReason.startsWith("TIMEOUT") ? 124 : 137,
            durationMs: Date.now() - startTime,
            truncated: true,
            sandboxProfile: prep.sandboxProfileName,
            killedReason: effectiveReason,
          });
          return;
        }

        resolve({
          stdout: LogRedactor.redact(stdout),
          stderr: LogRedactor.redact(stderr),
          exitCode: code ?? 0,
          durationMs: Date.now() - startTime,
          truncated,
          sandboxProfile: prep.sandboxProfileName,
        });
      });
    });
  }

  private killProcessTreeSync(child: ChildProcess): void {
    try {
      if (!child.pid) return;
      if (process.platform !== "win32") {
        // Kill entire process group
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        // Kill full process tree on Windows
        spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
          stdio: "ignore",
          shell: false,
        });
      }
    } catch {}
  }

  /**
   * Terminates a specific task's process tree (or PID) and awaits confirmation of exit.
   */
  public async terminate(taskIdOrPid?: string | number): Promise<boolean> {
    const matchingHandles: ActiveTaskHandle[] = [];

    for (const handle of this.activeTasks.values()) {
      if (
        taskIdOrPid === undefined ||
        handle.taskId === taskIdOrPid ||
        handle.child.pid === taskIdOrPid
      ) {
        handle.killedReason = handle.killedReason || "CANCELLED_BY_USER";
        this.killProcessTreeSync(handle.child);
        matchingHandles.push(handle);
      }
    }

    if (matchingHandles.length === 0) {
      return false;
    }

    // Confirm actual OS termination before returning
    await Promise.race([
      Promise.all(matchingHandles.map((h) => h.exitPromise)),
      new Promise<void>((res) => setTimeout(res, 3000)),
    ]);

    return true;
  }

  public async destroy(): Promise<void> {
    await this.terminate();
  }
}
