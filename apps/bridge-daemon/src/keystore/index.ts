import os from "node:os";
import type { IKeyStore } from "./keystoreInterface.js";
import { KeychainStore } from "./keychainStore.js";
import { SecureFileKeystore } from "./secureFileKeystore.js";

export * from "./keystoreInterface.js";
export * from "./secureFileKeystore.js";
export * from "./keychainStore.js";

/**
 * Returns the best supported keystore for the current OS platform.
 */
export function getPlatformKeystore(customDir?: string): IKeyStore {
  if (customDir) {
    return new SecureFileKeystore(customDir);
  }

  if (os.platform() === "darwin") {
    return new KeychainStore();
  }

  return new SecureFileKeystore();
}
