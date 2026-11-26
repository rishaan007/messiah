import os from "node:os";
import fs from "node:fs";
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
   * Probes actual OS-enforced sandbox primitives on the current host.
   *
   * FAIL-CLOSED GUARANTEE:
   * Never reports available=true unless the OS kernel isolation primitive is verified functional.
   * - macOS: Proves `/usr/bin/sandbox-exec` (Seatbelt deny-default profile) actually runs.
   * - Linux: Proves `bwrap` (Bubblewrap) can unshare namespaces on this kernel.
   * - Windows: Requires a verified AppContainer helper binary (`MESSIAH_WIN_APPCONTAINER_HELPER`).
   *   Windows Job Objects alone are process lifecycle/resource controls, NOT a security boundary.
   */
  public static async detect(): Promise<DetectedSandboxStatus> {
    const platform = os.platform();

    if (platform === "darwin") {
      const sandboxExecPath = "/usr/bin/sandbox-exec";
      if (!fs.existsSync(sandboxExecPath)) {
        return {
          available: false,
          providerName: "macos-seatbelt",
          platform,
          reason: "/usr/bin/sandbox-exec is missing on this macOS host.",
        };
      }

      try {
        const probeProfile = '(version 1)(deny default)(import "system.sb")(allow process-exec)';
        const { stdout } = await execFileAsync(
          sandboxExecPath,
          ["-p", probeProfile, "/bin/echo", "SEATBELT_PROBE_OK"],
          { timeout: 5000 }
        );
        if (stdout && stdout.includes("SEATBELT_PROBE_OK")) {
          return {
            available: true,
            providerName: "macos-seatbelt",
            platform,
          };
        }
        return {
          available: false,
          providerName: "macos-seatbelt",
          platform,
          reason: "macOS Seatbelt probe returned unexpected output.",
        };
      } catch (err) {
        return {
          available: false,
          providerName: "macos-seatbelt",
          platform,
          reason: `macOS Seatbelt probe failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    if (platform === "linux") {
      try {
        const probeArgs = [
          "--ro-bind",
          "/usr",
          "/usr",
          "--ro-bind",
          "/bin",
          "/bin",
          ...(fs.existsSync("/lib") ? ["--ro-bind", "/lib", "/lib"] : []),
          ...(fs.existsSync("/lib64") ? ["--ro-bind", "/lib64", "/lib64"] : []),
          "--unshare-user",
          "--unshare-pid",
          "--unshare-ipc",
          "--unshare-net",
          "--die-with-parent",
          "--",
          "/bin/true",
        ];
        await execFileAsync("bwrap", probeArgs, { timeout: 5000 });
        return {
          available: true,
          providerName: "linux-bubblewrap",
          platform,
        };
      } catch (err) {
        return {
          available: false,
          providerName: "linux-bubblewrap",
          platform,
          reason: `Bubblewrap (bwrap) namespace isolation unavailable: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    if (platform === "win32") {
      const appContainerHelper = process.env.MESSIAH_WIN_APPCONTAINER_HELPER;
      if (appContainerHelper && fs.existsSync(appContainerHelper)) {
        try {
          await execFileAsync(appContainerHelper, ["--probe"], { timeout: 5000 });
          return {
            available: true,
            providerName: "windows-appcontainer",
            platform,
          };
        } catch (err) {
          return {
            available: false,
            providerName: "windows-appcontainer",
            platform,
            reason: `Windows AppContainer helper probe failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      return {
        available: false,
        providerName: "windows-appcontainer",
        platform,
        reason:
          "Windows AppContainer isolation helper is not configured on this workstation. Failing closed rather than executing unsandboxed user-level processes (Job Objects alone are not a security sandbox).",
      };
    }

    return {
      available: false,
      providerName: "unsupported",
      platform,
      reason: `Operating system '${platform}' does not have an implemented OS-enforced sandbox.`,
    };
  }
}
