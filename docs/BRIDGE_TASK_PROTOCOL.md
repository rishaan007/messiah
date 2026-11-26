# Messiah Bridge Task Authorization & Lifecycle Protocol

**Status**: Phase 4B Security Hardened & Verified  
**Protocol Version**: `2026-08-01`  
**Transport**: Outbound TLS 1.3 WebSocket (`/api/v1/devices/connect`)

---

## 1. Per-Device Symmetric HMAC-SHA256 Authorization

Every paired `BridgeDevice` receives its own unique cryptographically random **256-bit symmetric HMAC-SHA256 key** (`taskSigningKey`).
- **Key Lifecycle**:
  - Provisioned on first authenticated WebSocket handshake (`TaskAuthorizationService.provisionOrGetDeviceSigningKey`), stored encrypted at rest in `bridge_devices.task_signing_key_encrypted` via AES-256-GCM bound with AAD (`messiah:device_hmac:<workspaceId>:<deviceId>:<keyVersion>`).
  - Delivered to the Bridge over its Ed25519-authenticated TLS WebSocket session in `device.auth.success`.
  - Rotated explicitly by workspace `OWNER` or `ADMIN` via `POST /api/v1/devices/:deviceId/rotate-key`, incrementing `taskKeyVersion` and terminating active sessions so old keys are invalidated immediately.
  - There is **no global shared secret fallback**. HMAC-SHA256 is a symmetric Message Authentication Code (not an asymmetric signature).

### Versioned Canonical Payload (`V2`):
```text
MESSIAH_TASK_AUTH:V2:<serverAudience>:<protocolVersion>:<taskId>:<requestId>:<deviceId>:<workspaceId>:<capability>:<sortedResourceScopes>:<argumentsHash>:<issuedAt>:<expiresAt>:<nonce>:<policyVersion>:<approvalReference>:<mcpServerName>:<mcpSchemaHash>:<executableIdentity>
```

---

## 2. Persistent Replay Guard & Immutable Approvals

- **Restart-Persistent Nonces (`ReplayGuard`)**: Seen nonces, consumed `approvalReference` IDs, and task lifecycle states persist atomically on disk (`replay_guard.json`, `0600` permissions) so captured unexpired tasks cannot be replayed after a Bridge restart.
- **Single-Use Atomic Approvals**: `DeviceTaskService.handleApprovalDecision` executes inside an ACID PostgreSQL transaction verifying role (`OWNER`/`ADMIN`), `argumentsHash`, `deviceId`, `workspaceId`, `capability`, MCP `schemaHash`, and expiration, atomically locking via `updateMany({ where: { status: "PENDING" } })` (`409 ALREADY_DECIDED` on concurrent races) and writing a transactional `OutboxEvent`.
- **Reliable Cancellation & Indeterminate Outcomes**: Cancellation transitions to `CANCEL_REQUESTED` until the Bridge kills the process tree and sends `device.task.cancelled`. Mid-execution disconnections transition active tasks to `UNKNOWN_OUTCOME` without automatic retry.
