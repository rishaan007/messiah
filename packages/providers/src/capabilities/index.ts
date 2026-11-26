import type { ProviderCapabilityMap } from "@messiah/shared";

export const DEFAULT_OPENAI_CAPABILITIES: ProviderCapabilityMap = {
  streaming: true,
  toolCalling: true,
  vision: true,
  systemPrompt: true,
  modelListing: true,
  embeddings: true,
};

export const DEFAULT_ANTHROPIC_CAPABILITIES: ProviderCapabilityMap = {
  streaming: true,
  toolCalling: true,
  vision: true,
  systemPrompt: true,
  modelListing: true,
  embeddings: false,
};

export const DEFAULT_GEMINI_CAPABILITIES: ProviderCapabilityMap = {
  streaming: true,
  toolCalling: true,
  vision: true,
  systemPrompt: true,
  modelListing: true,
  embeddings: true,
};
