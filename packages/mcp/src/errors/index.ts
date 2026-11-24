export class McpError extends Error {
  constructor(message: string, public readonly code: string = "MCP_ERROR", public readonly statusCode: number = 500) {
    super(message);
    this.name = "McpError";
  }
}

export class McpConnectionError extends McpError {
  constructor(message: string, code = "MCP_CONNECTION_FAILED", statusCode = 502) {
    super(message, code, statusCode);
    this.name = "McpConnectionError";
  }
}

export class McpDiscoveryError extends McpError {
  constructor(message: string, code = "MCP_DISCOVERY_FAILED", statusCode = 502) {
    super(message, code, statusCode);
    this.name = "McpDiscoveryError";
  }
}

export class McpAuthError extends McpError {
  constructor(message: string, code = "MCP_AUTH_FAILED", statusCode = 401) {
    super(message, code, statusCode);
    this.name = "McpAuthError";
  }
}

export class McpPermissionError extends McpError {
  constructor(message: string, code = "MCP_PERMISSION_DENIED", statusCode = 403) {
    super(message, code, statusCode);
    this.name = "McpPermissionError";
  }
}

export class McpUnsupportedProtocolError extends McpError {
  constructor(message: string, code = "MCP_UNSUPPORTED_PROTOCOL", statusCode = 400) {
    super(message, code, statusCode);
    this.name = "McpUnsupportedProtocolError";
  }
}
