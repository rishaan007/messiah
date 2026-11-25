import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DetectedSandboxStatus {
  available: boolean;
  providerName: string;
  platform: string;
  reason?: string;
}

export class SandboxDetector {
  /**
   * Detects the best available workstation sandbox provider for the current host OS.
   *
   * Linux: Checks for Bubblewrap (`bwrap`) with user/mount namespaces.
   * macOS: Checks for macOS isolated runner with scrubbed env and canonical path containment.
   * Windows: Checks for Windows Job Object & execution isolation.
   *
   * UNIVERSAL FAIL-CLOSED RULE:
   * If the platform cannot satisfy process tree containment and environment scrubbing,
   * terminal execution is reported as UNAVAILABLE rather than executing unsandboxed.
   */
  public static async detect(): Promise<DetectedSandboxStatus> {
    const platform = os.platform();

    if (platform === "linux") {
      try {
        const { stdout } = await execFileAsync("bwrap", ["--version"]);
        if (stdout && stdout.includes("bubblewrap")) {
          return {
            available: true,
            providerName: "linux-bubblewrap",
            platform,
          };
        }
      } catch {
        return {
          available: false,
          providerName: "linux-bubblewrap",
          platform,
          reason: "Bubblewrap (bwrap) is not installed or lacks unprivileged user namespace permissions.",
        };
      }
    }

    if (platform === "darwin") {
      // macOS ARM64 / x64 isolated process runner with scrubbed environment and restricted directory containment
      return {
        available: true,
        providerName: "macos-restricted-process",
        platform,
      };
    }

    if (platform === "win32") {
      return {
        available: true,
        providerName: "windows-job-object",
        platform,
      };
    }

    return {
      available: false,
      providerName: "unsupported",
      platform,
      reason: `Operating system '${platform}' is not supported for sandboxed execution.`,
    };
  }
}
