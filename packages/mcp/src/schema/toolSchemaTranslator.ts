export interface ParsedToolAlias {
  connectionSlug: string;
  connectionIdSuffix?: string;
  toolName: string;
}

export interface ProviderCompatibleTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const MAX_TOOL_NAME_LENGTH = 64;

/**
 * Sanitizes a string to contain only letters, numbers, and underscores [a-zA-Z0-9_].
 */
export function sanitizeIdentifier(str: string): string {
  return str.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Generates a collision-resistant, provider-compatible alias for an MCP tool.
 * Format: mcp__<sanitizedConnectionSlug>[_<connectionIdSuffix>]__<sanitizedToolName>
 * E.g., mcp__github_a81f23__create_issue
 * Enforces maximum length of 64 characters across all LLM providers (OpenAI, Anthropic, Gemini).
 */
export function generateToolAlias(
  connectionSlug: string,
  toolName: string,
  connectionId?: string
): string {
  const cleanSlug = sanitizeIdentifier(connectionSlug) || "conn";
  const cleanTool = sanitizeIdentifier(toolName) || "tool";
  const idSuffix = connectionId
    ? `_${connectionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 6).toLowerCase()}`
    : "";
  const scopedSlug = `${cleanSlug}${idSuffix}`;

  const prefix = `mcp__${scopedSlug}__`;
  const candidate = `${prefix}${cleanTool}`;

  if (candidate.length <= MAX_TOOL_NAME_LENGTH) {
    return candidate;
  }

  // If candidate exceeds 64 characters, preserve prefix and truncate tool name
  const remainingSpace = MAX_TOOL_NAME_LENGTH - prefix.length;
  if (remainingSpace >= 8) {
    return `${prefix}${cleanTool.slice(0, remainingSpace)}`;
  }

  // If even prefix is very long, truncate slug base while preserving id suffix and prefix
  const maxSlugBaseLen = Math.max(4, 24 - idSuffix.length);
  const truncatedSlug = `${cleanSlug.slice(0, maxSlugBaseLen)}${idSuffix}`;
  const truncatedPrefix = `mcp__${truncatedSlug}__`;
  const availableForTool = MAX_TOOL_NAME_LENGTH - truncatedPrefix.length;
  return `${truncatedPrefix}${cleanTool.slice(0, Math.max(8, availableForTool))}`;
}

/**
 * Parses a tool alias to recover the connection slug, optional connection ID suffix, and original tool name.
 */
export function parseToolAlias(alias: string): ParsedToolAlias | null {
  if (!alias || !alias.startsWith("mcp__")) {
    return null;
  }

  const parts = alias.slice(5).split("__");
  if (parts.length < 2) {
    return null;
  }

  const rawSlug = parts[0]!;
  const toolName = parts.slice(1).join("__");

  if (!rawSlug || !toolName) {
    return null;
  }

  // Check if rawSlug ends with _<6-character hex suffix>
  const match = rawSlug.match(/^(.*)_([0-9a-f]{6})$/i);
  if (match && match[1] && match[2]) {
    return {
      connectionSlug: match[1],
      connectionIdSuffix: match[2].toLowerCase(),
      toolName,
    };
  }

  return { connectionSlug: rawSlug, toolName };
}

/**
 * Sanitizes and normalizes an MCP input JSON Schema into an OpenAPI/JSON Schema object
 * compliant with OpenAI, Anthropic, and Google Gemini function parameter requirements.
 */
export function sanitizeSchemaForProviders(
  inputSchema: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  if (!inputSchema || typeof inputSchema !== "object") {
    return {
      type: "object",
      properties: {},
    };
  }

  const cloned = JSON.parse(JSON.stringify(inputSchema)) as Record<string, unknown>;

  // Ensure top-level type is 'object'
  if (cloned.type !== "object") {
    cloned.type = "object";
  }

  if (!cloned.properties || typeof cloned.properties !== "object") {
    cloned.properties = {};
  }

  // Strip JSON Schema metadata keywords that cause provider rejections
  delete cloned.$schema;
  delete cloned.$id;
  delete cloned.title;
  delete cloned.id;

  return cloned;
}

/**
 * Translates an MCP tool into a provider-compatible tool definition.
 */
export function translateToProviderTool(
  alias: string,
  description: string | undefined,
  inputSchema: Record<string, unknown>
): ProviderCompatibleTool {
  return {
    name: alias,
    description: description ? description.slice(0, 1024) : "MCP Tool execution function",
    parameters: sanitizeSchemaForProviders(inputSchema),
  };
}
