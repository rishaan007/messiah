import { GoogleGenAI, ApiError } from "@google/genai";
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
import { DEFAULT_GEMINI_CAPABILITIES } from "../capabilities/index.js";
import {
  InvalidCredentialsError,
  RateLimitError,
  ProviderTimeoutError,
  ProviderNetworkError,
  ProviderUnavailableError,
  ProviderError,
} from "../errors/index.js";

export class GeminiAdapter implements IProviderAdapter {
  public readonly id = "gemini" as const;

  public readonly metadata: ProviderMetadataInfo = {
    id: "gemini",
    name: "Google Gemini",
    description:
      "High-throughput multimodal models with massive context windows, including Gemini 2.0 Flash, Gemini 1.5 Pro, and Gemini 1.5 Flash.",
    websiteUrl: "https://ai.google.dev",
    docsUrl: "https://ai.google.dev/gemini-api/docs",
    authType: "api_key",
    requiresGenerationForValidation: false,
    capabilities: DEFAULT_GEMINI_CAPABILITIES,
    supportedModelsEndpoint: true,
  };

  protected createClient(credentials: ProviderCredentials): GoogleGenAI {
    return new GoogleGenAI({
      apiKey: credentials.apiKey,
    });
  }

  public async validateCredentials(
    credentials: ProviderCredentials
  ): Promise<ConnectionValidationResult> {
    try {
      const client = this.createClient(credentials);
      // Non-generation model listing metadata endpoint
      const pager = await client.models.list();
      let count = 0;

      for await (const model of pager) {
        if (model) count++;
        if (count >= 50) break;
      }

      return {
        valid: true,
        message: `Successfully authenticated with Google Gemini API (${count} models available).`,
        testedAt: new Date().toISOString(),
        modelsFound: count,
      };
    } catch (err: unknown) {
      throw this.mapGeminiError(err);
    }
  }

  public async listModels(credentials: ProviderCredentials): Promise<ModelInfo[]> {
    try {
      const client = this.createClient(credentials);
      const pager = await client.models.list();
      const models: ModelInfo[] = [];

      for await (const m of pager) {
        // Strip models/ prefix if returned by API (e.g., models/gemini-1.5-flash -> gemini-1.5-flash)
        const rawName = m.name || "";
        const cleanId = rawName.startsWith("models/")
          ? rawName.replace("models/", "")
          : rawName;

        // Skip non-gemini embeddings or internal models unless relevant
        if (!cleanId.includes("gemini") && !cleanId.includes("gemma")) {
          continue;
        }

        const isVision =
          cleanId.includes("flash") ||
          cleanId.includes("pro") ||
          cleanId.includes("vision");
        const isReasoning =
          cleanId.includes("thinking") || cleanId.includes("pro");

        models.push({
          id: cleanId,
          name: m.displayName || cleanId,
          provider: this.id,
          contextWindow: m.inputTokenLimit || 1048576,
          maxOutputTokens: m.outputTokenLimit || 8192,
          capabilities: {
            vision: isVision,
            toolCalling: true,
            reasoning: isReasoning,
          },
          status: "available",
        });
      }

      return models.sort((a, b) => a.id.localeCompare(b.id));
    } catch (err: unknown) {
      throw this.mapGeminiError(err);
    }
  }

  /**
   * Streams Gemini message responses using @google/genai generateContentStream.
   */
  public async *streamResponse(
    request: ProviderStreamRequest,
    _abortSignal?: AbortSignal
  ): AsyncIterable<ProviderStreamEvent> {
    const client = this.createClient(request.credentials);

    try {
      // Map contents into Google Gemini expected format
      const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];

      for (const m of request.messages) {
        if (m.role === "system") continue;

        if (m.role === "assistant") {
          const parts: Array<Record<string, unknown>> = [];
          if (m.content) {
            parts.push({ text: m.content });
          }
          if (m.toolCalls && m.toolCalls.length > 0) {
            for (const tc of m.toolCalls) {
              let parsedArgs = tc.arguments;
              if (typeof parsedArgs === "string") {
                try {
                  parsedArgs = JSON.parse(parsedArgs);
                } catch {
                  parsedArgs = {};
                }
              }
              parts.push({
                functionCall: {
                  id: tc.providerCallId,
                  name: tc.toolName,
                  args: (parsedArgs && typeof parsedArgs === "object") ? parsedArgs : {},
                },
              });
            }
          }
          if (parts.length > 0) {
            contents.push({ role: "model", parts });
          }
        } else if (m.role === "tool") {
          const parts: Array<Record<string, unknown>> = [];
          if (m.toolResults && m.toolResults.length > 0) {
            for (const tr of m.toolResults) {
              let parsedResult = tr.result;
              if (typeof parsedResult === "string") {
                try {
                  parsedResult = JSON.parse(parsedResult);
                } catch {
                  parsedResult = { output: tr.result };
                }
              }
              parts.push({
                functionResponse: {
                  id: tr.providerCallId,
                  name: tr.toolName,
                  response: tr.isError
                    ? { error: parsedResult }
                    : (parsedResult && typeof parsedResult === "object" && !Array.isArray(parsedResult))
                    ? parsedResult
                    : { output: parsedResult },
                },
              });
            }
          } else if (m.toolCallId || m.toolName) {
            let parsedResult: unknown = m.content || "";
            if (m.content) {
              try {
                parsedResult = JSON.parse(m.content);
              } catch {
                parsedResult = { output: m.content };
              }
            } else {
              parsedResult = {};
            }
            parts.push({
              functionResponse: {
                id: m.toolCallId,
                name: m.toolName || "tool",
                response: (parsedResult && typeof parsedResult === "object" && !Array.isArray(parsedResult))
                  ? (parsedResult as Record<string, unknown>)
                  : { output: parsedResult },
              },
            });
          } else {
            parts.push({ text: m.content || "" });
          }
          if (parts.length > 0) {
            const last = contents[contents.length - 1];
            if (last && last.role === "user") {
              last.parts.push(...parts);
            } else {
              contents.push({ role: "user", parts });
            }
          }
        } else {
          // User role
          const userParts = [{ text: m.content || "" }];
          const last = contents[contents.length - 1];
          if (last && last.role === "user") {
            last.parts.push(...userParts);
          } else {
            contents.push({
              role: "user",
              parts: userParts,
            });
          }
        }
      }

      // Extract system instructions if provided
      let systemInstruction = request.systemPrompt;
      const systemMsg = request.messages.find((m) => m.role === "system");
      if (systemMsg) {
        systemInstruction = (systemInstruction ? `${systemInstruction}\n\n` : "") + systemMsg.content;
      }

      const config: Record<string, unknown> = {
        systemInstruction: systemInstruction || undefined,
        temperature: request.temperature,
        maxOutputTokens: request.maxTokens,
      };

      if (request.tools && request.tools.length > 0) {
        config.tools = [
          {
            functionDeclarations: request.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.parameters as Record<string, unknown>,
            })),
          },
        ];
      }

      const responseStream = await client.models.generateContentStream({
        model: request.model,
        contents: contents as any,
        config: config as any,
      });

      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let cachedTokens = 0;

      for await (const chunk of responseStream) {
        const candidates = (chunk as any).candidates;
        if (candidates && Array.isArray(candidates) && candidates.length > 0) {
          for (const cand of candidates) {
            if (cand.content?.parts && Array.isArray(cand.content.parts)) {
              for (const part of cand.content.parts) {
                if (part.thought) {
                  continue;
                }
                if (part.text) {
                  yield { type: "text_delta", text: part.text };
                }
                if (part.functionCall) {
                  const fc = part.functionCall;
                  const callId = fc.id || `gemini_call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                  const rawArgs = typeof fc.args === "string" ? fc.args : JSON.stringify(fc.args || {});
                  let parsedArgs: Record<string, unknown> | string = rawArgs;
                  if (typeof fc.args === "object" && fc.args !== null) {
                    parsedArgs = fc.args as Record<string, unknown>;
                  } else {
                    try {
                      parsedArgs = JSON.parse(rawArgs);
                    } catch {
                      parsedArgs = rawArgs;
                    }
                  }
                  yield {
                    type: "tool_call",
                    callId,
                    toolName: fc.name || "",
                    arguments: parsedArgs,
                  };
                  yield {
                    type: "tool_call_done",
                    callId,
                    toolName: fc.name || "",
                    arguments: parsedArgs,
                  };
                }
              }
            }
          }
        } else if (chunk.text) {
          yield { type: "text_delta", text: chunk.text };
        }

        if (chunk.usageMetadata) {
          totalInputTokens = chunk.usageMetadata.promptTokenCount || totalInputTokens;
          totalOutputTokens = chunk.usageMetadata.candidatesTokenCount || totalOutputTokens;
          cachedTokens = chunk.usageMetadata.cachedContentTokenCount || cachedTokens;
        }
      }

      if (totalInputTokens > 0 || totalOutputTokens > 0) {
        yield {
          type: "usage",
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cachedInputTokens: cachedTokens,
        };
      }

      yield {
        type: "completed",
        finishReason: "stop",
      };
    } catch (err: unknown) {
      throw this.mapGeminiError(err);
    }
  }

  protected mapGeminiError(err: unknown): Error {
    if (err instanceof ApiError) {
      const msg = err.message.toLowerCase();
      if (
        err.status === 400 ||
        err.status === 403 ||
        msg.includes("api key") ||
        msg.includes("api_key") ||
        msg.includes("permission")
      ) {
        return new InvalidCredentialsError(
          this.id,
          "Invalid Google Gemini API key or insufficient permissions."
        );
      }
      if (err.status === 429) {
        return new RateLimitError(
          this.id,
          "Google Gemini API rate limit or quota exceeded."
        );
      }
      if (err.status !== undefined && err.status >= 500) {
        return new ProviderUnavailableError(
          this.id,
          "Google Gemini service is currently reporting a server outage."
        );
      }
    }

    const errString = String(err).toLowerCase();
    if (errString.includes("timeout") || errString.includes("timed out")) {
      return new ProviderTimeoutError(
        this.id,
        "Connection to Google Gemini API timed out."
      );
    }
    if (errString.includes("enotfound") || errString.includes("network")) {
      return new ProviderNetworkError(
        this.id,
        "Network communication error connecting to Google Gemini API."
      );
    }
    if (err instanceof ProviderError) {
      return err;
    }

    const message =
      err instanceof Error ? err.message : "Unknown error during Google Gemini operation";
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
