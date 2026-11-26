import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { IKeyStore } from "./keystoreInterface.js";
import type { DeviceIdentity } from "../identity/deviceIdentity.js";

export interface SecureFileKeystoreOptions {
  requirePassphrase?: boolean;
}

export class SecureFileKeystore implements IKeyStore {
  public readonly name = "Encrypted Local Keystore (AES-256-GCM)";
  private readonly storageDir: string;
  private readonly vaultPath: string;
  private readonly requirePassphrase: boolean;

  constructor(customDir?: string, options?: SecureFileKeystoreOptions) {
    this.storageDir = customDir || path.join(os.homedir(), ".messiah", "bridge");
    this.vaultPath = path.join(this.storageDir, "device.vault");
    this.requirePassphrase = Boolean(options?.requirePassphrase);
  }

  public hasVaultFile(): boolean {
    return fs.existsSync(this.vaultPath);
  }

  public getVaultPath(): string {
    return this.vaultPath;
  }

  private assertPassphraseIfRequired(): void {
    if (this.requirePassphrase && !process.env.MESSIAH_VAULT_PASSPHRASE) {
      throw new Error(
        "PASSPHRASE_REQUIRED: Headless keystore requires MESSIAH_VAULT_PASSPHRASE environment variable; refusing to encrypt with empty passphrase."
      );
    }
  }

  private deriveKey(salt: Buffer, iterations = 600_000, digest = "sha512"): Buffer {
    const userPassphrase = process.env.MESSIAH_VAULT_PASSPHRASE || "";
    const machineEntropy = [
      userPassphrase,
      os.userInfo().username,
      os.hostname(),
      os.homedir(),
      os.platform(),
      os.arch(),
      os.cpus()[0]?.model || "cpu-generic",
    ].join(":");

    return crypto.pbkdf2Sync(machineEntropy, salt, iterations, 32, digest);
  }

  public async loadIdentity(): Promise<DeviceIdentity | null> {
    if (!fs.existsSync(this.vaultPath)) {
      return null;
    }

    this.assertPassphraseIfRequired();

    try {
      const raw = fs.readFileSync(this.vaultPath, "utf-8");
      const envelope = JSON.parse(raw);

      if (!envelope.salt || !envelope.iv || !envelope.tag || !envelope.ciphertext) {
        throw new Error("Corrupted keystore envelope format.");
      }

      const salt = Buffer.from(envelope.salt, "hex");
      const iv = Buffer.from(envelope.iv, "hex");
      const tag = Buffer.from(envelope.tag, "hex");
      const version = envelope.version || 1;

      const iterations = envelope.iterations || (version === 1 ? 100_000 : 600_000);
      const digest = envelope.digest || (version === 1 ? "sha256" : "sha512");
      const aad = version === 1 ? "MESSIAH_DEVICE_KEYSTORE_V1" : "MESSIAH_DEVICE_KEYSTORE_V2";

      let key: Buffer;
      if (version === 1 && !envelope.iterations) {
        const legacyMachineEntropy = [
          os.hostname(),
          os.homedir(),
          os.platform(),
          os.arch(),
          os.cpus()[0]?.model || "cpu-generic",
        ].join(":");
        key = crypto.pbkdf2Sync(legacyMachineEntropy, salt, 100_000, 32, "sha256");
      } else {
        key = this.deriveKey(salt, iterations, digest);
      }

      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      decipher.setAAD(Buffer.from(aad, "utf-8"));

      let decrypted = decipher.update(envelope.ciphertext, "hex", "utf-8");
      decrypted += decipher.final("utf-8");

      return JSON.parse(decrypted) as DeviceIdentity;
    } catch (err) {
      console.error("[SecureFileKeystore] Failed to decrypt device identity from local keystore:", err);
      return null;
    }
  }

  public async saveIdentity(identity: DeviceIdentity): Promise<void> {
    this.assertPassphraseIfRequired();

    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true, mode: 0o700 });
    }

    const salt = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const iterations = 600_000;
    const digest = "sha512";
    const key = this.deriveKey(salt, iterations, digest);

    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from("MESSIAH_DEVICE_KEYSTORE_V2", "utf-8"));

    const plaintext = JSON.stringify(identity);
    let ciphertext = cipher.update(plaintext, "utf-8", "hex");
    ciphertext += cipher.final("hex");
    const tag = cipher.getAuthTag();

    const envelope = {
      version: 2,
      kdf: "PBKDF2-HMAC-SHA512",
      iterations,
      digest,
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
