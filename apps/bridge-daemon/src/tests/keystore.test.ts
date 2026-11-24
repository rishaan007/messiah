import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SecureFileKeystore } from "../keystore/secureFileKeystore.js";
import { KeychainStore } from "../keystore/keychainStore.js";
import { DeviceIdentityManager } from "../identity/deviceIdentity.js";

describe("Device Keystore Implementations", () => {
  const testDir = path.join(os.tmpdir(), `messiah-keystore-test-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("SecureFileKeystore (AES-256-GCM Encrypted Vault)", () => {
    it("never stores private keys in plaintext on disk", async () => {
      const keystore = new SecureFileKeystore(testDir);
      const identity = DeviceIdentityManager.generateIdentity("Vault Test Device");

      await keystore.saveIdentity(identity);

      const vaultPath = path.join(testDir, "device.vault");
      expect(fs.existsSync(vaultPath)).toBe(true);

      const rawContent = fs.readFileSync(vaultPath, "utf-8");
      // MUST NOT contain the plaintext PEM private key
      expect(rawContent).not.toContain("BEGIN PRIVATE KEY");
      expect(rawContent).not.toContain(identity.privateKey);

      // Must be an encrypted envelope
      const envelope = JSON.parse(rawContent);
      expect(envelope.version).toBe(1);
      expect(envelope.salt).toBeDefined();
      expect(envelope.iv).toBeDefined();
      expect(envelope.tag).toBeDefined();
      expect(envelope.ciphertext).toBeDefined();
    });

    it("restores and decrypts identity accurately", async () => {
      const keystore = new SecureFileKeystore(testDir);
      const identity = DeviceIdentityManager.generateIdentity("Vault Test Device");

      await keystore.saveIdentity(identity);
      const loaded = await keystore.loadIdentity();

      expect(loaded).toBeDefined();
      expect(loaded?.deviceId).toBe(identity.deviceId);
      expect(loaded?.displayName).toBe(identity.displayName);
      expect(loaded?.publicKey).toBe(identity.publicKey);
      expect(loaded?.privateKey).toBe(identity.privateKey);
      expect(loaded?.publicKeyFingerprint).toBe(identity.publicKeyFingerprint);
    });

    it("safely handles corrupted or tampered ciphertext without crashing", async () => {
      const keystore = new SecureFileKeystore(testDir);
      const identity = DeviceIdentityManager.generateIdentity("Vault Test Device");

      await keystore.saveIdentity(identity);

      // Tamper with the ciphertext in the file
      const vaultPath = path.join(testDir, "device.vault");
      const envelope = JSON.parse(fs.readFileSync(vaultPath, "utf-8"));
      envelope.ciphertext = "deadbeef" + envelope.ciphertext.slice(8);
      fs.writeFileSync(vaultPath, JSON.stringify(envelope));

      // Loading tampered vault must return null rather than returning unverified plaintext
      const loaded = await keystore.loadIdentity();
      expect(loaded).toBeNull();
    });

    it("deletes the vault file on deleteIdentity", async () => {
      const keystore = new SecureFileKeystore(testDir);
      const identity = DeviceIdentityManager.generateIdentity();

      await keystore.saveIdentity(identity);
      const vaultPath = path.join(testDir, "device.vault");
      expect(fs.existsSync(vaultPath)).toBe(true);

      await keystore.deleteIdentity();
      expect(fs.existsSync(vaultPath)).toBe(false);
    });
  });

  describe("KeychainStore (macOS OS Credential Store)", () => {
    it("reports correct hardware-backed status on current platform", () => {
      const keychain = new KeychainStore();
      if (os.platform() === "darwin") {
        expect(keychain.isHardwareBacked()).toBe(true);
        expect(keychain.name).toBe("macOS Secure Keychain");
      } else {
        expect(keychain.isHardwareBacked()).toBe(false);
      }
    });
  });
});
