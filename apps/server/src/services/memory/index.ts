import { MemoryService } from "@messiah/memory";
import { VaultService, type EncryptedPayload } from "../vaultService.js";

export { MemoryServiceError } from "@messiah/memory";

let vaultServiceInstance: VaultService | null = null;
function getVaultService(): VaultService {
  if (!vaultServiceInstance) {
    vaultServiceInstance = new VaultService();
  }
  return vaultServiceInstance;
}

export const serverMemoryService = new MemoryService({
  decryptProviderSecret: (input) => {
    const payload: EncryptedPayload = {
      ciphertext: input.ciphertext,
      initializationVector: input.initializationVector,
      authenticationTag: input.authenticationTag,
      keyVersion: input.keyVersion,
    };
    return getVaultService().decrypt(payload, {
      workspaceId: input.workspaceId,
      providerConnectionId: input.providerConnectionId,
      provider: input.provider,
      keyVersion: input.keyVersion,
    });
  },
});
