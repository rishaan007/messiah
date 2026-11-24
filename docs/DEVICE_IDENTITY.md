# Messiah Device Identity & Cryptographic Keystore Architecture

**Status**: Phase 4A Implemented & Verified  
**Package**: `apps/bridge-daemon` (`@messiah/bridge-daemon`)  
**Standard**: RFC 8032 (Ed25519) / RFC 5280 (SPKI)

---

## 1. Identity Principles

Messiah binds every Local Agent Bridge instance to a unique physical or virtual workstation through cryptographic device identity:

1. **Hardware / OS Bound**: Keys are generated locally on the workstation and never leave the device.
2. **Asymmetric Security**: The device retains the private key exclusively. The Messiah Cloud only stores the public key and its cryptographic fingerprint.
3. **Zero Plaintext Storage**: Private keys are strictly forbidden from being stored in plaintext on disk, in environment variables, or in unencrypted configuration files.
4. **Permanent Auditability**: Every connection session, challenge, and signature is cryptographically bound to the device's public key fingerprint.

---

## 2. Cryptographic Specifications

### Algorithm: Ed25519 (Edwards-curve Digital Signature Algorithm)
- **Key Pair Type**: Ed25519 (`NODE_ED25519`)
- **Public Key Format**: SubjectPublicKeyInfo (SPKI) in PEM format (`-----BEGIN PUBLIC KEY-----`)
- **Private Key Format**: PKCS#8 in PEM format (`-----BEGIN PRIVATE KEY-----`)
- **Signature Encoding**: Base64 encoded raw signature (64 bytes)
- **Deterministic & High Speed**: Sub-millisecond signing without relying on non-deterministic random nonce generation during signing (preventing nonce-leak attacks).

### Public Key Fingerprinting
To present devices cleanly in the UI and allow human-verifiable key authentication without transmitting full PEM strings, Messiah computes an immutable SHA-256 fingerprint from the binary SPKI DER bytes:

$$\text{Fingerprint} = \text{"SHA256:"} \mathbin{\Vert} \text{Hex}(\text{SHA-256}(\text{SPKI\_DER\_Bytes}))$$

Example:
```
SHA256:7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069
```

When claiming a device pairing or authenticating a WebSocket connection, Messiah Cloud independently re-derives this fingerprint from the provided PEM public key. If the fingerprint does not match the DER hash with byte-for-byte fidelity, the request is immediately rejected.

---

## 3. Local Keystore Implementations

The Bridge implements a unified `IKeyStore` interface (`apps/bridge-daemon/src/keystore/keystoreInterface.ts`) with platform-specific backends:

```typescript
export interface IKeyStore {
  saveIdentity(identity: DeviceIdentity): Promise<void>;
  loadIdentity(): Promise<DeviceIdentity | null>;
  deleteIdentity(): Promise<void>;
  hasIdentity(): Promise<boolean>;
}
```

### Backend A: Native macOS Keychain (`KeychainStore`)
- On macOS systems, the daemon delegates private key storage to the native macOS Keychain subsystem via the `security` CLI tool.
- Service Name: `com.messiah.bridge`
- Account Name: `device-identity`
- Secret: JSON-serialized payload containing the Ed25519 public and private PEM strings, device ID, and fingerprint.
- If macOS Keychain access is denied, restricted, or unavailable (e.g. running in headless CI or headless daemon mode), the store automatically falls back gracefully to Backend B with a warning log.

### Backend B: Secure Encrypted File Vault (`SecureFileKeystore`)
- Cross-platform secure store used on Linux, Windows, and fallback macOS environments.
- File Path: `~/.messiah/bridge/device.vault`
- Encryption: **AES-256-GCM** with authenticated data integrity.
- Key Derivation: **PBKDF2** with 100,000 iterations using HMAC-SHA512.
- Salt: Machine-derived hardware/user salt combined with a host-specific identifier.
- File Permissions: Strictly enforces POSIX `0600` (read/write only by the current OS user). If file creation detects permissive modes, it automatically applies `chmod 0600`.
- Tamper Resistance: Any bit-flip or corrupted authentication tag during decryption throws an immediate error and securely refuses to load corrupted data.

---

## 4. Key Generation & Canonical Authentication Proof

### Identity Generation Workflow
1. When `messiah-bridge pair` is invoked without existing credentials, `DeviceIdentityManager.generate()` invokes Node's `crypto.generateKeyPairSync("ed25519")`.
2. A random UUIDv4 `deviceId` is minted.
3. The SPKI DER representation of the public key is extracted and hashed via SHA-256 to compute the public key fingerprint.
4. The identity object is stored atomically into the platform keystore.

### Canonical Auth Payload Structure
To prevent signature manipulation, replay, and cross-protocol downgrade attacks, every authentication signature signs a strictly formatted canonical ASCII string:

```
MESSIAH_DEVICE_AUTH:<deviceId>:<challengeId>:<nonce>:<serverAudience>:<protocolVersion>:<expiresAt>
```

Field semantics:
- `MESSIAH_DEVICE_AUTH`: Protocol domain separator.
- `deviceId`: Registered UUIDv4 device identifier.
- `challengeId`: Ephemeral challenge UUID issued by the server.
- `nonce`: Cryptographically secure 256-bit hex random string generated by the server.
- `serverAudience`: Target audience string (e.g. `messiah:cloud:device-gateway`).
- `protocolVersion`: Protocol date code (e.g. `2026-08-01`).
- `expiresAt`: Epoch millisecond timestamp after which the challenge is strictly expired (30 seconds TTL).

The Bridge signs this string using `crypto.sign(null, Buffer.from(payload, "utf-8"), privateKey)` and sends the Base64 signature back to the server in a `device.auth.proof` frame.
