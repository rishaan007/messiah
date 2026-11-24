import { DeviceIdentityManager, type DeviceIdentity } from "../identity/deviceIdentity.js";
import { getPlatformKeystore, type IKeyStore } from "../keystore/index.js";
import { DEVICE_API_ROUTES, type ClaimPairingChallengeInput, type ClaimPairingChallengeResponse } from "@messiah/shared";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface PairingConfig {
  serverUrl: string;
  deviceId: string;
  displayName: string;
  publicKeyFingerprint: string;
  pairedAt: string;
}

export class PairingClient {
  private readonly keystore: IKeyStore;
  private readonly configPath: string;

  constructor(keystore?: IKeyStore, customConfigDir?: string) {
    this.keystore = keystore || getPlatformKeystore();
    const configDir = customConfigDir || path.join(os.homedir(), ".messiah", "bridge");
    this.configPath = path.join(configDir, "config.json");
  }

  public getSavedConfig(): PairingConfig | null {
    if (!fs.existsSync(this.configPath)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(this.configPath, "utf-8");
      return JSON.parse(raw) as PairingConfig;
    } catch {
      return null;
    }
  }

  public saveConfig(config: PairingConfig): void {
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), {
      mode: 0o600,
    });
  }

  public deleteConfig(): void {
    if (fs.existsSync(this.configPath)) {
      fs.unlinkSync(this.configPath);
    }
  }

  /**
   * Executes the pairing claim process against the server.
   */
  public async pair(
    serverUrl: string,
    pairingCode: string,
    displayName?: string
  ): Promise<{ identity: DeviceIdentity; config: PairingConfig; response: ClaimPairingChallengeResponse }> {
    const normalizedServerUrl = serverUrl.replace(/\/+$/, "");

    // 1. Load or generate device identity
    let identity = await this.keystore.loadIdentity();
    if (!identity) {
      identity = DeviceIdentityManager.generateIdentity(displayName);
      await this.keystore.saveIdentity(identity);
    }

    // 2. Prepare claim payload
    const claimPayload: ClaimPairingChallengeInput = {
      pairingCode: pairingCode.trim().toUpperCase(),
      displayName: identity.displayName,
      platform: identity.platform,
      architecture: identity.architecture,
      bridgeVersion: identity.bridgeVersion,
      publicKey: identity.publicKey,
      publicKeyFingerprint: identity.publicKeyFingerprint,
    };

    // 3. Submit claim to Messiah server
    const endpoint = `${normalizedServerUrl}${DEVICE_API_ROUTES.claimPairingChallenge}`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `messiah-bridge/${identity.bridgeVersion} (${identity.platform}; ${identity.architecture})`,
      },
      body: JSON.stringify(claimPayload),
    });

    const responseBody = (await res.json()) as {
      success: boolean;
      data?: ClaimPairingChallengeResponse;
      error?: { code: string; message: string };
    };

    if (!res.ok || !responseBody.success || !responseBody.data) {
      const errMsg = responseBody.error?.message || `Server returned HTTP ${res.status}`;
      throw new Error(`Pairing failed: ${errMsg}`);
    }

    // Update identity with returned deviceId from server if needed
    if (responseBody.data.deviceId && responseBody.data.deviceId !== identity.deviceId) {
      identity.deviceId = responseBody.data.deviceId;
      await this.keystore.saveIdentity(identity);
    }

    // 4. Save local configuration
    const config: PairingConfig = {
      serverUrl: normalizedServerUrl,
      deviceId: identity.deviceId,
      displayName: identity.displayName,
      publicKeyFingerprint: identity.publicKeyFingerprint,
      pairedAt: new Date().toISOString(),
    };
    this.saveConfig(config);

    return {
      identity,
      config,
      response: responseBody.data,
    };
  }

  public async unpair(): Promise<void> {
    await this.keystore.deleteIdentity();
    this.deleteConfig();
  }
}
