import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";
import {
  validateIpAddress,
  validateMcpEndpointUrl,
  isEvasiveNumericHost,
  SsrfSecurityError,
  type SsrfValidationOptions,
} from "./ssrf.js";

export interface SafeFetchOptions extends RequestInit {
  timeoutMs?: number;
  maxSizeBytes?: number;
  ssrfOptions?: SsrfValidationOptions;
  maxRedirects?: number;
}

/**
 * Creates a custom DNS lookup callback that validates every resolved IP
 * before returning it to the socket connection pool.
 * This guarantees socket-level interception against DNS rebinding attacks.
 */
export function createSafeLookup(ssrfOptions: SsrfValidationOptions = {}) {
  return function safeLookup(
    hostname: string,
    options: dns.LookupOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void
  ) {
    // 1. Detect evasive or malformed representations before DNS resolution
    if (isEvasiveNumericHost(hostname)) {
      const err = new SsrfSecurityError(`Evasive, malformed, or unusual IP representation is blocked: ${hostname}`);
      return callback(err as NodeJS.ErrnoException, "", 4);
    }

    // 2. Perform DNS resolution
    dns.lookup(hostname, { all: true }, (err, addresses) => {
      if (err) {
        return callback(err, "", 4);
      }

      if (!addresses || addresses.length === 0) {
        return callback(new Error(`DNS resolution returned empty for ${hostname}`), "", 4);
      }

      try {
        // 3. Socket-level IP validation against SSRF policy
        for (const record of addresses) {
          validateIpAddress(record.address, ssrfOptions);
        }
      } catch (validationErr) {
        return callback(validationErr as NodeJS.ErrnoException, "", 4);
      }

      // Return the validated address to caller
      if (options.all) {
        callback(null, addresses);
      } else {
        const first = addresses[0]!;
        callback(null, first.address, first.family);
      }
    });
  };
}

/**
 * Creates an Undici Agent dispatcher with socket-level DNS lookup validation.
 * In Node 18+ and Node 24, global fetch is backed by Undici; attaching this
 * dispatcher guarantees socket connection-time SSRF and DNS rebinding immunity.
 */
export function createSafeDispatcher(
  ssrfOptions: SsrfValidationOptions = {},
  timeoutMs = 15000
): UndiciAgent {
  const lookup = createSafeLookup(ssrfOptions);
  return new UndiciAgent({
    connect: {
      lookup,
      timeout: timeoutMs,
    },
  });
}

/**
 * Creates custom http and https Agents configured with safe lookup for legacy callers.
 */
export function createSafeAgents(ssrfOptions: SsrfValidationOptions = {}) {
  const lookup = createSafeLookup(ssrfOptions);

  const httpAgent = new http.Agent({
    lookup,
    keepAlive: false,
    timeout: 10000,
  });

  const httpsAgent = new https.Agent({
    lookup,
    keepAlive: false,
    timeout: 10000,
    rejectUnauthorized: process.env.NODE_ENV === "production",
  });

  const dispatcher = createSafeDispatcher(ssrfOptions);

  return { httpAgent, httpsAgent, dispatcher };
}

/**
 * Converts an Undici Response into a standard global Response instance,
 * properly handling null-body HTTP status codes (101, 204, 205, 304).
 */
function toGlobalResponse(r: {
  status: number;
  statusText: string;
  headers: any;
  body: any;
}): Response {
  const isNullBody = r.status === 101 || r.status === 204 || r.status === 205 || r.status === 304;
  return new Response(isNullBody ? null : r.body, {
    status: r.status,
    statusText: r.statusText,
    headers: r.headers,
  });
}

/**
 * High-security fetch wrapper designed for untrusted external MCP endpoints:
 * - Prevents DNS rebinding by validating IP at socket creation time via Undici dispatcher
 * - Enforces production egress-port policy (HTTPS only, Port 443 by default)
 * - Revalidates redirect URLs and strips credentials on origin changes
 * - Limits response payload size (default 10MB) to prevent memory exhaustion
 * - Enforces bounded execution timeouts
 */
export async function safeFetch(
  input: string | URL | Request,
  init: SafeFetchOptions = {}
): Promise<Response> {
  const {
    timeoutMs = 15000,
    maxSizeBytes = 10 * 1024 * 1024, // 10MB
    ssrfOptions = {},
    maxRedirects = 3,
    ...fetchInit
  } = init;

  let currentUrl: URL;
  if (typeof input === "string") {
    currentUrl = new URL(input);
  } else if (input instanceof URL) {
    currentUrl = input;
  } else {
    currentUrl = new URL(input.url);
  }

  // 1. Initial URL validation against SSRF & production egress port policy
  await validateMcpEndpointUrl(currentUrl.toString(), ssrfOptions);

  // 2. Prepare Undici dispatcher with socket-level DNS interception
  const dispatcher = createSafeDispatcher(ssrfOptions, timeoutMs);

  let redirectCount = 0;
  let targetUrl = currentUrl;
  const headers = new Headers(fetchInit.headers);
  const method = fetchInit.method || "GET";

  while (true) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    if (fetchInit.signal) {
      fetchInit.signal.addEventListener("abort", () => controller.abort());
    }

    try {
      // Execute request via Undici fetch with socket-level DNS verification
      const response = await undiciFetch(targetUrl.toString(), {
        ...fetchInit,
        headers,
        method,
        redirect: "manual",
        dispatcher,
        signal: controller.signal,
      } as any);

      clearTimeout(timeout);

      // 3. Inspect redirects (301, 302, 303, 307, 308)
      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.has("location")
      ) {
        redirectCount++;
        if (redirectCount > maxRedirects) {
          throw new SsrfSecurityError(`Maximum redirect limit of ${maxRedirects} exceeded.`);
        }

        const location = response.headers.get("location")!;
        const nextUrl = new URL(location, targetUrl);

        // Security: validate new redirect destination against SSRF & port policy
        await validateMcpEndpointUrl(nextUrl.toString(), ssrfOptions);

        // Security: strip sensitive authorization and cookie headers if origin changes
        if (nextUrl.origin !== targetUrl.origin) {
          headers.delete("authorization");
          headers.delete("proxy-authorization");
          headers.delete("cookie");
        }

        // On 303 See Other, change method to GET per HTTP specification
        if (response.status === 303) {
          (fetchInit as any).method = "GET";
          delete (fetchInit as any).body;
        }

        targetUrl = nextUrl;
        continue;
      }

      // 4. Response size validation
      const contentLength = response.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > maxSizeBytes) {
        throw new SsrfSecurityError(`Response size exceeds maximum allowed limit of ${maxSizeBytes} bytes.`);
      }

      return toGlobalResponse(response);
    } catch (err: any) {
      clearTimeout(timeout);

      if (err.name === "AbortError") {
        throw new Error(`Request to ${targetUrl.hostname} timed out after ${timeoutMs}ms.`);
      }

      // Unwrap nested socket lookup error from Undici
      const cause = err?.cause;
      if (cause instanceof SsrfSecurityError) {
        throw cause;
      }
      if (cause?.name === "SsrfSecurityError") {
        throw new SsrfSecurityError(cause.message, cause.code);
      }
      if (err instanceof SsrfSecurityError) {
        throw err;
      }

      throw err;
    }
  }
}
