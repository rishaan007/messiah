import type { SupportedProviderId, ProviderMetadataInfo } from "@messiah/shared";
import type { IProviderAdapter } from "../interfaces/index.js";
import { OpenAIAdapter } from "../adapters/openai.js";
import { AnthropicAdapter } from "../adapters/anthropic.js";
import { GeminiAdapter } from "../adapters/gemini.js";
import { ProviderError } from "../errors/index.js";

export class ProviderRegistry {
  private adapters = new Map<SupportedProviderId, IProviderAdapter>();

  constructor() {
    this.registerDefaultAdapters();
  }

  private registerDefaultAdapters(): void {
    this.registerAdapter(new OpenAIAdapter());
    this.registerAdapter(new AnthropicAdapter());
    this.registerAdapter(new GeminiAdapter());
  }

  public registerAdapter(adapter: IProviderAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  public getAdapter(providerId: SupportedProviderId): IProviderAdapter {
    const adapter = this.adapters.get(providerId);
    if (!adapter) {
      throw new ProviderError({
        provider: providerId,
        code: "UNSUPPORTED_OPERATION",
        message: `Provider '${providerId}' is not registered or supported by this Messiah runtime.`,
        statusCode: 400,
      });
    }
    return adapter;
  }

  public listSupportedProviders(): ProviderMetadataInfo[] {
    return Array.from(this.adapters.values()).map((a) => a.getProviderMetadata());
  }

  public isSupported(providerId: string): providerId is SupportedProviderId {
    return this.adapters.has(providerId as SupportedProviderId);
  }
}

// Global singleton instance
export const defaultProviderRegistry = new ProviderRegistry();
