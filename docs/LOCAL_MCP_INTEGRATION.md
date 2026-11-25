# Messiah Local MCP Integration (`stdio`)

**Status**: Phase 4B Implemented & Verified  
**Components**: `apps/bridge-daemon/src/mcp/`, `apps/server/src/services/devices/deviceManagementService.ts`

---

## 1. Overview

In addition to remote cloud Streamable HTTP / SSE MCP servers (Phase 3A), Messiah supports **Local Stdio MCP Servers** running directly on the user's workstation inside the Local Agent Bridge.

Examples include `@modelcontextprotocol/server-git`, `@modelcontextprotocol/server-filesystem`, local database inspection tools, or proprietary internal CLI tools.

---

## 2. Stdio Isolation Architecture

`LocalMcpProcess` isolates communication channels cleanly:
- **`stdin`**: Exlusively carries JSON-RPC 2.0 requests (`initialize`, `tools/list`, `tools/call`) serialized line-by-line.
- **`stdout`**: Parsed line-by-line strictly as JSON-RPC 2.0 responses matching pending request IDs.
- **`stderr`**: Captured as operational diagnostic log lines; never corrupted into JSON-RPC payloads.
- **Process Sandboxing**: Spawned via argument array (`shell: false`), inside an approved working directory, and with a scrubbed environment.

---

## 3. Discovery & Tool Synchronization

1. Administrators register a local MCP server in Messiah Cloud via `POST /api/v1/devices/:deviceId/mcp` or configure it locally in `LocalMcpRegistry`.
2. On WebSocket connect (or upon `device.mcp.sync`), the Bridge executes `tools/list` over stdio, calculates a deterministic SHA-256 `schemaHash`, and emits `device.mcp.discovered`.
3. `DeviceConnectionGateway` persists the server's status (`ACTIVE`, `DISABLED`, `CRASHED`), `schemaHash`, and tool schemas into `bridge_local_mcp_servers`.
4. Agents invoke tools via `mcp.invoke`, bound by workspace policy and schema verification.
