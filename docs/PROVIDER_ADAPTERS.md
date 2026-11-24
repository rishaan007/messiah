# MESSIAH — Provider Adapters Architecture & Specification

## 1. Overview & Architectural Principles

MESSIAH provides a unified intelligence layer across diverse AI foundation model providers. Rather than coupling business logic or workspace orchestration directly to vendor SDKs, all provider interactions flow through an extensible adapter pattern implemented in `@messiah/providers`.

### Key Tenets
1. **Official SDKs**: Direct integration with official vendor libraries (`openai`, `@anthropic-ai/sdk`, `@google/genai`). No intermediate third-party gateway dependencies.
2. **Standardized Contract**: All provider implementations conform to `IProviderAdapter`.
3. **Zero-Token Credential Verification**: Live validation tests API keys via lightweight, non-billable metadata endpoints (`models.list` / model catalog) rather than consuming generation tokens.
4. **Normalized Capabilities & Metadata**: Features like `streaming`, `toolCalling`, `vision`, `audio`, and `reasoning` are explicitly typed and mapped to uniform schemas.
5. **Standardized Error Hierarchy**: Vendor-specific HTTP codes and exceptions are caught and normalized into standard typed errors (`InvalidCredentialsError`, `RateLimitError`, `ProviderTimeoutError`, etc.).

---

## 2. Core Adapter Interface (`IProviderAdapter`)

Defined in `@messiah/providers`:

```typescript
export interface IProviderAdapter {
  readonly id: SupportedProviderId; // "openai" | "anthropic" | "gemini"
  readonly name: string;
  readonly description: string;

  getMetadata(): ProviderMetadata;
  getCapabilities(): ProviderCapabilities;
  validateCredentials(credentials: ProviderCredentials): Promise<ConnectionValidationResult>;
  listModels(credentials: ProviderCredentials): Promise<ModelInfo[]>;
}
```

### Credentials Schema
```typescript
export interface ProviderCredentials {
  apiKey: string;
  baseUrl?: string;
  organizationId?: string;
  apiVersion?: string;
}
```

### Validation Result Contract
```typescript
export interface ConnectionValidationResult {
  valid: boolean;
  message?: string;
  testedAt: string;
  modelsFound?: number;
}
```

---

## 3. Implemented Provider Adapters

### 3.1 OpenAI Adapter (`OpenAIAdapter`)
- **SDK**: `openai` (v4.86+ / current release line)
- **Validation Strategy**: Calls `client.models.list()`. Validates HTTP 200 response without triggering chat completion tokens.
- **Error Mapping**:
  - `OpenAI.AuthenticationError` (401) $\rightarrow$ `InvalidCredentialsError`
  - `OpenAI.RateLimitError` (429) $\rightarrow$ `RateLimitError`
  - `OpenAI.APIConnectionTimeoutError` $\rightarrow$ `ProviderTimeoutError`
  - `OpenAI.APIConnectionError` $\rightarrow$ `ProviderNetworkError`
- **Capabilities Matrix**:
  - `streaming`: `true`
  - `toolCalling`: `true` (Function Calling & Structured Outputs)
  - `vision`: `true`
  - `audio`: `true`
  - `reasoning`: `true` (o1, o3-mini)
  - `jsonMode`: `true`

### 3.2 Anthropic Adapter (`AnthropicAdapter`)
- **SDK**: `@anthropic-ai/sdk`
- **Validation Strategy**: Calls `client.models.list()`. Anthropic exposes a first-class models API, enabling verification without sample message generation.
- **Error Mapping**:
  - `Anthropic.AuthenticationError` (401) $\rightarrow$ `InvalidCredentialsError`
  - `Anthropic.RateLimitError` (429) $\rightarrow$ `RateLimitError`
  - `Anthropic.APIConnectionTimeoutError` $\rightarrow$ `ProviderTimeoutError`
  - `Anthropic.APIConnectionError` $\rightarrow$ `ProviderNetworkError`
- **Capabilities Matrix**:
  - `streaming`: `true`
  - `toolCalling`: `true` (Tool Use)
  - `vision`: `true` (Claude 3.5 Sonnet / Haiku / Opus)
  - `audio`: `false`
  - `reasoning`: `true` (Extended Thinking)
  - `jsonMode`: `true`

### 3.3 Google Gemini Adapter (`GeminiAdapter`)
- **SDK**: `@google/genai` (current official v3.6+)
- **Validation Strategy**: Calls `client.models.list()`. Iterates model pager to confirm API key access without running content generation calls.
- **Model Normalization**: Strips the Google-specific `models/` prefix for client consistency (e.g., `models/gemini-2.0-flash` $\rightarrow$ `gemini-2.0-flash`). Annotates standard 1,048,576 and 2,097,152 token context windows.
- **Error Mapping**:
  - `ApiError` (status 400 or 403 or code `API_KEY_INVALID`) $\rightarrow$ `InvalidCredentialsError`
  - `ApiError` (status 429 or `RESOURCE_EXHAUSTED`) $\rightarrow$ `RateLimitError`
  - `ApiError` (status 503 or `UNAVAILABLE`) $\rightarrow$ `ProviderUnavailableError`
- **Capabilities Matrix**:
  - `streaming`: `true`
  - `toolCalling`: `true`
  - `vision`: `true`
  - `audio`: `true`
  - `reasoning`: `true` (Thinking models)
  - `jsonMode`: `true`

---

## 4. Provider Registry Pattern

The `ProviderRegistry` class manages available adapters in an extensible map:

```typescript
export class ProviderRegistry {
  private adapters = new Map<SupportedProviderId, IProviderAdapter>();

  public register(adapter: IProviderAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  public get(id: SupportedProviderId): IProviderAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new ProviderError(`Provider "${id}" is not supported.`, "UNSUPPORTED_OPERATION");
    return adapter;
  }

  public listSupportedProviders(): ProviderMetadata[] {
    return Array.from(this.adapters.values()).map(a => a.getMetadata());
  }
}
```

A pre-initialized `defaultProviderRegistry` is exported and used by the backend service layer.

---

## 5. Adding New Providers (Extensibility Guide)

To register a future provider (such as Ollama, Mistral, Groq, or DeepSeek):

1. **Add Provider Enum**:
   Update `SupportedProviderId` in `@messiah/shared/src/types/providers.ts`:
   ```typescript
   export type SupportedProviderId = "openai" | "anthropic" | "gemini" | "ollama";
   ```
2. **Implement Adapter**:
   Create `packages/providers/src/adapters/ollama.ts` implementing `IProviderAdapter`.
3. **Register in Registry**:
   In `packages/providers/src/registry/index.ts`, instantiate and register the adapter in `createDefaultRegistry()`.
4. **Database & UI**:
   The database schema uses text-based provider IDs with enum validation at the Zod and application layer, making future additions non-breaking for existing database rows.
