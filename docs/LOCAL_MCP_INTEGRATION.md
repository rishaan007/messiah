# Messiah Local MCP Integration (`stdio`)

**Status**: Phase 4B Security Hardened & Verified  
**Components**: `apps/bridge-daemon/src/mcp/` (`LocalMcpRegistry`, `LocalMcpProcess`), `apps/server/src/services/devices/deviceManagementService.ts`

---

## 1. Untrusted Code Isolation Model

Local stdio MCP servers are treated as potentially untrusted executable code:
- **Mandatory OS Sandboxing**: `LocalMcpProcess.start()` spawns strictly via `ISandboxProvider.spawnInteractive` (Seatbelt on macOS, Bubblewrap on Linux, fail-closed `SANDBOX_UNAVAILABLE` on platforms without verified OS isolation). It never runs unsandboxed `spawn()`.
- **Filesystem & Network Isolation**: Mounts are read-only by default unless `writableMounts` are explicitly configured; outbound network access is denied by default (`networkPolicy: false`).
- **Strict Environment Allowlist**: Uses `EnvAllowlist`, stripping provider API keys, database URLs, Bridge credentials, and vault passphrases.

---

## 2. Executable Pinning, Explicit Registration & Schema Drift Detection

1. **No Autonomous Package Installation**: Commands invoking `npx -y`, `npm install`, `pnpm add`, `yarn add`, or `pip install` require explicit `userConfirmed` registration (`USER_CONFIRMATION_REQUIRED`) and can never be triggered autonomously by model output.
2. **Executable & Config Pinning**: `LocalMcpRegistry` pins `pinnedExecutablePath`, `pinnedExecutableSha256`, `packageName`, `packageVersion`, and `approvedArgsHash`. If the binary path or SHA-256 changes on disk (`MCP_EXECUTABLE_DRIFT` / `MCP_EXECUTABLE_HASH_MISMATCH`), startup aborts immediately.
3. **Tool Schema Pinning & Drift Detection**: `listTools()` computes deterministic SHA-256 `schemaHash`. Both `BridgeLocalMcpServer` and `LocalMcpProcess.callTool()` detect tool-schema drift (`MCP_SCHEMA_CHANGED` / `MCP_SCHEMA_DRIFT`) and require renewed human authorization before execution.
4. **Stdio Separation & Untrusted Output**: `stdout` carries strictly JSON-RPC 2.0 lines; `stderr` carries `LogRedactor`-scrubbed diagnostics. Tool outputs are wrapped with `{ untrustedToolOutput: true }` and redacted of secret patterns.
