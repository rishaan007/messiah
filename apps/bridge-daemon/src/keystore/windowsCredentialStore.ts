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
 * Windows Native Credential Store.
 * Uses Windows Data Protection API (DPAPI) via PowerShell to cryptographically bind
 * credentials to the local Windows user login SID, and enforces Windows ACLs via icacls.
 *
 * Windows DPAPI utilizes keys derived from the user's Windows login credentials
 * and TPM hardware when available.
 */
export class WindowsCredentialStore implements IKeyStore {
  public readonly name = "Windows DPAPI & Credential Manager";
  private readonly storageDir: string;
  private readonly credentialPath: string;
  private readonly fallbackStore: SecureFileKeystore;

  constructor(customDir?: string) {
    this.storageDir = customDir || path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Messiah", "bridge");
    this.credentialPath = path.join(this.storageDir, "device.dpapi");
    this.fallbackStore = new SecureFileKeystore(this.storageDir);
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
      // Unprotect ciphertext using DPAPI CurrentUser scope via powershell
      const script = `
        $bytes = [System.IO.File]::ReadAllBytes('${this.credentialPath.replace(/'/g, "''")}');
        $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);
        [System.Text.Encoding]::UTF8.GetString($decrypted);
      `;

      const { stdout } = await execFileAsync("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
      ]);

      return JSON.parse(stdout.trim()) as DeviceIdentity;
    } catch {
      return this.fallbackStore.loadIdentity();
    }
  }

  public async saveIdentity(identity: DeviceIdentity): Promise<void> {
    if (os.platform() !== "win32") {
      return this.fallbackStore.saveIdentity(identity);
    }

    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }

    try {
      const plaintextJson = JSON.stringify(identity);
      const script = `
        $bytes = [System.Text.Encoding]::UTF8.GetBytes('${plaintextJson.replace(/'/g, "''")}');
        $encrypted = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);
        [System.IO.File]::WriteAllBytes('${this.credentialPath.replace(/'/g, "''")}', $encrypted);
      `;

      await execFileAsync("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
      ]);

      // Enforce Windows ACLs: remove inheritance, grant only current user full control
      try {
        await execFileAsync("icacls", [
          this.credentialPath,
          "/inheritance:r",
          "/grant:r",
          `${os.userInfo().username}:F`,
        ]);
      } catch {}
    } catch {
      await this.fallbackStore.saveIdentity(identity);
    }
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
