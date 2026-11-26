import type { SupportedProviderId } from "@messiah/shared";
import { ProviderError } from "../errors/index.js";
import type { ProviderCredentials, ProviderEmbedResponse } from "../interfaces/index.js";
import { defaultProviderRegistry } from "../registry/index.js";

/**
 * Provider-agnostic vector embedding service with batching and transient backoff.
 */
export class EmbeddingService {
  public static getDefaultModel(provider: SupportedProviderId): string {
    switch (provider) {
      case "openai":
        return "text-embedding-3-small";
      case "gemini":
        return "gemini-embedding-001";
      default:
        throw new ProviderError({
          provider,
          code: "UNSUPPORTED_OPERATION",
          message: `Provider '${provider}' does not provide native text embeddings.`,
          statusCode: 400,
        });
    }
  }

  public static supportsEmbeddings(provider: SupportedProviderId): boolean {
    if (!defaultProviderRegistry.isSupported(provider)) return false;
    const adapter = defaultProviderRegistry.getAdapter(provider);
    const caps =
      typeof adapter.getCapabilities === "function"
        ? adapter.getCapabilities()
        : adapter.metadata?.capabilities;
    return Boolean(caps?.embeddings && typeof adapter.embedTexts === "function");
  }

  public static async embedTexts(params: {
    provider: SupportedProviderId;
    credentials: ProviderCredentials;
    texts: string[];
    model?: string;
    dimensions?: number;
    maxRetries?: number;
    abortSignal?: AbortSignal;
  }): Promise<ProviderEmbedResponse> {
    if (params.texts.length === 0) {
      return {
        provider: params.provider,
        model: params.model || this.getDefaultModel(params.provider),
        dimensions: params.dimensions || 1536,
        embeddings: [],
        totalTokens: 0,
      };
    }

    const adapter = defaultProviderRegistry.getAdapter(params.provider);
    if (!adapter.embedTexts) {
      throw new ProviderError({
        provider: params.provider,
        code: "UNSUPPORTED_OPERATION",
        message: `Provider '${params.provider}' does not implement embedding generation.`,
        statusCode: 400,
      });
    }

    const model = params.model || this.getDefaultModel(params.provider);
    const maxRetries = Math.max(0, Math.min(params.maxRetries ?? 2, 4));

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await adapter.embedTexts(
          {
            model,
            texts: params.texts,
            dimensions: params.dimensions,
            credentials: params.credentials,
          },
          params.abortSignal
        );
      } catch (err) {
        lastError = err;
        const isTransient =
          err instanceof ProviderError &&
          (err.code === "RATE_LIMIT_EXCEEDED" ||
            err.code === "PROVIDER_TIMEOUT" ||
            err.code === "PROVIDER_UNAVAILABLE" ||
            err.code === "PROVIDER_NETWORK_ERROR");
        if (!isTransient || attempt >= maxRetries || params.abortSignal?.aborted) {
          throw err;
        }
        const delayMs = 300 * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Failed to generate embeddings");
  }
}
