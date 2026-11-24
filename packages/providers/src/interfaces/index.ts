import type {
  SupportedProviderId,
  ModelInfo,
  ProviderMetadataInfo,
  ProviderCapabilityMap,
  ConnectionValidationResult,
} from "@messiah/shared";

export interface ProviderCredentials {
  apiKey: string;
  baseUrl?: string;
  organizationId?: string;
}

export interface ProviderToolDefinition {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface ToolCallRequest {
  providerCallId: string;
  toolName: string;
  arguments: Record<string, unknown> | string;
  providerMetadata?: Record<string, unknown>;
}

export interface ToolCallResult {
  providerCallId: string;
  toolName?: string;
  result: unknown;
  isError?: boolean;
}

export interface ProviderChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content?: string;
  toolCalls?: ToolCallRequest[];
  toolResults?: ToolCallResult[];
  toolCallId?: string;
  toolName?: string;
}

export interface ProviderStreamRequest {
  model: string;
  messages: ProviderChatMessage[];
  temperature?: number;
  maxTokens?: number;
  credentials: ProviderCredentials;
  systemPrompt?: string;
  tools?: ProviderToolDefinition[];
  protocolMode?: "responses" | "chat_completions";
}

export type ProviderStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_delta"; callId: string; toolName?: string; argumentsDelta: string }
  | { type: "tool_call_done"; callId: string; toolName: string; arguments: Record<string, unknown> | string }
  | { type: "tool_call"; callId: string; toolName: string; arguments: Record<string, unknown> | string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cachedInputTokens?: number }
  | { type: "completed"; responseId?: string; finishReason?: string };

export interface IProviderAdapter {
  readonly id: SupportedProviderId;
  readonly metadata: ProviderMetadataInfo;

  validateCredentials(
    credentials: ProviderCredentials
  ): Promise<ConnectionValidationResult>;

  listModels(credentials: ProviderCredentials): Promise<ModelInfo[]>;

  streamResponse(
    request: ProviderStreamRequest,
    abortSignal?: AbortSignal
  ): AsyncIterable<ProviderStreamEvent>;

  getCapabilities(): ProviderCapabilityMap;

  getProviderMetadata(): ProviderMetadataInfo;
}
