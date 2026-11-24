import crypto from "node:crypto";

export class VaultService {
  private static getKey(): Buffer {
    const rawKey = process.env.VAULT_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY || "development_vault_encryption_key_32_bytes_long!!";
    if (rawKey.length === 64 && /^[0-9a-fA-F]+$/.test(rawKey)) {
      return Buffer.from(rawKey, "hex");
    }
    return crypto.createHash("sha256").update(rawKey).digest();
  }

  public static decrypt(
    ciphertext: string,
    initializationVector: string,
    authenticationTag: string,
    providerConnectionId: string,
    workspaceId: string,
    keyVersion = "v2"
  ): string {
    const key = this.getKey();
    const iv = Buffer.from(initializationVector, "hex");
    const authTag = Buffer.from(authenticationTag, "hex");

    if (keyVersion === "v2") {
      try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
        const aadString = `messiah:vault:v2:${workspaceId}:${providerConnectionId}`;
        decipher.setAAD(Buffer.from(aadString, "utf8"));
        decipher.setAuthTag(authTag);
        let plaintext = decipher.update(ciphertext, "hex", "utf8");
        plaintext += decipher.final("utf8");
        return plaintext;
      } catch {
        // Fallback to legacy decryption without AAD
      }
    }

    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    let plaintext = decipher.update(ciphertext, "hex", "utf8");
    plaintext += decipher.final("utf8");
    return plaintext;
  }
}
