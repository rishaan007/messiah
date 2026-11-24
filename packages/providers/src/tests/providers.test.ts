import { describe, it, expect, vi, beforeEach } from "vitest";
import { defaultProviderRegistry, ProviderRegistry } from "../registry/index.js";
import { OpenAIAdapter } from "../adapters/openai.js";
import { AnthropicAdapter } from "../adapters/anthropic.js";
import { GeminiAdapter } from "../adapters/gemini.js";
import {
  InvalidCredentialsError,
  RateLimitError,
  ProviderTimeoutError,
  ProviderNetworkError,
  ProviderUnavailableError,
  ProviderError,
} from "../errors/index.js";
import {
  AuthenticationError as OpenAIAuthError,
  RateLimitError as OpenAIRateError,
  APIConnectionTimeoutError as OpenAITimeoutError,
  APIConnectionError as OpenAINetworkError,
} from "openai";
import {
  AuthenticationError as AnthropicAuthError,
  RateLimitError as AnthropicRateError,
} from "@anthropic-ai/sdk";
import { ApiError as GeminiApiError } from "@google/genai";

describe("MESSIAH Providers Layer Test Suite", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("1. Provider Registry", () => {
    it("should register default adapters for OpenAI, Anthropic, and Gemini", () => {
      const registry = new ProviderRegistry();
      expect(registry.isSupported("openai")).toBe(true);
      expect(registry.isSupported("anthropic")).toBe(true);
      expect(registry.isSupported("gemini")).toBe(true);
      expect(registry.isSupported("unknown_provider")).toBe(false);
    });

    it("should list all supported provider metadata with declared capabilities", () => {
      const providers = defaultProviderRegistry.listSupportedProviders();
      expect(providers.length).toBe(3);

      const ids = providers.map((p) => p.id);
      expect(ids).toContain("openai");
      expect(ids).toContain("anthropic");
      expect(ids).toContain("gemini");

      providers.forEach((p) => {
        expect(p.capabilities.streaming).toBe(true);
        expect(p.capabilities.toolCalling).toBe(true);
        expect(p.capabilities.modelListing).toBe(true);
        expect(p.requiresGenerationForValidation).toBe(false);
      });
    });

    it("should throw ProviderError with UNSUPPORTED_OPERATION for unknown provider", () => {
      expect(() =>
        // @ts-expect-error testing invalid provider
        defaultProviderRegistry.getAdapter("non_existent")
      ).toThrow(ProviderError);
    });
  });

  describe("2. OpenAI Adapter", () => {
    const adapter = new OpenAIAdapter();

    it("should validate credentials successfully using non-generation models.list endpoint", async () => {
      const mockList = vi.fn().mockResolvedValue([
        { id: "gpt-4o" },
        { id: "gpt-4o-mini" },
        { id: "o1" },
      ]);

      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        models: { list: mockList },
      });

      const result = await adapter.validateCredentials({ apiKey: "sk-mock-valid-key" });
      expect(result.valid).toBe(true);
      expect(result.modelsFound).toBe(3);
      expect(result.testedAt).toBeDefined();
    });

    it("should throw InvalidCredentialsError on 401 AuthenticationError", async () => {
      const mockList = vi.fn().mockRejectedValue(
        new OpenAIAuthError(401, { error: { message: "Incorrect API key" } }, "Incorrect API key", new Headers())
      );

      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        models: { list: mockList },
      });

      await expect(adapter.validateCredentials({ apiKey: "sk-invalid-key" })).rejects.toThrow(
        InvalidCredentialsError
      );
    });

    it("should throw RateLimitError on 429 RateLimitError", async () => {
      const mockList = vi.fn().mockRejectedValue(
        new OpenAIRateError(429, { error: { message: "Quota exceeded" } }, "Quota exceeded", new Headers())
      );

      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        models: { list: mockList },
      });

      await expect(adapter.validateCredentials({ apiKey: "sk-rate-limited-key" })).rejects.toThrow(
        RateLimitError
      );
    });

    it("should throw ProviderTimeoutError on connection timeout", async () => {
      const mockList = vi.fn().mockRejectedValue(
        new OpenAITimeoutError({ message: "Request timed out" })
      );

      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        models: { list: mockList },
      });

      await expect(adapter.validateCredentials({ apiKey: "sk-timeout-key" })).rejects.toThrow(
        ProviderTimeoutError
      );
    });

    it("should throw ProviderNetworkError on network failure", async () => {
      const mockList = vi.fn().mockRejectedValue(
        new OpenAINetworkError({ message: "Network unreachable" })
      );

      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        models: { list: mockList },
      });

      await expect(adapter.validateCredentials({ apiKey: "sk-network-error-key" })).rejects.toThrow(
        ProviderNetworkError
      );
    });

    it("should parse and tag model capabilities accurately", async () => {
      const mockList = vi.fn().mockResolvedValue([
        { id: "gpt-4o" },
        { id: "o1-mini" },
        { id: "text-embedding-3-small" },
      ]);

      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        models: { list: mockList },
      });

      const models = await adapter.listModels({ apiKey: "sk-mock-key" });
      expect(models.length).toBe(3);

      const gpt4o = models.find((m) => m.id === "gpt-4o");
      expect(gpt4o?.capabilities.vision).toBe(true);
      expect(gpt4o?.capabilities.toolCalling).toBe(true);

      const o1 = models.find((m) => m.id === "o1-mini");
      expect(o1?.capabilities.reasoning).toBe(true);
    });

    it("should stream text deltas, usage, and completion from Responses API with created, done, and completed events", async () => {
      async function* mockResponsesStream() {
        yield { type: "response.created", response: { id: "resp_created_001" } };
        yield { type: "response.output_text.delta", delta: "Hello" };
        yield { type: "response.output_text.delta", delta: " world!" };
        yield { type: "response.output_text.done", output_index: 0 };
        yield {
          type: "response.completed",
          response: {
            id: "resp_123",
            status: "completed",
            usage: {
              input_tokens: 12,
              output_tokens: 5,
              input_token_details: { cached_tokens: 2 },
            },
          },
        };
      }

      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        responses: { create: vi.fn().mockResolvedValue(mockResponsesStream()) },
      });

      const events: any[] = [];
      for await (const ev of adapter.streamResponse({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
        credentials: { apiKey: "test-key" },
      })) {
        events.push(ev);
      }

      expect(events).toEqual([
        { type: "text_delta", text: "Hello" },
        { type: "text_delta", text: " world!" },
        { type: "usage", inputTokens: 12, outputTokens: 5, cachedInputTokens: 2 },
        { type: "completed", responseId: "resp_123", finishReason: "completed" },
      ]);
    });

    it("should handle response.incomplete event cleanly with finishReason incomplete", async () => {
      async function* mockIncompleteStream() {
        yield { type: "response.created", response: { id: "resp_inc_001" } };
        yield { type: "response.output_text.delta", delta: "Truncated ans" };
        yield {
          type: "response.incomplete",
          response: { id: "resp_inc_001", status: "incomplete" },
        };
      }

      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        responses: { create: vi.fn().mockResolvedValue(mockIncompleteStream()) },
      });

      const events: any[] = [];
      for await (const ev of adapter.streamResponse({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
        credentials: { apiKey: "test-key" },
      })) {
        events.push(ev);
      }

      expect(events).toEqual([
        { type: "text_delta", text: "Truncated ans" },
        { type: "completed", responseId: "resp_inc_001", finishReason: "incomplete" },
      ]);
    });

    it("should handle error event in Responses API", async () => {
      async function* mockErrorEventStream() {
        yield {
          type: "error",
          error: { message: "Internal OpenAI error" },
        };
      }

      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        responses: { create: vi.fn().mockResolvedValue(mockErrorEventStream()) },
      });

      const stream = adapter.streamResponse({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
        credentials: { apiKey: "test-key" },
      });

      await expect(async () => {
        for await (const _ of stream) {}
      }).rejects.toThrow("Internal OpenAI error");
    });

    it("should abort streaming when abortSignal is triggered", async () => {
      const abortController = new AbortController();
      async function* mockHangingStream() {
        yield { type: "response.output_text.delta", delta: "Start" };
        abortController.abort();
        yield { type: "response.output_text.delta", delta: " Should not arrive" };
      }

      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        responses: { create: vi.fn().mockResolvedValue(mockHangingStream()) },
      });

      const events: any[] = [];
      for await (const ev of adapter.streamResponse(
        {
          model: "gpt-4o",
          messages: [{ role: "user", content: "Hi" }],
          credentials: { apiKey: "test-key" },
        },
        abortController.signal
      )) {
        events.push(ev);
      }

      expect(events).toEqual([{ type: "text_delta", text: "Start" }]);
    });

    it("should throw ProviderError on OpenAI response.failed event", async () => {
      async function* mockFailedStream() {
        yield {
          type: "response.failed",
          response: { error: { message: "Context length exceeded" } },
        };
      }

      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        responses: { create: vi.fn().mockResolvedValue(mockFailedStream()) },
      });

      const stream = adapter.streamResponse({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
        credentials: { apiKey: "test-key" },
      });

      await expect(async () => {
        for await (const _ of stream) {}
      }).rejects.toThrow("Context length exceeded");
    });

    it("should stream tool call deltas and tool call events from Responses API", async () => {
      async function* mockResponsesToolStream() {
        yield {
          type: "response.output_item.added",
          item: {
            id: "item_1",
            type: "function_call",
            call_id: "call_abc123",
            name: "mcp__github__get_issue",
          },
        };
        yield {
          type: "response.function_call_arguments.delta",
          item_id: "item_1",
          delta: '{"issue_id":',
        };
        yield {
          type: "response.function_call_arguments.delta",
          item_id: "item_1",
          delta: ' 42}',
        };
        yield {
          type: "response.function_call_arguments.done",
          item_id: "item_1",
          arguments: '{"issue_id": 42}',
        };
        yield {
          type: "response.completed",
          response: {
            usage: { input_tokens: 15, output_tokens: 20 },
          },
        };
      }

      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        responses: { create: vi.fn().mockResolvedValue(mockResponsesToolStream()) },
      });

      const events: any[] = [];
      for await (const ev of adapter.streamResponse({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Check issue 42" }],
        tools: [
          {
            name: "mcp__github__get_issue",
            description: "Get issue details",
            parameters: { type: "object", properties: { issue_id: { type: "number" } } },
          },
        ],
        credentials: { apiKey: "test-key" },
      })) {
        events.push(ev);
      }

      expect(events).toContainEqual({
        type: "tool_call_delta",
        callId: "call_abc123",
        toolName: "mcp__github__get_issue",
        argumentsDelta: '{"issue_id":',
      });
      expect(events).toContainEqual({
        type: "tool_call_delta",
        callId: "call_abc123",
        toolName: "mcp__github__get_issue",
        argumentsDelta: " 42}",
      });
      expect(events).toContainEqual({
        type: "tool_call_done",
        callId: "call_abc123",
        toolName: "mcp__github__get_issue",
        arguments: { issue_id: 42 },
      });
      expect(events).toContainEqual({
        type: "tool_call",
        callId: "call_abc123",
        toolName: "mcp__github__get_issue",
        arguments: { issue_id: 42 },
      });
    });

    it("should stream tool calls from Chat Completions fallback", async () => {
      async function* mockCompletionsStream() {
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_cc_999",
                    function: {
                      name: "mcp__sqlite__query",
                      arguments: '{"sql":',
                    },
                  },
                ],
              },
            },
          ],
        };
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      arguments: ' "SELECT 1"}',
                    },
                  },
                ],
              },
            },
          ],
        };
        yield {
          choices: [
            {
              finish_reason: "tool_calls",
              delta: {},
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 15 },
        };
      }

      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        responses: null,
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue(mockCompletionsStream()),
          },
        },
      });

      const events: any[] = [];
      for await (const ev of adapter.streamResponse({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Query" }],
        tools: [
          {
            name: "mcp__sqlite__query",
            description: "Execute SQL",
            parameters: { type: "object" },
          },
        ],
        credentials: { apiKey: "test-key" },
      })) {
        events.push(ev);
      }

      expect(events).toContainEqual({
        type: "tool_call_delta",
        callId: "call_cc_999",
        toolName: "mcp__sqlite__query",
        argumentsDelta: '{"sql":',
      });
      expect(events).toContainEqual({
        type: "tool_call_done",
        callId: "call_cc_999",
        toolName: "mcp__sqlite__query",
        arguments: { sql: "SELECT 1" },
      });
    });

    it("should submit complete multi-turn history with function_call and function_call_output in Responses API mode", async () => {
      async function* mockAnswerStream() {
        yield { type: "response.created", response: { id: "resp_final_001" } };
        yield { type: "response.output_text.delta", delta: "Issue 42 is titled Bug in Auth." };
        yield {
          type: "response.completed",
          response: {
            id: "resp_final_001",
            status: "completed",
            usage: { input_tokens: 45, output_tokens: 10 },
          },
        };
      }

      const mockResponsesCreate = vi.fn().mockResolvedValue(mockAnswerStream());
      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        responses: { create: mockResponsesCreate },
      });

      const events: any[] = [];
      for await (const ev of adapter.streamResponse({
        model: "gpt-4o",
        protocolMode: "responses",
        messages: [
          { role: "user", content: "Check issue 42" },
          {
            role: "assistant",
            content: "Looking up issue 42...",
            toolCalls: [
              {
                providerCallId: "call_res_42",
                toolName: "mcp__github__get_issue",
                arguments: { issue_id: 42 },
              },
            ],
          },
          {
            role: "tool",
            toolCallId: "call_res_42",
            toolName: "mcp__github__get_issue",
            content: '{"title": "Bug in Auth", "state": "open"}',
          },
        ],
        credentials: { apiKey: "test-key" },
      })) {
        events.push(ev);
      }

      expect(mockResponsesCreate).toHaveBeenCalledTimes(1);
      const callArgs = mockResponsesCreate.mock.calls[0]![0];
      expect(callArgs.input).toEqual([
        { role: "user", content: "Check issue 42" },
        { role: "assistant", content: "Looking up issue 42..." },
        {
          type: "function_call",
          call_id: "call_res_42",
          name: "mcp__github__get_issue",
          arguments: '{"issue_id":42}',
        },
        {
          type: "function_call_output",
          call_id: "call_res_42",
          output: '{"title": "Bug in Auth", "state": "open"}',
        },
      ]);
      expect(events).toContainEqual({
        type: "text_delta",
        text: "Issue 42 is titled Bug in Auth.",
      });
    });

    it("should submit complete multi-turn history with tool_calls and role tool in Chat Completions mode", async () => {
      async function* mockAnswerStream() {
        yield {
          choices: [{ delta: { content: "SQL returned 1 row." } }],
        };
        yield {
          choices: [{ finish_reason: "stop", delta: {} }],
          usage: { prompt_tokens: 50, completion_tokens: 8 },
        };
      }

      const mockChatCreate = vi.fn().mockResolvedValue(mockAnswerStream());
      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        responses: null,
        chat: { completions: { create: mockChatCreate } },
      });

      const events: any[] = [];
      for await (const ev of adapter.streamResponse({
        model: "gpt-4o",
        protocolMode: "chat_completions",
        systemPrompt: "You are an assistant.",
        messages: [
          { role: "user", content: "Run SELECT 1" },
          {
            role: "assistant",
            content: null as any,
            toolCalls: [
              {
                providerCallId: "call_cc_sql_1",
                toolName: "mcp__db__query",
                arguments: { query: "SELECT 1" },
              },
            ],
          },
          {
            role: "tool",
            toolCallId: "call_cc_sql_1",
            toolName: "mcp__db__query",
            content: '[{"result": 1}]',
          },
        ],
        credentials: { apiKey: "test-key" },
      })) {
        events.push(ev);
      }

      expect(mockChatCreate).toHaveBeenCalledTimes(1);
      const callArgs = mockChatCreate.mock.calls[0]![0];
      expect(callArgs.messages).toEqual([
        { role: "system", content: "You are an assistant." },
        { role: "user", content: "Run SELECT 1" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_cc_sql_1",
              type: "function",
              function: {
                name: "mcp__db__query",
                arguments: '{"query":"SELECT 1"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_cc_sql_1",
          content: '[{"result": 1}]',
        },
      ]);
      expect(events).toContainEqual({
        type: "text_delta",
        text: "SQL returned 1 row.",
      });
    });
  });

  describe("3. Anthropic Adapter", () => {
    const adapter = new AnthropicAdapter();

    it("should validate credentials successfully using models.list endpoint", async () => {
      const mockList = vi.fn().mockResolvedValue({
        data: [
          { id: "claude-3-7-sonnet-20250219", display_name: "Claude 3.7 Sonnet" },
          { id: "claude-3-5-haiku-20241022", display_name: "Claude 3.5 Haiku" },
        ],
      });

      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        models: { list: mockList },
      });

      const result = await adapter.validateCredentials({ apiKey: "sk-ant-mock-key" });
      expect(result.valid).toBe(true);
      expect(result.modelsFound).toBe(2);
    });

    it("should throw InvalidCredentialsError on Anthropic 401", async () => {
      const mockList = vi.fn().mockRejectedValue(
        new AnthropicAuthError(401, { error: { message: "Invalid API key" } }, "Invalid API key", new Headers())
      );

      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        models: { list: mockList },
      });

      await expect(adapter.validateCredentials({ apiKey: "sk-ant-invalid" })).rejects.toThrow(
        InvalidCredentialsError
      );
    });

    it("should throw RateLimitError on Anthropic 429", async () => {
      const mockList = vi.fn().mockRejectedValue(
        new AnthropicRateError(429, { error: { message: "Rate limit reached" } }, "Rate limit reached", new Headers())
      );

      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        models: { list: mockList },
      });

      await expect(adapter.validateCredentials({ apiKey: "sk-ant-rate-limit" })).rejects.toThrow(
        RateLimitError
      );
    });

    it("should parse Anthropic models with 200k context windows and capabilities", async () => {
      const mockList = vi.fn().mockResolvedValue({
        data: [
          { id: "claude-3-7-sonnet-20250219", display_name: "Claude 3.7 Sonnet" },
          { id: "claude-3-5-haiku-20241022", display_name: "Claude 3.5 Haiku" },
        ],
      });

      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        models: { list: mockList },
      });

      const models = await adapter.listModels({ apiKey: "sk-ant-key" });
      expect(models.length).toBe(2);
      expect(models[0]!.contextWindow).toBe(200000);
      expect(models[0]!.capabilities.vision).toBe(true);
      expect(models[0]!.capabilities.toolCalling).toBe(true);
      expect(models[0]!.capabilities.reasoning).toBe(true);
    });

    it("should stream text deltas and filter out thinking deltas", async () => {
      async function* mockAnthropicStream() {
        yield { type: "message_start", message: { usage: { input_tokens: 25 } } };
        yield { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "internal thought" } };
        yield { type: "content_block_delta", delta: { type: "text_delta", text: "Verified response" } };
        yield { type: "message_delta", usage: { output_tokens: 15 }, delta: { stop_reason: "end_turn" } };
        yield { type: "message_stop" };
      }

      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        messages: { create: vi.fn().mockResolvedValue(mockAnthropicStream()) },
      });

      const events: any[] = [];
      for await (const ev of adapter.streamResponse({
        model: "claude-3-7-sonnet-20250219",
        messages: [{ role: "user", content: "Hello" }],
        credentials: { apiKey: "test-key" },
      })) {
        events.push(ev);
      }

      expect(events).toEqual([
        { type: "text_delta", text: "Verified response" },
        { type: "usage", inputTokens: 25, outputTokens: 15 },
        { type: "completed", finishReason: "end_turn" },
      ]);
    });

    it("should map Anthropic rate limit during streaming", async () => {
      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        messages: {
          create: vi.fn().mockRejectedValue(
            new AnthropicRateError(
              429,
              { error: { message: "Rate limit" } },
              "Rate limit",
              new Headers()
            )
          ),
        },
      });

      const stream = adapter.streamResponse({
        model: "claude-3-5-sonnet-20241022",
        messages: [{ role: "user", content: "Hello" }],
        credentials: { apiKey: "test-key" },
      });

      await expect(async () => {
        for await (const _ of stream) {}
      }).rejects.toThrow(RateLimitError);
    });

    it("should stream tool calls from Anthropic Messages API", async () => {
      async function* mockAnthropicToolStream() {
        yield { type: "message_start", message: { usage: { input_tokens: 30 } } };
        yield {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "toolu_01A",
            name: "mcp__github__search_repos",
          },
        };
        yield {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: '{"query": "messiah", "sort":',
          },
        };
        yield {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: ' "stars"}',
          },
        };
        yield {
          type: "content_block_stop",
          index: 0,
        };
        yield {
          type: "message_delta",
          usage: { output_tokens: 45 },
          delta: { stop_reason: "tool_use" },
        };
        yield { type: "message_stop" };
      }

      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        messages: { create: vi.fn().mockResolvedValue(mockAnthropicToolStream()) },
      });

      const events: any[] = [];
      for await (const ev of adapter.streamResponse({
        model: "claude-3-7-sonnet-20250219",
        messages: [{ role: "user", content: "Search for messiah repos" }],
        tools: [
          {
            name: "mcp__github__search_repos",
            description: "Search repos",
            parameters: { type: "object", properties: { query: { type: "string" } } },
          },
        ],
        credentials: { apiKey: "test-key" },
      })) {
        events.push(ev);
      }

      expect(events).toContainEqual({
        type: "tool_call_delta",
        callId: "toolu_01A",
        toolName: "mcp__github__search_repos",
        argumentsDelta: '{"query": "messiah", "sort":',
      });
      expect(events).toContainEqual({
        type: "tool_call_delta",
        callId: "toolu_01A",
        toolName: "mcp__github__search_repos",
        argumentsDelta: ' "stars"}',
      });
      expect(events).toContainEqual({
        type: "tool_call_done",
        callId: "toolu_01A",
        toolName: "mcp__github__search_repos",
        arguments: { query: "messiah", sort: "stars" },
      });
      expect(events).toContainEqual({
        type: "tool_call",
        callId: "toolu_01A",
        toolName: "mcp__github__search_repos",
        arguments: { query: "messiah", sort: "stars" },
      });
      expect(events).toContainEqual({
        type: "completed",
        finishReason: "tool_use",
      });
    });

    it("should merge consecutive tool_result blocks into a single user message in Anthropic Messages API", async () => {
      async function* mockAnswerStream() {
        yield { type: "message_start", message: { usage: { input_tokens: 30 } } };
        yield { type: "content_block_delta", delta: { type: "text_delta", text: "Found both repos." } };
        yield { type: "message_delta", usage: { output_tokens: 10 }, delta: { stop_reason: "end_turn" } };
        yield { type: "message_stop" };
      }

      const mockCreate = vi.fn().mockResolvedValue(mockAnswerStream());
      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        messages: { create: mockCreate },
      });

      const events: any[] = [];
      for await (const ev of adapter.streamResponse({
        model: "claude-3-7-sonnet-20250219",
        messages: [
          { role: "user", content: "Check repos" },
          {
            role: "assistant",
            content: "Searching...",
            toolCalls: [
              { providerCallId: "call_1", toolName: "search", arguments: { q: "messiah" } },
              { providerCallId: "call_2", toolName: "search", arguments: { q: "antigravity" } },
            ],
          },
          { role: "tool", toolCallId: "call_1", toolName: "search", content: '{"res": "repo 1"}' },
          { role: "tool", toolCallId: "call_2", toolName: "search", content: '{"res": "repo 2"}' },
        ],
        credentials: { apiKey: "test-key" },
      })) {
        events.push(ev);
      }

      expect(mockCreate).toHaveBeenCalledTimes(1);
      const callArgs = mockCreate.mock.calls[0]![0];
      // Roles must alternate: user, assistant, user
      expect(callArgs.messages.length).toBe(3);
      expect(callArgs.messages[0].role).toBe("user");
      expect(callArgs.messages[1].role).toBe("assistant");
      expect(callArgs.messages[2].role).toBe("user");
      // The 3rd message must have 2 tool_result blocks merged
      expect(callArgs.messages[2].content).toEqual([
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: '{"res": "repo 1"}',
        },
        {
          type: "tool_result",
          tool_use_id: "call_2",
          content: '{"res": "repo 2"}',
        },
      ]);
      expect(events).toContainEqual({ type: "text_delta", text: "Found both repos." });
    });
  });

  describe("4. Google Gemini Adapter", () => {
    const adapter = new GeminiAdapter();

    it("should validate credentials successfully using ai.models.list endpoint", async () => {
      const mockPager = [
        { name: "models/gemini-2.0-flash", displayName: "Gemini 2.0 Flash", inputTokenLimit: 1048576 },
        { name: "models/gemini-1.5-pro", displayName: "Gemini 1.5 Pro", inputTokenLimit: 2097152 },
      ];

      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        models: { list: vi.fn().mockResolvedValue(mockPager) },
      });

      const result = await adapter.validateCredentials({ apiKey: "mock-gemini-key" });
      expect(result.valid).toBe(true);
      expect(result.modelsFound).toBe(2);
    });

    it("should throw InvalidCredentialsError on Gemini ApiError 400/403 or bad api key", async () => {
      const err = new GeminiApiError({
        message: "API_KEY_INVALID: API key not valid",
        status: 400,
      });

      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        models: { list: vi.fn().mockRejectedValue(err) },
      });

      await expect(adapter.validateCredentials({ apiKey: "bad-gemini-key" })).rejects.toThrow(
        InvalidCredentialsError
      );
    });

    it("should throw RateLimitError on Gemini ApiError 429", async () => {
      const err = new GeminiApiError({
        message: "RESOURCE_EXHAUSTED: Rate limit exceeded",
        status: 429,
      });

      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        models: { list: vi.fn().mockRejectedValue(err) },
      });

      await expect(adapter.validateCredentials({ apiKey: "quota-gemini-key" })).rejects.toThrow(
        RateLimitError
      );
    });

    it("should throw ProviderUnavailableError on Gemini 503 outage", async () => {
      const err = new GeminiApiError({
        message: "UNAVAILABLE: Service is temporarily unavailable",
        status: 503,
      });

      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        models: { list: vi.fn().mockRejectedValue(err) },
      });

      await expect(adapter.validateCredentials({ apiKey: "outage-gemini-key" })).rejects.toThrow(
        ProviderUnavailableError
      );
    });

    it("should strip models/ prefix and tag 1M/2M token context windows", async () => {
      const mockPager = [
        { name: "models/gemini-2.0-flash", displayName: "Gemini 2.0 Flash", inputTokenLimit: 1048576, outputTokenLimit: 8192 },
        { name: "models/gemini-1.5-pro", displayName: "Gemini 1.5 Pro", inputTokenLimit: 2097152, outputTokenLimit: 8192 },
      ];

      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        models: { list: vi.fn().mockResolvedValue(mockPager) },
      });

      const models = await adapter.listModels({ apiKey: "gemini-key" });
      expect(models.length).toBe(2);
      expect(models[0]!.id).toBe("gemini-1.5-pro"); // sorted alphabetically
      expect(models[0]!.contextWindow).toBe(2097152);
      expect(models[1]!.id).toBe("gemini-2.0-flash");
      expect(models[1]!.contextWindow).toBe(1048576);
      expect(models[1]!.capabilities.vision).toBe(true);
      expect(models[1]!.capabilities.toolCalling).toBe(true);
    });

    it("should stream Gemini chunks and extract usage metadata", async () => {
      async function* mockGeminiStream() {
        yield { text: "Gemini chunk 1" };
        yield {
          text: " chunk 2",
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 8, cachedContentTokenCount: 0 },
        };
      }

      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        models: { generateContentStream: vi.fn().mockResolvedValue(mockGeminiStream()) },
      });

      const events: any[] = [];
      for await (const ev of adapter.streamResponse({
        model: "gemini-2.0-flash",
        messages: [{ role: "user", content: "Test" }],
        credentials: { apiKey: "test-key" },
      })) {
        events.push(ev);
      }

      expect(events).toEqual([
        { type: "text_delta", text: "Gemini chunk 1" },
        { type: "text_delta", text: " chunk 2" },
        { type: "usage", inputTokens: 10, outputTokens: 8, cachedInputTokens: 0 },
        { type: "completed", finishReason: "stop" },
      ]);
    });

    it("should handle Gemini ApiError during streaming", async () => {
      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        models: {
          generateContentStream: vi.fn().mockRejectedValue(
            new GeminiApiError({ message: "RESOURCE_EXHAUSTED", status: 429 })
          ),
        },
      });

      const stream = adapter.streamResponse({
        model: "gemini-2.0-flash",
        messages: [{ role: "user", content: "Test" }],
        credentials: { apiKey: "test-key" },
      });

      await expect(async () => {
        for await (const _ of stream) {}
      }).rejects.toThrow(RateLimitError);
    });

    it("should stream tool calls from Gemini candidate parts", async () => {
      async function* mockGeminiToolStream() {
        yield {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      id: "call_gemini_weather",
                      name: "mcp__weather__get_temp",
                      args: { city: "Tokyo" },
                    },
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 18, candidatesTokenCount: 12, cachedContentTokenCount: 0 },
        };
      }

      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        models: { generateContentStream: vi.fn().mockResolvedValue(mockGeminiToolStream()) },
      });

      const events: any[] = [];
      for await (const ev of adapter.streamResponse({
        model: "gemini-2.0-flash",
        messages: [{ role: "user", content: "What is the weather in Tokyo?" }],
        tools: [
          {
            name: "mcp__weather__get_temp",
            description: "Get current temperature",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        ],
        credentials: { apiKey: "test-key" },
      })) {
        events.push(ev);
      }

      expect(events).toContainEqual({
        type: "tool_call",
        callId: "call_gemini_weather",
        toolName: "mcp__weather__get_temp",
        arguments: { city: "Tokyo" },
      });
      expect(events).toContainEqual({
        type: "tool_call_done",
        callId: "call_gemini_weather",
        toolName: "mcp__weather__get_temp",
        arguments: { city: "Tokyo" },
      });
      expect(events).toContainEqual({
        type: "usage",
        inputTokens: 18,
        outputTokens: 12,
        cachedInputTokens: 0,
      });
      expect(events).toContainEqual({
        type: "completed",
        finishReason: "stop",
      });
    });

    it("should merge consecutive functionResponse parts into a single user turn in Google Gemini API", async () => {
      async function* mockAnswerStream() {
        yield {
          candidates: [
            {
              content: { parts: [{ text: "Tokyo is 18C and sunny." }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 35, candidatesTokenCount: 8, totalTokenCount: 43 },
        };
      }

      const mockGenerate = vi.fn().mockResolvedValue(mockAnswerStream());
      vi.spyOn(adapter as any, "createClient").mockReturnValue({
        models: { generateContentStream: mockGenerate },
      });

      const events: any[] = [];
      for await (const ev of adapter.streamResponse({
        model: "gemini-2.0-flash",
        messages: [
          { role: "user", content: "Weather in Tokyo?" },
          {
            role: "assistant",
            content: "Checking...",
            toolCalls: [
              { providerCallId: "call_t1", toolName: "get_temp", arguments: { city: "Tokyo" } },
              { providerCallId: "call_t2", toolName: "get_condition", arguments: { city: "Tokyo" } },
            ],
          },
          { role: "tool", toolCallId: "call_t1", toolName: "get_temp", content: '{"temp": 18}' },
          { role: "tool", toolCallId: "call_t2", toolName: "get_condition", content: '{"condition": "sunny"}' },
        ],
        credentials: { apiKey: "test-key" },
      })) {
        events.push(ev);
      }

      expect(mockGenerate).toHaveBeenCalledTimes(1);
      const callArgs = mockGenerate.mock.calls[0]![0];
      // Roles must alternate: user, model, user
      expect(callArgs.contents.length).toBe(3);
      expect(callArgs.contents[0].role).toBe("user");
      expect(callArgs.contents[1].role).toBe("model");
      expect(callArgs.contents[2].role).toBe("user");
      // The 3rd turn must have 2 functionResponse parts merged
      expect(callArgs.contents[2].parts.length).toBe(2);
      expect(callArgs.contents[2].parts[0]).toEqual({
        functionResponse: {
          id: "call_t1",
          name: "get_temp",
          response: { temp: 18 },
        },
      });
      expect(callArgs.contents[2].parts[1]).toEqual({
        functionResponse: {
          id: "call_t2",
          name: "get_condition",
          response: { condition: "sunny" },
        },
      });
      expect(events).toContainEqual({ type: "text_delta", text: "Tokyo is 18C and sunny." });
    });
  });
});
