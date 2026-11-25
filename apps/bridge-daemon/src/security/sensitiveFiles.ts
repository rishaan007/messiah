import path from "node:path";
import os from "node:os";

/**
 * Denies access to sensitive system, user, and credential directories/files,
 * even if they reside within an approved project folder (e.g. symlinks, unapproved .env, SSH keys).
 */
export class SensitiveFilesGuard {
  private static readonly SENSITIVE_PATTERNS = [
    // SSH and GPG keys
    /^\.ssh($|[\\/])/i,
    /id_rsa/i,
    /id_ed25519/i,
    /id_ecdsa/i,
    /\.gnupg($|[\\/])/i,

    // Cloud & Infrastructure credentials
    /^\.aws($|[\\/])/i,
    /^\.gcp($|[\\/])/i,
    /^\.azure($|[\\/])/i,
    /^\.kube($|[\\/])/i,
    /gcloud[\\/]credentials\.db/i,

    // Password managers & Keychains
    /\.kdbx$/i,
    /\.keychain/i,
    /\.kwallet/i,

    // Browser profile directories
    /Chrome[\\/]Default[\\/]Login Data/i,
    /Safari[\\/]Keychain/i,

    // Messiah bridge credentials
    /\.messiah($|[\\/])bridge[\\/]device\./i,
    /device\.vault/i,
    /device\.dpapi/i,

    // Environment & Secret files
    /^\.env\.production/i,
    /^\.env\.vault/i,
    /secrets\.json$/i,
    /credentials\.json$/i,
  ];

  /**
   * Checks whether a target file path or filename touches protected sensitive credentials.
   */
  public static isSensitivePath(targetPath: string): { blocked: boolean; reason?: string } {
    const normalized = path.normalize(targetPath);
    const basename = path.basename(normalized);

    // Explicit home directory protection
    const home = os.homedir();
    if (normalized === home) {
      return { blocked: true, reason: "Access to user home directory root is prohibited." };
    }

    for (const pattern of this.SENSITIVE_PATTERNS) {
      if (pattern.test(normalized) || pattern.test(basename)) {
        return {
          blocked: true,
          reason: `Target path matches protected sensitive credential pattern: ${pattern.toString()}`,
        };
      }
    }

    return { blocked: false };
  }
}
