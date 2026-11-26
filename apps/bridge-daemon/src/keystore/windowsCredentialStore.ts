import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { IKeyStore } from "./keystoreInterface.js";
import type { DeviceIdentity } from "../identity/deviceIdentity.js";
import { SecureFileKeystore } from "./secureFileKeystore.js";

const execFileAsync = promisify(execFile);

/**
 * Windows Custom DPAPI-Protected File Store.
 *
 * NOTE: Stores the encrypted device identity inside `%APPDATA%\Messiah\bridge\device.dpapi`
 * using Windows Data Protection API (`System.Security.Cryptography.ProtectedData` with
 * `DataProtectionScope.CurrentUser`) and user-only NTFS ACLs (`icacls /inheritance:r`).
 * This does NOT use the Windows Credential Manager (`CredWriteW`) generic vault.
 *
 * Payloads and file paths are passed strictly via process environment variables to PowerShell,
 * eliminating string-interpolation command injection.
 */
export class WindowsCredentialStore implements IKeyStore {
  public readonly name = "Windows Custom DPAPI File Store (CurrentUser + NTFS ACL)";
  private readonly storageDir: string;
  private readonly credentialPath: string;
  private readonly fallbackStore: SecureFileKeystore;

  constructor(customDir?: string) {
    this.storageDir =
      customDir || path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Messiah", "bridge");
    this.credentialPath = path.join(this.storageDir, "device.dpapi");
    this.fallbackStore = new SecureFileKeystore(this.storageDir, { requirePassphrase: true });
  }

  public isHardwareBacked(): boolean {
    return os.platform() === "win32";
  }

  public async loadIdentity(): Promise<DeviceIdentity | null> {
    if (os.platform() !== "win32") {
      return this.fallbackStore.loadIdentity();
    }

    if (!fs.existsSync(this.credentialPath)) {
      return this.fallbackStore.loadIdentity();
    }

    try {
      const script = [
        "Add-Type -AssemblyName System.Security;",
        "$bytes = [System.IO.File]::ReadAllBytes($env:MESSIAH_DPAPI_PATH);",
        "$decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);",
        "[System.Text.Encoding]::UTF8.GetString($decrypted);",
      ].join(" ");

      const { stdout } = await execFileAsync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          env: {
            ...process.env,
            MESSIAH_DPAPI_PATH: this.credentialPath,
          },
        }
      );

      return JSON.parse(stdout.trim()) as DeviceIdentity;
    } catch (err) {
      throw new Error(
        `Failed to unprotect Windows DPAPI credential file at '${this.credentialPath}': ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  public async saveIdentity(identity: DeviceIdentity): Promise<void> {
    if (os.platform() !== "win32") {
      return this.fallbackStore.saveIdentity(identity);
    }

    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }

    const payloadBase64 = Buffer.from(JSON.stringify(identity), "utf-8").toString("base64");
    const script = [
      "Add-Type -AssemblyName System.Security;",
      "$bytes = [System.Convert]::FromBase64String($env:MESSIAH_DPAPI_PAYLOAD_B64);",
      "$encrypted = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);",
      "[System.IO.File]::WriteAllBytes($env:MESSIAH_DPAPI_PATH, $encrypted);",
    ].join(" ");

    await execFileAsync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        env: {
          ...process.env,
          MESSIAH_DPAPI_PATH: this.credentialPath,
          MESSIAH_DPAPI_PAYLOAD_B64: payloadBase64,
        },
      }
    );

    // Enforce restrictive NTFS ACLs: disable inheritance, grant only current user Full Control
    await execFileAsync("icacls", [
      this.credentialPath,
      "/inheritance:r",
      "/grant:r",
      `${os.userInfo().username}:F`,
    ]);
  }

  public async deleteIdentity(): Promise<void> {
    if (fs.existsSync(this.credentialPath)) {
      try {
        fs.unlinkSync(this.credentialPath);
      } catch {}
    }
    await this.fallbackStore.deleteIdentity();
  }
}
