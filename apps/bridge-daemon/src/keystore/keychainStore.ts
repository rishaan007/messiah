import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import type { IKeyStore } from "./keystoreInterface.js";
import type { DeviceIdentity } from "../identity/deviceIdentity.js";
import { SecureFileKeystore } from "./secureFileKeystore.js";

const execFileAsync = promisify(execFile);

export class KeychainStore implements IKeyStore {
  public readonly name = "macOS Secure Keychain";
  private readonly serviceName = "com.messiah.bridge.device-identity";
  private readonly accountName = "device-primary";
  private readonly fallbackStore: SecureFileKeystore;

  constructor() {
    this.fallbackStore = new SecureFileKeystore();
  }

  public isHardwareBacked(): boolean {
    return os.platform() === "darwin";
  }

  public async loadIdentity(): Promise<DeviceIdentity | null> {
    if (os.platform() !== "darwin") {
      return this.fallbackStore.loadIdentity();
    }

    try {
      // Execute macOS security find-generic-password
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-s",
        this.serviceName,
        "-a",
        this.accountName,
        "-w",
      ]);

      const raw = Buffer.from(stdout.trim(), "base64").toString("utf-8");
      return JSON.parse(raw) as DeviceIdentity;
    } catch {
      // If not in keychain, check encrypted fallback
      return this.fallbackStore.loadIdentity();
    }
  }

  public async saveIdentity(identity: DeviceIdentity): Promise<void> {
    if (os.platform() !== "darwin") {
      return this.fallbackStore.saveIdentity(identity);
    }

    try {
      const payloadBase64 = Buffer.from(JSON.stringify(identity)).toString("base64");

      // Store in macOS Keychain with -U to update if exists
      await execFileAsync("security", [
        "add-generic-password",
        "-s",
        this.serviceName,
        "-a",
        this.accountName,
        "-w",
        payloadBase64,
        "-U",
      ]);
    } catch {
      // If Keychain command is denied (e.g. headless CI without GUI keychain session),
      // store in machine-bound encrypted vault rather than failing
      await this.fallbackStore.saveIdentity(identity);
    }
  }

  public async deleteIdentity(): Promise<void> {
    if (os.platform() === "darwin") {
      try {
        await execFileAsync("security", [
          "delete-generic-password",
          "-s",
          this.serviceName,
          "-a",
          this.accountName,
        ]);
      } catch {}
    }
    await this.fallbackStore.deleteIdentity();
  }
}
