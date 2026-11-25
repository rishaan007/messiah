# Messiah Bridge Task & Authorization Protocol

**Status**: Phase 4B Implemented & Verified  
**Protocol Version**: `2026-08-01`  
**Transport**: Outbound TLS 1.3 WebSocket (`/api/v1/devices/connect`)

---

## 1. Cryptographic Task Authorization Envelope (`device.task.dispatch`)

Workstations refuse unverified or unsigned instructions. Every task dispatched by Messiah Cloud carries a server signature (`TaskAuthorizationService`) bound to the exact operation parameters:

### Canonical Signing Payload:
```text
MESSIAH_TASK_AUTH:<taskId>:<requestId>:<deviceId>:<workspaceId>:<capability>:<sortedResourceScopes>:<argumentsHash>:<issuedAt>:<expiresAt>:<nonce>:<policyVersion>:<approvalReference>
```

- **`argumentsHash`**: SHA-256 digest of serialized parameters. Tampering with parameters invalidates verification immediately.
- **`nonce`**: 128/256-bit cryptographic random string tracked by `ReplayGuard` to prohibit replay attacks.
- **`expiresAt`**: Short TTL window after which stale frames are rejected locally.
- **`approvalReference`**: Optional ID binding resumed tasks to explicit `BridgeTaskApproval` database records.

---

## 2. WebSocket Lifecycle Frames

### Server -> Bridge:
- `device.task.dispatch`: Signed task authorization envelope.
- `device.task.cancel`: Terminates a running task and its child process tree.
- `device.mcp.sync`: Requests immediate discovery refresh of local stdio MCP servers.

### Bridge -> Server:
- `device.capabilities.reported`: Reports supported capabilities, allowed roots, and OS sandbox profile on connect.
- `device.mcp.discovered`: Reports local stdio MCP servers and tool schemas.
- `device.task.accepted`: Confirms signature/nonce verification passed.
- `device.task.started`: Marks task `RUNNING` with active sandbox profile metadata.
- `device.task.log`: Streams sequenced `stdout`, `stderr`, or `system` chunks.
- `device.approval.required`: Pauses execution (`AWAITING_APPROVAL`) and requests human review.
- `device.task.completed` / `device.task.failed` / `device.task.unknown_outcome`: Final state transitions with exit code, duration, and structured output.
