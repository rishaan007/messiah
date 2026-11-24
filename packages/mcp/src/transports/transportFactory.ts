import {
  StreamableHTTPClientTransport,
  SSEClientTransport,
  type Transport,
  type AuthProvider,
} from "@modelcontextprotocol/client";
import { safeFetch, type SafeFetchOptions } from "../security/safeFetch.js";
import { validateMcpEndpointUrl, type SsrfValidationOptions } from "../security/ssrf.js";
import type { McpTransportType } from "../types/index.js";

export interface TransportFactoryOptions {
  transportType?: McpTransportType;
  bearerToken?: string;
  ssrfOptions?: SsrfValidationOptions;
  timeoutMs?: number;
}

export class McpTransportFactory {
  /**
   * Creates an MCP transport with SSRF protection, socket-level DNS rebinding mitigation,
   * safe redirect policy, and authentication binding.
   */
  public static async createTransport(
    endpointUrl: string,
    options: TransportFactoryOptions = {}
  ): Promise<Transport> {
    const {
      transportType = "STREAMABLE_HTTP",
      bearerToken,
      ssrfOptions = {},
      timeoutMs = 15000,
    } = options;

    // 1. Enforce strict outbound SSRF validation before establishing transport
    const { url } = await validateMcpEndpointUrl(endpointUrl, ssrfOptions);

    // 2. Build custom fetch with SSRF and redirect controls
    const customFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const safeInit: SafeFetchOptions = {
        ...init,
        timeoutMs,
        ssrfOptions,
      };
      return safeFetch(input, safeInit);
    };

    // 3. Configure AuthProvider if bearer token is supplied
    let authProvider: AuthProvider | undefined;
    if (bearerToken) {
      authProvider = {
        token: async () => bearerToken,
      };
    }

    // 4. Instantiate official MCP SDK transport
    if (transportType === "SSE") {
      // Legacy SSE fallback transport
      return new SSEClientTransport(url, {
        fetch: customFetch as any,
        authProvider,
      });
    }

    // Modern Streamable HTTP transport (2026-07-28 era default) with same-origin redirect policy
    return new StreamableHTTPClientTransport(url, {
      fetch: customFetch as any,
      authProvider,
      redirectPolicy: "same-origin",
    });
  }
}
