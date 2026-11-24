export const MAX_RESULT_SIZE_BYTES = 512 * 1024; // 512 KB

const DANGEROUS_URI_PATTERNS = [
  /javascript:/gi,
  /data:text\/html/gi,
  /vbscript:/gi,
];

const SECRET_PATTERNS = [
  // Generic Bearer tokens
  /Bearer\s+[a-zA-Z0-9_\-\.]{16,}/gi,
  // OpenAI API keys
  /sk-[a-zA-Z0-9]{20,}/g,
  /sk-proj-[a-zA-Z0-9_\-]{20,}/g,
  // Anthropic API keys
  /sk-ant-[a-zA-Z0-9_\-]{20,}/g,
  // Google Gemini API keys
  /AIza[0-9A-Za-z\-_]{35}/g,
  // Private keys
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,
  // Generic password in JSON
  /"(password|secret|token|apiKey|api_key)"\s*:\s*"[^"]+"/gi,
];

export interface SanitizedToolResult {
  content: string;
  isTruncated: boolean;
  originalBytes: number;
  sanitizedBytes: number;
}

/**
 * Strips dangerous protocol schemes from text or URLs.
 */
export function stripDangerousProtocols(text: string): string {
  let cleaned = text;
  for (const pattern of DANGEROUS_URI_PATTERNS) {
    cleaned = cleaned.replace(pattern, "blocked-scheme:");
  }
  return cleaned;
}

/**
 * Redacts detected API keys, credentials, and private keys from tool output.
 */
export function redactSecrets(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      if (match.toLowerCase().startsWith("bearer ")) {
        return "Bearer [REDACTED_TOKEN]";
      }
      if (match.startsWith('"')) {
        const key = match.split(":")[0];
        return `${key}: "[REDACTED_CREDENTIAL]"`;
      }
      return "[REDACTED_CREDENTIAL]";
    });
  }
  return redacted;
}

/**
 * Escapes raw HTML tags to prevent cross-site scripting or prompt injection payload execution.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export class ToolResultSanitizer {
  /**
   * Sanitizes, redacts, and bounds tool execution results before saving
   * and before providing back to the LLM agent turn.
   */
  public sanitize(rawResult: unknown): SanitizedToolResult {
    let textRepresentation: string;

    if (rawResult === null || rawResult === undefined) {
      textRepresentation = "";
    } else if (typeof rawResult === "string") {
      textRepresentation = rawResult;
    } else if (typeof rawResult === "object") {
      try {
        textRepresentation = JSON.stringify(rawResult, null, 2);
      } catch {
        textRepresentation = String(rawResult);
      }
    } else {
      textRepresentation = String(rawResult);
    }

    const originalBytes = Buffer.byteLength(textRepresentation, "utf8");

    // 1. Redact secrets
    let sanitized = redactSecrets(textRepresentation);

    // 2. Strip dangerous URI schemes
    sanitized = stripDangerousProtocols(sanitized);

    // 3. Enforce maximum result size limit (512 KB)
    let isTruncated = false;
    let byteLen = Buffer.byteLength(sanitized, "utf8");

    if (byteLen > MAX_RESULT_SIZE_BYTES) {
      isTruncated = true;
      const buf = Buffer.from(sanitized, "utf8");
      // Truncate to just under 512KB and append warning notice
      const truncationNotice = "\n\n... [Output truncated at 512KB execution limit]";
      const noticeBytes = Buffer.byteLength(truncationNotice, "utf8");
      const safeSlice = buf.subarray(0, MAX_RESULT_SIZE_BYTES - noticeBytes).toString("utf8");
      sanitized = safeSlice + truncationNotice;
      byteLen = Buffer.byteLength(sanitized, "utf8");
    }

    return {
      content: sanitized,
      isTruncated,
      originalBytes,
      sanitizedBytes: byteLen,
    };
  }

  /**
   * Helper to format sanitized output safely for tool response message payload.
   */
  public formatForProvider(sanitized: SanitizedToolResult): string {
    return sanitized.content;
  }
}

export const toolResultSanitizer = new ToolResultSanitizer();
