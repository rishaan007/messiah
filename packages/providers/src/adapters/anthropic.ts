import Anthropic, {
  AuthenticationError,
  RateLimitError as AnthropicRateLimitError,
  APIConnectionTimeoutError,
  APIConnectionError,
} from "@anthropic-ai/sdk";
import type {
  ModelInfo,
  ProviderCapabilityMap,
  ProviderMetadataInfo,
  ConnectionValidationResult,
} from "@messiah/shared";
import type {
  IProviderAdapter,
  ProviderCredentials,
  ProviderStreamRequest,
  ProviderStreamEvent,
} from "../interfaces/index.js";
import { DEFAULT_ANTHROPIC_CAPABILITIES } from "../capabilities/index.js";
import {
  InvalidCredentialsError,
  RateLimitError,
  ProviderTimeoutError,
  ProviderNetworkError,
  ProviderError,
} from "../errors/index.js";

export class AnthropicAdapter implements IProviderAdapter {
  public readonly id = "anthropic" as const;

  public readonly metadata: ProviderMetadataInfo = {
    id: "anthropic",
    name: "Anthropic",
    description:
      "State-of-the-art reasoning and code intelligence models including Claude 3.7 Sonnet, Claude 3.5 Sonnet, and Claude 3.5 Haiku.",
    websiteUrl: "https://anthropic.com",
    docsUrl: "https://docs.anthropic.com",
    authType: "api_key",
    requiresGenerationForValidation: false,
    capabilities: DEFAULT_ANTHROPIC_CAPABILITIES,
    supportedModelsEndpoint: true,
  };

  protected createClient(credentials: ProviderCredentials): Anthropic {
    return new Anthropic({
      apiKey: credentials.apiKey,
      baseURL: credentials.baseUrl,
      timeout: 30000,
      maxRetries: 1,
    });
  }

  public async validateCredentials(
    credentials: ProviderCredentials
  ): Promise<ConnectionValidationResult> {
    try {
      const client = this.createClient(credentials);
      // Non-generation metadata check using models.list
      const response = await client.models.list({ limit: 20 });
      const count = response.data.length;

      return {
        valid: true,
        message: `Successfully authenticated with Anthropic API (${count} models available).`,
        testedAt: new Date().toISOString(),
        modelsFound: count,
      };
    } catch (err: unknown) {
      throw this.mapAnthropicError(err);
    }
  }

  public async listModels(credentials: ProviderCredentials): Promise<ModelInfo[]> {
    try {
      const client = this.createClient(credentials);
      const response = await client.models.list({ limit: 50 });

      return response.data.map((m) => {
        const id = m.id;
        const displayName = m.display_name || id;

        return {
          id,
          name: displayName,
          provider: this.id,
          contextWindow: 200000,
          maxOutputTokens: id.includes("3-7") ? 128000 : 8192,
          capabilities: {
            vision: true,
            toolCalling: true,
            reasoning: id.includes("3-7") || id.includes("opus"),
          },
          status: "available",
        };
      });
    } catch (err: unknown) {
      throw this.mapAnthropicError(err);
    }
  }

  /**
   * Streams Anthropic message responses using Messages API streaming.
   * Supports tool-use (MCP) definitions, streaming argument deltas, tool completion,
   * and continuation after tool results. Strictly filters out thinking deltas.
   */
  public async *streamResponse(
    request: ProviderStreamRequest,
    abortSignal?: AbortSignal
  ): AsyncIterable<ProviderStreamEvent> {
    const client = this.createClient(request.credentials);

    try {
      // 1. Separate system prompt from conversation messages
      let systemPrompt = request.systemPrompt;
      const conversationMessages: Anthropic.MessageParam[] = [];

      for (const m of request.messages) {
        if (m.role === "system") {
          systemPrompt = (systemPrompt ? `${systemPrompt}\n\n` : "") + (m.content || "");
        } else if (m.role === "tool" && m.toolCallId) {
          // Tool result returned as a user message with tool_result content block.
          // Merge with preceding user message if present to enforce strict role alternation.
          const block: Anthropic.ToolResultBlockParam = {
            type: "tool_result",
            tool_use_id: m.toolCallId,
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          };
          const lastMsg = conversationMessages[conversationMessages.length - 1];
          if (lastMsg && lastMsg.role === "user" && Array.isArray(lastMsg.content)) {
            (lastMsg.content as any[]).push(block);
          } else {
            conversationMessages.push({
              role: "user",
              content: [block],
            });
          }
        } else if (m.toolResults && m.toolResults.length > 0) {
          const blocks: Anthropic.ToolResultBlockParam[] = m.toolResults.map((tr) => ({
            type: "tool_result",
            tool_use_id: tr.providerCallId,
            content: typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result),
            is_error: tr.isError,
          }));
          const lastMsg = conversationMessages[conversationMessages.length - 1];
          if (lastMsg && lastMsg.role === "user" && Array.isArray(lastMsg.content)) {
            (lastMsg.content as any[]).push(...blocks);
          } else {
            conversationMessages.push({
              role: "user",
              content: blocks,
            });
          }
        } else if (m.toolCalls && m.toolCalls.length > 0) {
          // Assistant message containing tool_use blocks
          const blocks: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = [];
          if (m.content) {
            blocks.push({ type: "text", text: m.content });
          }
          for (const tc of m.toolCalls) {
            let parsedInput: Record<string, unknown> = {};
            if (typeof tc.arguments === "string") {
              try {
                parsedInput = JSON.parse(tc.arguments);
              } catch {
                parsedInput = { raw: tc.arguments };
              }
            } else if (tc.arguments && typeof tc.arguments === "object") {
              parsedInput = tc.arguments as Record<string, unknown>;
            }

            blocks.push({
              type: "tool_use",
              id: tc.providerCallId,
              name: tc.toolName,
              input: parsedInput,
            });
          }
          conversationMessages.push({
            role: "assistant",
            content: blocks,
          });
        } else {
          conversationMessages.push({
            role: m.role as "user" | "assistant",
            content: m.content || "",
          });
        }
      }

      // If empty, supply greeting
      if (conversationMessages.length === 0) {
        conversationMessages.push({ role: "user", content: "Hello" });
      }

      // Format tools for Anthropic
      const anthropicTools: Anthropic.Tool[] | undefined =
        request.tools && request.tools.length > 0
          ? request.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: (t.parameters as Anthropic.Tool.InputSchema) || {
                type: "object",
                properties: {},
              },
            }))
          : undefined;

      const stream = await client.messages.create(
        {
          model: request.model,
          messages: conversationMessages,
          system: systemPrompt || undefined,
          max_tokens: request.maxTokens || 4096,
          tools: anthropicTools,
          stream: true,
        },
        { signal: abortSignal }
      );

      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason: string | undefined;

      let currentToolCall: {
        id: string;
        name: string;
        argsJson: string;
      } | null = null;

      for await (const event of stream) {
        if (event.type === "message_start") {
          if (event.message?.usage) {
            inputTokens = event.message.usage.input_tokens || 0;
          }
        } else if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block.type === "tool_use") {
            currentToolCall = {
              id: block.id,
              name: block.name,
              argsJson: "",
            };
          }
        } else if (event.type === "content_block_delta") {
          const delta = event.delta;
          if (delta.type === "text_delta") {
            // Strictly handle text_delta only — omit thinking_delta or internal CoT
            yield { type: "text_delta", text: delta.text };
          } else if (delta.type === "input_json_delta") {
            if (currentToolCall) {
              currentToolCall.argsJson += delta.partial_json;
              yield {
                type: "tool_call_delta",
                callId: currentToolCall.id,
                toolName: currentToolCall.name,
                argumentsDelta: delta.partial_json,
              };
            }
          }
        } else if (event.type === "content_block_stop") {
          if (currentToolCall) {
            let parsedArgs: Record<string, unknown> = {};
            try {
              parsedArgs = currentToolCall.argsJson
                ? JSON.parse(currentToolCall.argsJson)
                : {};
            } catch {
              parsedArgs = { raw: currentToolCall.argsJson };
            }

            yield {
              type: "tool_call_done",
              callId: currentToolCall.id,
              toolName: currentToolCall.name,
              arguments: parsedArgs,
            };
            yield {
              type: "tool_call",
              callId: currentToolCall.id,
              toolName: currentToolCall.name,
              arguments: parsedArgs,
            };
            currentToolCall = null;
          }
        } else if (event.type === "message_delta") {
          if (event.usage) {
            outputTokens = event.usage.output_tokens || 0;
          }
          if (event.delta?.stop_reason) {
            stopReason = event.delta.stop_reason;
          }
        } else if (event.type === "message_stop") {
          yield {
            type: "usage",
            inputTokens,
            outputTokens,
          };
          yield {
            type: "completed",
            finishReason: stopReason || "end_turn",
          };
          return;
        }
      }

      // Fallback completion
      yield {
        type: "usage",
        inputTokens,
        outputTokens,
      };
      yield {
        type: "completed",
        finishReason: stopReason || "end_turn",
      };
    } catch (err: unknown) {
      throw this.mapAnthropicError(err);
    }
  }

  protected mapAnthropicError(err: unknown): Error {
    if (err instanceof AuthenticationError) {
      return new InvalidCredentialsError(
        this.id,
        "Invalid Anthropic API key. Authentication failed."
      );
    }
    if (err instanceof AnthropicRateLimitError) {
      return new RateLimitError(
        this.id,
        "Anthropic API rate limit or quota exceeded."
      );
    }
    if (err instanceof APIConnectionTimeoutError) {
      return new ProviderTimeoutError(
        this.id,
        "Connection to Anthropic API timed out."
      );
    }
    if (err instanceof APIConnectionError) {
      return new ProviderNetworkError(
        this.id,
        "Network communication error connecting to Anthropic."
      );
    }
    if (err instanceof ProviderError) {
      return err;
    }
    const message =
      err instanceof Error ? err.message : "Unknown error during Anthropic operation";
    return new ProviderError({
      provider: this.id,
      code: "UNKNOWN_PROVIDER_ERROR",
      message,
    });
  }

  public getCapabilities(): ProviderCapabilityMap {
    return this.metadata.capabilities;
  }

  public getProviderMetadata(): ProviderMetadataInfo {
    return this.metadata;
  }
}
