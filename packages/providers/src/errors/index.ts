import type { SupportedProviderId } from "@messiah/shared";

export type ProviderErrorCode =
  | "INVALID_CREDENTIALS"
  | "RATE_LIMIT_EXCEEDED"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_NETWORK_ERROR"
  | "PROVIDER_UNAVAILABLE"
  | "UNSUPPORTED_OPERATION"
  | "MALFORMED_RESPONSE"
  | "GENERATION_FAILED"
  | "STREAMING_ERROR"
  | "UNKNOWN_PROVIDER_ERROR";

export class ProviderError extends Error {
  public readonly provider: SupportedProviderId;
  public readonly code: ProviderErrorCode;
  public readonly statusCode?: number;
  public readonly details?: unknown;

  constructor(options: {
    provider: SupportedProviderId;
    code: ProviderErrorCode;
    message: string;
    statusCode?: number;
    details?: unknown;
    cause?: unknown;
  }) {
    super(options.message);
    this.name = "ProviderError";
    this.provider = options.provider;
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.details = options.details;
    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

export class InvalidCredentialsError extends ProviderError {
  constructor(provider: SupportedProviderId, message = "Invalid API key or credentials provided", details?: unknown) {
    super({
      provider,
      code: "INVALID_CREDENTIALS",
      message,
      statusCode: 401,
      details,
    });
    this.name = "InvalidCredentialsError";
  }
}

export class RateLimitError extends ProviderError {
  constructor(provider: SupportedProviderId, message = "Provider rate limit exceeded. Please retry later.", details?: unknown) {
    super({
      provider,
      code: "RATE_LIMIT_EXCEEDED",
      message,
      statusCode: 429,
      details,
    });
    this.name = "RateLimitError";
  }
}

export class ProviderTimeoutError extends ProviderError {
  constructor(provider: SupportedProviderId, message = "Request to provider timed out", details?: unknown) {
    super({
      provider,
      code: "PROVIDER_TIMEOUT",
      message,
      statusCode: 504,
      details,
    });
    this.name = "ProviderTimeoutError";
  }
}

export class ProviderNetworkError extends ProviderError {
  constructor(provider: SupportedProviderId, message = "Network communication error connecting to provider", details?: unknown) {
    super({
      provider,
      code: "PROVIDER_NETWORK_ERROR",
      message,
      statusCode: 502,
      details,
    });
    this.name = "ProviderNetworkError";
  }
}

export class ProviderUnavailableError extends ProviderError {
  constructor(provider: SupportedProviderId, message = "Provider is currently unavailable or experiencing an outage", details?: unknown) {
    super({
      provider,
      code: "PROVIDER_UNAVAILABLE",
      message,
      statusCode: 503,
      details,
    });
    this.name = "ProviderUnavailableError";
  }
}
