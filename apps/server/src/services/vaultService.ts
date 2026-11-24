import crypto from "node:crypto";

export interface EncryptedPayload {
  ciphertext: string;
  initializationVector: string;
  authenticationTag: string;
  keyVersion: string;
}

export interface VaultAadContext {
  workspaceId: string;
  providerConnectionId: string;
  provider: string;
  keyVersion?: string;
}

export function buildVaultAad(context: VaultAadContext, keyVersion: string): Buffer {
  const aadString = `messiah:vault:${keyVersion}:${context.workspaceId}:${context.providerConnectionId}:${context.provider}`;
  return Buffer.from(aadString, "utf8");
}

export interface KeyManagementService {
  getActiveKeyVersion(): string;
  getKey(version?: string): Buffer;
}

export class VaultConfigurationError extends Error {
  constructor(message: string) {
    super(`[VaultConfigurationError] ${message}`);
    this.name = "VaultConfigurationError";
  }
}

export class CredentialDecryptionError extends Error {
  constructor(message = "Failed to authenticate or decrypt stored credential") {
    super(`[CredentialDecryptionError] ${message}`);
    this.name = "CredentialDecryptionError";
  }
}

/**
 * Local KMS Implementation for development and single-host standard deployments.
 * Derives a strict 256-bit (32-byte) key from environment variables.
 *
 * NOTE: This is an internal software key derivation/management service, NOT a
 * hardware-backed managed cloud KMS (e.g. AWS KMS, GCP Cloud KMS, or HashiCorp Vault).
 * In cloud production deployments, this interface should be implemented by an
 * adapter communicating with a cloud KMS using envelope encryption.
 */
export class LocalKmsService implements KeyManagementService {
  private keysByVersion = new Map<string, Buffer>();
  private activeVersion = "v1";

  constructor(envKey?: string) {
    const rawKey = envKey || process.env.VAULT_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY;

    if (!rawKey) {
      throw new VaultConfigurationError(
        "VAULT_ENCRYPTION_KEY environment variable is not configured. Master encryption key is required for credential vault operations."
      );
    }

    let keyBuffer: Buffer;
    if (rawKey.length === 64 && /^[0-9a-fA-F]+$/.test(rawKey)) {
      // 64-char Hex string -> 32 bytes
      keyBuffer = Buffer.from(rawKey, "hex");
    } else if (rawKey.length >= 32) {
      // UTF-8 string hashed to 32 bytes
      keyBuffer = crypto.createHash("sha256").update(rawKey).digest();
    } else {
      throw new VaultConfigurationError(
        "VAULT_ENCRYPTION_KEY must be at least 32 characters or a 64-character hex string."
      );
    }

    this.keysByVersion.set(this.activeVersion, keyBuffer);
    // Support v2 key pointing to active root key
    this.keysByVersion.set("v2", keyBuffer);
  }

  public getActiveKeyVersion(): string {
    return this.activeVersion;
  }

  public getKey(version?: string): Buffer {
    const targetVersion = version || this.activeVersion;
    // Map v2 to active master key if not explicitly set
    const key = this.keysByVersion.get(targetVersion) || this.keysByVersion.get(this.activeVersion);
    if (!key) {
      throw new VaultConfigurationError(
        `Encryption key for version '${targetVersion}' was not found in key management store.`
      );
    }
    return key;
  }

  /**
   * Register a new key version for key rotation scenarios.
   */
  public registerKeyVersion(version: string, key: Buffer, makeActive = false): void {
    if (key.length !== 32) {
      throw new VaultConfigurationError("Key buffer must be exactly 32 bytes for AES-256.");
    }
    this.keysByVersion.set(version, key);
    if (makeActive) {
      this.activeVersion = version;
    }
  }
}

/**
 * AES-256-GCM Authenticated Encryption Vault Service with Additional Authenticated Data (AAD).
 */
export class VaultService {
  private kms: KeyManagementService;

  constructor(kms?: KeyManagementService) {
    if (kms) {
      this.kms = kms;
    } else {
      this.kms = new LocalKmsService();
    }
  }

  /**
   * Encrypts plaintext using AES-256-GCM with a cryptographically secure 12-byte IV.
   * If aadContext is provided, binds the ciphertext to the workspace, connection, provider, and key version.
   */
  public encrypt(plaintext: string, aadContext?: VaultAadContext): EncryptedPayload {
    if (typeof plaintext !== "string" || plaintext.length === 0) {
      throw new Error("Plaintext must be a non-empty string");
    }

    const version = aadContext ? "v2" : this.kms.getActiveKeyVersion();
    const key = this.kms.getKey(version);

    // 96-bit (12-byte) IV is standard and optimal for AES-GCM
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

    if (aadContext) {
      const aad = buildVaultAad(aadContext, version);
      cipher.setAAD(aad);
    }

    let ciphertext = cipher.update(plaintext, "utf8", "hex");
    ciphertext += cipher.final("hex");

    const authTag = cipher.getAuthTag().toString("hex");

    return {
      ciphertext,
      initializationVector: iv.toString("hex"),
      authenticationTag: authTag,
      keyVersion: version,
    };
  }

  /**
   * Decrypts ciphertext using AES-256-GCM and verifies authentication tag integrity.
   * Supports backwards-compatible migration for legacy v1 credentials without AAD.
   */
  public decrypt(encrypted: EncryptedPayload, aadContext?: VaultAadContext): string {
    const { ciphertext, initializationVector, authenticationTag, keyVersion } = encrypted;

    if (!ciphertext || !initializationVector || !authenticationTag) {
      throw new CredentialDecryptionError("Incomplete encrypted credential payload");
    }

    const key = this.kms.getKey(keyVersion);
    const iv = Buffer.from(initializationVector, "hex");
    const authTag = Buffer.from(authenticationTag, "hex");

    // Case 1: v2 credentials requiring AAD binding
    if (keyVersion === "v2") {
      if (!aadContext) {
        throw new CredentialDecryptionError("Missing required AAD context for v2 credential");
      }
      try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(buildVaultAad(aadContext, "v2"));
        decipher.setAuthTag(authTag);

        let plaintext = decipher.update(ciphertext, "hex", "utf8");
        plaintext += decipher.final("utf8");
        return plaintext;
      } catch {
        throw new CredentialDecryptionError(
          "Tampered ciphertext, invalid AAD context, or invalid authentication tag encountered during credential decryption."
        );
      }
    }

    // Case 2: Legacy v1 credentials (or credentials without explicit v2 format)
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(authTag);

      let plaintext = decipher.update(ciphertext, "hex", "utf8");
      plaintext += decipher.final("utf8");
      return plaintext;
    } catch {
      throw new CredentialDecryptionError(
        "Tampered ciphertext or invalid authentication tag encountered during credential decryption."
      );
    }
  }

  /**
   * Re-encrypts an existing encrypted credential under the active key version and AAD context.
   * Used during encryption key rotation procedures and v1 -> v2 migration.
   */
  public reEncrypt(encrypted: EncryptedPayload, aadContext?: VaultAadContext): EncryptedPayload {
    const plaintext = this.decrypt(encrypted, aadContext);
    return this.encrypt(plaintext, aadContext);
  }
}
