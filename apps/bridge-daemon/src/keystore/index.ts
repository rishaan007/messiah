import os from "node:os";
import type { IKeyStore } from "./keystoreInterface.js";
import { KeychainStore } from "./keychainStore.js";
import { SecureFileKeystore } from "./secureFileKeystore.js";
import { WindowsCredentialStore } from "./windowsCredentialStore.js";
import { LinuxSecretServiceStore } from "./linuxSecretServiceStore.js";

export * from "./keystoreInterface.js";
export * from "./secureFileKeystore.js";
export * from "./keychainStore.js";
export * from "./windowsCredentialStore.js";
export * from "./linuxSecretServiceStore.js";

/**
 * Returns the best supported keystore for the current OS platform.
 * - macOS: Native Keychain Services (`security` CLI) with encrypted fallback.
 * - Windows: Windows DPAPI & Credential Manager with Windows ACLs.
 * - Linux: Secret Service API (libsecret) when desktop session exists; fails closed or uses passphrase vault.
 * - Custom Dir: Explicit SecureFileKeystore.
 */
export function getPlatformKeystore(customDir?: string): IKeyStore {
  if (customDir) {
    return new SecureFileKeystore(customDir);
  }

  const platform = os.platform();

  if (platform === "darwin") {
    return new KeychainStore();
  }

  if (platform === "win32") {
    return new WindowsCredentialStore();
  }

  if (platform === "linux") {
    return new LinuxSecretServiceStore();
  }

  return new SecureFileKeystore();
}
