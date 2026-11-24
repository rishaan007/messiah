import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { IKeyStore } from "./keystoreInterface.js";
import type { DeviceIdentity } from "../identity/deviceIdentity.js";

export class SecureFileKeystore implements IKeyStore {
  public readonly name = "Encrypted Local Keystore (AES-256-GCM)";
  private readonly storageDir: string;
  private readonly vaultPath: string;

  constructor(customDir?: string) {
    this.storageDir = customDir || path.join(os.homedir(), ".messiah", "bridge");
    this.vaultPath = path.join(this.storageDir, "device.vault");
  }

  /**
   * Derives a machine-unique 256-bit encryption key using PBKDF2.
   * This ties the encrypted vault to the current host machine and user account.
   */
  private deriveKey(salt: Buffer): Buffer {
    const machineEntropy = [
      os.hostname(),
      os.homedir(),
      os.platform(),
      os.arch(),
      os.cpus()[0]?.model || "cpu-generic",
    ].join(":");

    return crypto.pbkdf2Sync(
      machineEntropy,
      salt,
      100_000,
      32,
      "sha256"
    );
  }

  public async loadIdentity(): Promise<DeviceIdentity | null> {
    if (!fs.existsSync(this.vaultPath)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(this.vaultPath, "utf-8");
      const envelope = JSON.parse(raw);

      if (!envelope.salt || !envelope.iv || !envelope.tag || !envelope.ciphertext) {
        throw new Error("Corrupted keystore envelope format.");
      }

      const salt = Buffer.from(envelope.salt, "hex");
      const iv = Buffer.from(envelope.iv, "hex");
      const tag = Buffer.from(envelope.tag, "hex");
      const key = this.deriveKey(salt);

      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      decipher.setAAD(Buffer.from("MESSIAH_DEVICE_KEYSTORE_V1", "utf-8"));

      let decrypted = decipher.update(envelope.ciphertext, "hex", "utf-8");
      decrypted += decipher.final("utf-8");

      return JSON.parse(decrypted) as DeviceIdentity;
    } catch (err) {
      console.error("[SecureFileKeystore] Failed to decrypt device identity from local keystore:", err);
      return null;
    }
  }

  public async saveIdentity(identity: DeviceIdentity): Promise<void> {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true, mode: 0o700 });
    }

    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = this.deriveKey(salt);

    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from("MESSIAH_DEVICE_KEYSTORE_V1", "utf-8"));

    const plaintext = JSON.stringify(identity);
    let ciphertext = cipher.update(plaintext, "utf-8", "hex");
    ciphertext += cipher.final("hex");
    const tag = cipher.getAuthTag();

    const envelope = {
      version: 1,
      salt: salt.toString("hex"),
      iv: iv.toString("hex"),
      tag: tag.toString("hex"),
      ciphertext,
      createdAt: new Date().toISOString(),
    };

    fs.writeFileSync(this.vaultPath, JSON.stringify(envelope, null, 2), {
      mode: 0o600,
    });
  }

  public async deleteIdentity(): Promise<void> {
    if (fs.existsSync(this.vaultPath)) {
      fs.unlinkSync(this.vaultPath);
    }
  }

  public isHardwareBacked(): boolean {
    return false;
  }
}
