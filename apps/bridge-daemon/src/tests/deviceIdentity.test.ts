import { describe, it, expect } from "vitest";
import { DeviceIdentityManager } from "../identity/deviceIdentity.js";

describe("DeviceIdentityManager (Ed25519 Cryptographic Identity)", () => {
  it("generates a valid Ed25519 keypair and assigns a stable UUID identifier", () => {
    const identity = DeviceIdentityManager.generateIdentity("Test MacBook Pro");

    expect(identity.deviceId).toBeDefined();
    expect(identity.deviceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(identity.displayName).toBe("Test MacBook Pro");
    expect(identity.publicKey).toContain("-----BEGIN PUBLIC KEY-----");
    expect(identity.privateKey).toContain("-----BEGIN PRIVATE KEY-----");
    expect(identity.publicKeyFingerprint).toMatch(/^SHA256:[0-9a-f]{64}$/i);
    expect(identity.bridgeVersion).toBe(DeviceIdentityManager.VERSION);
    expect(identity.platform).toBeDefined();
    expect(identity.architecture).toBeDefined();
  });

  it("calculates deterministic SHA-256 fingerprint for a public key", () => {
    const identity = DeviceIdentityManager.generateIdentity();
    const fp1 = DeviceIdentityManager.calculateFingerprint(identity.publicKey);
    const fp2 = DeviceIdentityManager.calculateFingerprint(identity.publicKey);

    expect(fp1).toBe(identity.publicKeyFingerprint);
    expect(fp1).toBe(fp2);
  });

  it("produces valid Ed25519 signatures that verify against the public key", () => {
    const identity = DeviceIdentityManager.generateIdentity();
    const payload = DeviceIdentityManager.formatAuthPayload(
      identity.deviceId,
      "chal-12345",
      "nonce-67890",
      "messiah-cloud",
      "2026-08-01",
      Date.now() + 30000
    );

    const signature = DeviceIdentityManager.signPayload(payload, identity.privateKey);
    expect(signature).toBeDefined();
    expect(typeof signature).toBe("string");

    // Verification against true public key must succeed
    const isValid = DeviceIdentityManager.verifySignature(payload, signature, identity.publicKey);
    expect(isValid).toBe(true);

    // Verification against different payload must fail
    const isTamperedValid = DeviceIdentityManager.verifySignature(
      payload + "-tampered",
      signature,
      identity.publicKey
    );
    expect(isTamperedValid).toBe(false);

    // Verification against different keypair must fail
    const anotherIdentity = DeviceIdentityManager.generateIdentity();
    const isOtherKeyValid = DeviceIdentityManager.verifySignature(
      payload,
      signature,
      anotherIdentity.publicKey
    );
    expect(isOtherKeyValid).toBe(false);
  });
});
