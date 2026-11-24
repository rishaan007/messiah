import OpenAI, {
  AuthenticationError,
  RateLimitError as OpenAIRateLimitError,
  APIConnectionTimeoutError,
  APIConnectionError,
} from "openai";
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
import { DEFAULT_OPENAI_CAPABILITIES } from "../capabilities/index.js";
import {
  InvalidCredentialsError,
  RateLimitError,
  ProviderTimeoutError,
  ProviderNetworkError,
  ProviderError,
} from "../errors/index.js";

export class OpenAIAdapter implements IProviderAdapter {
  public readonly id = "openai" as const;

  public readonly metadata: ProviderMetadataInfo = {
    id: "openai",
    name: "OpenAI",
    description:
      "Industry-standard frontier models including GPT-4o, GPT-4o-mini, o1, and o3-mini.",
    websiteUrl: "https://openai.com",
    docsUrl: "https://platform.openai.com/docs",
    authType: "api_key",
    requiresGenerationForValidation: false,
    capabilities: DEFAULT_OPENAI_CAPABILITIES,
    supportedModelsEndpoint: true,
  };

  protected createClient(credentials: ProviderCredentials): OpenAI {
    return new OpenAI({
      apiKey: credentials.apiKey,
      baseURL: credentials.baseUrl,
      organization: credentials.organizationId,
      timeout: 30000,
      maxRetries: 1,
    });
  }

  public async validateCredentials(
    credentials: ProviderCredentials
  ): Promise<ConnectionValidationResult> {
    try {
      const client = this.createClient(credentials);
      // Non-generation model listing endpoint to prevent billable token consumption
      const response = await client.models.list();
      let count = 0;
      for await (const model of response) {
        if (model) count++;
        if (count >= 100) break;
      }

      return {
        valid: true,
        message: `Successfully authenticated with OpenAI API (${count} models available).`,
        testedAt: new Date().toISOString(),
        modelsFound: count,
      };
    } catch (err: unknown) {
      throw this.mapOpenAIError(err);
    }
  }

  public async listModels(credentials: ProviderCredentials): Promise<ModelInfo[]> {
    try {
      const client = this.createClient(credentials);
      const response = await client.models.list();
      const models: ModelInfo[] = [];

      for await (const m of response) {
        const id = m.id;
        const isVision =
          id.includes("4o") || id.includes("vision") || id.startsWith("o1");
        const isReasoning = id.startsWith("o1") || id.startsWith("o3");
        const isToolCalling =
          id.includes("gpt-4") || id.includes("gpt-3.5") || isReasoning;

        models.push({
          id,
          name: id,
          provider: this.id,
          capabilities: {
            vision: isVision,
            toolCalling: isToolCalling,
            reasoning: isReasoning,
          },
          status: "available",
        });
      }

      return models.sort((a, b) => a.id.localeCompare(b.id));
    } catch (err: unknown) {
      throw this.mapOpenAIError(err);
    }
  }

  /**
   * Universal streaming response implementation using OpenAI Responses API with
   * fallback to standard Chat Completions. Supports function calling / MCP tool requests.
   */
  public async *streamResponse(
    request: ProviderStreamRequest,
    abortSignal?: AbortSignal
  ): AsyncIterable<ProviderStreamEvent> {
    const client = this.createClient(request.credentials);

    try {
      const hasResponsesApi =
        Boolean(client.responses) && typeof client.responses.create === "function";

      const useResponsesApi =
        request.protocolMode === "responses" ||
        (request.protocolMode !== "chat_completions" && hasResponsesApi);

      // Build tool definitions
      const responseTools = request.tools && request.tools.length > 0
        ? request.tools.map((t) => ({
            type: "function" as const,
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          }))
        : undefined;

      const completionTools = request.tools && request.tools.length > 0
        ? request.tools.map((t) => ({
            type: "function" as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          }))
        : undefined;

      if (useResponsesApi) {
        // Format input items strictly conforming to OpenAI Responses API specification.
        // Never mix with Chat Completions messages in the same conversation history.
        const input: any[] = [];
        for (const m of request.messages) {
          if (m.role === "tool" && m.toolCallId) {
            input.push({
              type: "function_call_output",
              call_id: m.toolCallId,
              output: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
            });
          } else if (m.toolCalls && m.toolCalls.length > 0) {
            if (m.content) {
              input.push({ role: "assistant", content: m.content });
            }
            for (const tc of m.toolCalls) {
              input.push({
                type: "function_call",
                call_id: tc.providerCallId,
                name: tc.toolName,
                arguments:
                  typeof tc.arguments === "string"
                    ? tc.arguments
                    : JSON.stringify(tc.arguments),
              });
            }
          } else {
            input.push({
              role: m.role as "user" | "assistant" | "system",
              content: m.content || "",
            });
          }
        }

        const responseStream = await client.responses.create(
          {
            model: request.model,
            input: input as any,
            instructions: request.systemPrompt || undefined,
            temperature: request.temperature,
            max_output_tokens: request.maxTokens,
            tools: responseTools as any,
            stream: true,
          },
          { signal: abortSignal }
        );

        let currentResponseId: string | undefined;
        const activeToolCalls = new Map<string, { callId: string; name: string; argsAccumulator: string }>();

        for await (const event of responseStream) {
          if (abortSignal?.aborted) {
            break;
          }

          const ev = event as unknown as Record<string, unknown>;
          const eventType = String(ev.type || ev.event || "");

          if (eventType === "response.created") {
            const resp = ev.response as Record<string, unknown> | undefined;
            if (resp?.id) {
              currentResponseId = String(resp.id);
            }
          } else if (
            eventType === "response.output_text.delta" ||
            eventType === "response.text.delta"
          ) {
            const delta = ev.delta as string | undefined;
            if (delta) {
              yield { type: "text_delta", text: delta };
            }
          } else if (
            eventType === "response.output_text.done" ||
            eventType === "response.text.done"
          ) {
            continue;
          } else if (eventType === "response.output_item.added") {
            const item = ev.item as Record<string, unknown> | undefined;
            if (item && item.type === "function_call") {
              const callId = String(item.call_id || item.id || "");
              const itemId = String(item.id || "");
              const name = String(item.name || "");
              const record = { callId, name, argsAccumulator: "" };
              activeToolCalls.set(callId, record);
              if (itemId) {
                activeToolCalls.set(itemId, record);
              }
            }
          } else if (eventType === "response.function_call_arguments.delta") {
            const lookupKey = String(ev.call_id || ev.item_id || "");
            const delta = String(ev.delta || "");
            const existing = activeToolCalls.get(lookupKey);
            if (existing) {
              existing.argsAccumulator += delta;
              yield {
                type: "tool_call_delta",
                callId: existing.callId,
                toolName: existing.name,
                argumentsDelta: delta,
              };
            }
          } else if (eventType === "response.function_call_arguments.done") {
            const lookupKey = String(ev.call_id || ev.item_id || "");
            const rawArgs = String(ev.arguments || "");
            const existing = activeToolCalls.get(lookupKey);
            const toolName = existing?.name || String(ev.name || "");
            const finalCallId = existing?.callId || lookupKey;
            let parsedArgs: Record<string, unknown> = {};
            try {
              parsedArgs = rawArgs ? JSON.parse(rawArgs) : {};
            } catch {
              parsedArgs = { raw: rawArgs };
            }

            yield {
              type: "tool_call_done",
              callId: finalCallId,
              toolName,
              arguments: parsedArgs,
            };
            yield {
              type: "tool_call",
              callId: finalCallId,
              toolName,
              arguments: parsedArgs,
            };
          } else if (
            eventType === "response.completed" ||
            eventType === "response.done"
          ) {
            const resp = ev.response as Record<string, unknown> | undefined;
            const usage = resp?.usage as Record<string, unknown> | undefined;
            if (usage) {
              const tokenDetails = usage.input_token_details as Record<string, unknown> | undefined;
              yield {
                type: "usage",
                inputTokens: Number(usage.input_tokens || 0),
                outputTokens: Number(usage.output_tokens || 0),
                cachedInputTokens: Number(tokenDetails?.cached_tokens || 0),
              };
            }

            // Also check if any function calls completed in the final response item list
            if (resp?.output && Array.isArray(resp.output)) {
              for (const item of resp.output) {
                if (item && item.type === "function_call") {
                  const callId = String(item.call_id || item.id || "");
                  const toolName = String(item.name || "");
                  const rawArgs = String(item.arguments || "{}");
                  let parsedArgs: Record<string, unknown> = {};
                  try {
                    parsedArgs = JSON.parse(rawArgs);
                  } catch {
                    parsedArgs = { raw: rawArgs };
                  }
                  if (!activeToolCalls.has(callId)) {
                    yield {
                      type: "tool_call",
                      callId,
                      toolName,
                      arguments: parsedArgs,
                    };
                  }
                }
              }
            }

            yield {
              type: "completed",
              responseId: (resp?.id ? String(resp.id) : currentResponseId) || undefined,
              finishReason: resp?.status ? String(resp.status) : "completed",
            };
            return;
          } else if (eventType === "response.failed" || eventType === "error") {
            const resp = ev.response as Record<string, unknown> | undefined;
            const err = (resp?.error || ev.error) as Record<string, unknown> | undefined;
            throw new ProviderError({
              provider: this.id,
              code: "GENERATION_FAILED",
              message: String(err?.message || (typeof ev.error === "string" ? ev.error : "OpenAI response generation failed")),
            });
          } else if (eventType === "response.incomplete") {
            const resp = ev.response as Record<string, unknown> | undefined;
            yield {
              type: "completed",
              responseId: (resp?.id ? String(resp.id) : currentResponseId) || undefined,
              finishReason: "incomplete",
            };
            return;
          }
        }
        return;
      }

      // Standard Chat Completions pipeline.
      // Used when protocolMode === "chat_completions" or Responses API is unavailable.
      const chatMessages: any[] = [];
      for (const m of request.messages) {
        if (m.role === "tool" && m.toolCallId) {
          chatMessages.push({
            role: "tool",
            tool_call_id: m.toolCallId,
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          });
        } else if (m.toolCalls && m.toolCalls.length > 0) {
          chatMessages.push({
            role: "assistant",
            content: m.content || null,
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.providerCallId,
              type: "function",
              function: {
                name: tc.toolName,
                arguments:
                  typeof tc.arguments === "string"
                    ? tc.arguments
                    : JSON.stringify(tc.arguments),
              },
            })),
          });
        } else {
          chatMessages.push({
            role: m.role as "user" | "assistant" | "system",
            content: m.content || "",
          });
        }
      }

      if (request.systemPrompt && !chatMessages.some((m) => m.role === "system")) {
        chatMessages.unshift({ role: "system", content: request.systemPrompt });
      }

      const stream = await client.chat.completions.create(
        {
          model: request.model,
          messages: chatMessages,
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          tools: completionTools as any,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: abortSignal }
      );

      const completionToolCalls = new Map<number, { id: string; name: string; argsAccumulator: string }>();

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        const delta = choice?.delta;

        if (delta?.content) {
          yield { type: "text_delta", text: delta.content };
        }

        if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const index = tc.index ?? 0;
            let current = completionToolCalls.get(index);
            if (!current) {
              current = { id: tc.id || `call_${index}`, name: tc.function?.name || "", argsAccumulator: "" };
              completionToolCalls.set(index, current);
            }
            if (tc.id) current.id = tc.id;
            if (tc.function?.name) current.name = tc.function.name;
            if (tc.function?.arguments) {
              current.argsAccumulator += tc.function.arguments;
              yield {
                type: "tool_call_delta",
                callId: current.id,
                toolName: current.name,
                argumentsDelta: tc.function.arguments,
              };
            }
          }
        }

        if (chunk.usage) {
          yield {
            type: "usage",
            inputTokens: chunk.usage.prompt_tokens || 0,
            outputTokens: chunk.usage.completion_tokens || 0,
            cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens || 0,
          };
        }

        const finish = choice?.finish_reason;
        if (finish) {
          // Emit completed tool calls if any were parsed
          for (const [, tc] of completionToolCalls) {
            let parsedArgs: Record<string, unknown> = {};
            try {
              parsedArgs = tc.argsAccumulator ? JSON.parse(tc.argsAccumulator) : {};
            } catch {
              parsedArgs = { raw: tc.argsAccumulator };
            }
            yield {
              type: "tool_call_done",
              callId: tc.id,
              toolName: tc.name,
              arguments: parsedArgs,
            };
            yield {
              type: "tool_call",
              callId: tc.id,
              toolName: tc.name,
              arguments: parsedArgs,
            };
          }

          yield {
            type: "completed",
            responseId: chunk.id,
            finishReason: finish,
          };
        }
      }
    } catch (err: unknown) {
      throw this.mapOpenAIError(err);
    }
  }

  protected mapOpenAIError(err: unknown): Error {
    if (err instanceof AuthenticationError) {
      return new InvalidCredentialsError(
        this.id,
        "Invalid OpenAI API key. Authentication failed."
      );
    }
    if (err instanceof OpenAIRateLimitError) {
      return new RateLimitError(
        this.id,
        "OpenAI API rate limit or quota exceeded."
      );
    }
    if (err instanceof APIConnectionTimeoutError) {
      return new ProviderTimeoutError(
        this.id,
        "Connection to OpenAI API timed out."
      );
    }
    if (err instanceof APIConnectionError) {
      return new ProviderNetworkError(
        this.id,
        "Network communication error connecting to OpenAI."
      );
    }
    if (err instanceof ProviderError) {
      return err;
    }
    const message =
      err instanceof Error ? err.message : "Unknown error during OpenAI operation";
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
