import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import type { IKeyStore } from "./keystoreInterface.js";
import type { DeviceIdentity } from "../identity/deviceIdentity.js";
import { SecureFileKeystore } from "./secureFileKeystore.js";

const execFileAsync = promisify(execFile);

/**
 * Linux Secret Service Keystore.
 * Integrates with freedesktop.org Secret Service API via `secret-tool` (libsecret).
 *
 * FAIL-CLOSED ON HEADLESS LINUX:
 * When no D-Bus session / Secret Service daemon is available, delegates strictly to
 * SecureFileKeystore configured with `requirePassphrase: true`, which throws
 * PASSPHRASE_REQUIRED unless MESSIAH_VAULT_PASSPHRASE is explicitly provided.
 */
export class LinuxSecretServiceStore implements IKeyStore {
  public readonly name = "Linux Secret Service (libsecret)";
  private readonly serviceName = "com.messiah.bridge";
  private readonly accountName = "device-primary";
  private readonly fallbackStore: SecureFileKeystore;

  constructor(customDir?: string) {
    this.fallbackStore = new SecureFileKeystore(customDir, {
      requirePassphrase: os.platform() === "linux",
    });
  }

  private hasDesktopSession(): boolean {
    return Boolean(process.env.DBUS_SESSION_BUS_ADDRESS || process.env.XDG_CURRENT_DESKTOP);
  }

  public async loadIdentity(): Promise<DeviceIdentity | null> {
    if (os.platform() !== "linux") {
      return this.fallbackStore.loadIdentity();
    }

    if (this.hasDesktopSession()) {
      try {
        const { stdout } = await execFileAsync("secret-tool", [
          "lookup",
          "service",
          this.serviceName,
          "account",
          this.accountName,
        ]);

        if (stdout && stdout.trim()) {
          const raw = Buffer.from(stdout.trim(), "base64").toString("utf-8");
          return JSON.parse(raw) as DeviceIdentity;
        }
      } catch {
        // Fall through to fail-closed passphrase vault if secret-tool has no entry or fails
      }
    }

    return this.fallbackStore.loadIdentity();
  }

  public async saveIdentity(identity: DeviceIdentity): Promise<void> {
    if (os.platform() !== "linux") {
      return this.fallbackStore.saveIdentity(identity);
    }

    if (this.hasDesktopSession()) {
      try {
        const payloadBase64 = Buffer.from(JSON.stringify(identity)).toString("base64");
        const child = execFile("secret-tool", [
          "store",
          "--label=Messiah Device Identity",
          "service",
          this.serviceName,
          "account",
          this.accountName,
        ]);

        if (child.stdin) {
          child.stdin.write(payloadBase64);
          child.stdin.end();
        }

        await new Promise<void>((resolve, reject) => {
          child.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`secret-tool exited with code ${code}`));
          });
          child.on("error", reject);
        });

        return;
      } catch {
        // Fall through to fail-closed passphrase vault
      }
    }

    await this.fallbackStore.saveIdentity(identity);
  }

  public async deleteIdentity(): Promise<void> {
    if (os.platform() === "linux" && this.hasDesktopSession()) {
      try {
        await execFileAsync("secret-tool", [
          "clear",
          "service",
          this.serviceName,
          "account",
          this.accountName,
        ]);
      } catch {}
    }
    await this.fallbackStore.deleteIdentity();
  }
}
