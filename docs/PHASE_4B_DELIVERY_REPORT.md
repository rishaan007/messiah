# MESSIAH — Phase 4B Final Security Acceptance & Remediation Report

**Date:** November 26, 2026  
**Milestone:** Phase 4B (Final Phase 4 Milestone)  
**Product:** MESSIAH — The Universal AI Agent Workspace  
**Tagline:** *One intelligence layer. Every agent. Every device.*

---

## 1. Executive Summary

Final security acceptance and remediation of **Phase 4B (Local Agent Execution, Workstation Sandboxing & Cross-Device Control)** has been completed without introducing any additional Phase 4 milestones. An adversarial audit of the initial Phase 4B codebase identified 10 concrete security weaknesses across process sandboxing, local stdio MCP execution, filesystem TOCTOU races, global fallback HMAC secrets, in-memory replay protection, non-transactional approval consumption, premature cancellation transitions, environment variable handling, and Base64URL pairing token case mangling.

All weaknesses have been remediated with fail-closed OS enforcement, per-device cryptographic keys, restart-persistent replay guards, `O_NOFOLLOW`/segment-verified file operations, and ACID transactional approvals. Full monorepo verification (`pnpm turbo run typecheck build test --concurrency=4`) passed **24/24 tasks** across all 10 packages with **274 automated tests passing** (100% pass rate), including real macOS ARM64 kernel Seatbelt isolation and native Keychain verification on Apple Silicon M1.

---

## 2. Security Audit Summary Table

| Security Requirement | Initial Implementation | Actual Enforcement Boundary | Remediation Implemented |
| :--- | :--- | :--- | :--- |
| **`process.run` Isolation** | `spawn` with `shell: false`, env delete list, `cwd` check | Application-level only | Real OS sandbox: macOS Seatbelt `(deny default)`, Linux Bubblewrap namespaces, Windows fail-closed `SANDBOX_UNAVAILABLE` |
| **Local MCP Isolation** | `LocalMcpProcess` spawned raw binary directly | Application-level `cwd` check | Mandatory OS sandbox execution (`spawnInteractive`), executable pinning, auto-install guard, `MCP_SCHEMA_CHANGED`, redacted untrusted output |
| **Filesystem TOCTOU** | `realpathSync` pre-check returning string path | Pre-open string validation | Segment `lstatSync`, sibling-prefix separator guard, `O_NOFOLLOW`/`O_EXCL`, hardlink/mount/UNC/ADS blocking, pre-commit inode/hash recheck |
| **Task HMAC Key** | Hardcoded global fallback secret | Shared global fallback | Unique AES-256-GCM encrypted 256-bit HMAC key per device + V2 canonical payload + `/rotate-key` |
| **Replay Protection** | In-memory `Set`/`Map` | Process lifetime only | Persistent `replay_guard.json` (`0600`) surviving restarts + single-use `approvalReference` tracking |
| **Approval Integrity** | `TaskExecutor` skipped gating; non-atomic DB update | Partial RBAC check only | Mandatory `requiresApproval` gating, immutable bindings, `updateMany` conditional consumption (`409 ALREADY_DECIDED`), OutboxEvent |
| **Cancellation Lifecycle** | `terminate()` killed all tasks; premature `CANCELLED` | Best-effort abort | Per-task PID tracking, `CANCEL_REQUESTED` -> confirmed `device.task.cancelled`, `UNKNOWN_OUTCOME` on disconnect |
| **Env & Log Redaction** | Partial `delete` blacklist; raw logs | Partial key filtering | From-scratch `EnvAllowlist` + `LogRedactor` scrubbing across bridge & server |
| **Keystores & Pairing** | `.toUpperCase()` on Base64URL token; PS inline string | Case corruption & fallback | Case-preserving Base64URL pairing, locked-vault refusal, PS env passing, fail-closed headless Linux passphrase |

---

## 3. Cross-Platform Verification Matrix

| Platform | Classification | Details |
| :--- | :--- | :--- |
| **macOS ARM64 (Apple Silicon M1)** | **Independently Platform-Verified** | Tested live on macOS 27.2.1 (`arm64`): Seatbelt `(deny default)` isolation, PathGuard TOCTOU defenses, sandboxed stdio MCP server, and native macOS Keychain round-trip. |
| **Linux x64 / ARM64** | **Implemented & Unit-Tested (Not Yet Host-Verified)** | Bubblewrap (`bwrap`) invocation, probe logic, and Secret Service / headless `PASSPHRASE_REQUIRED` fail-closed vault tested via Vitest; requires live Linux host run for OS verification. |
| **Windows x64 / ARM64** | **Implemented Fail-Closed / Custom DPAPI (Not Yet Host-Verified)** | Uses custom `.dpapi` file with `icacls` user ACLs (not `CredWriteW`); **sandboxed execution is Unsupported** unless a verified AppContainer helper (`MESSIAH_WIN_APPCONTAINER_HELPER`) is installed. |

---

## 4. Monorepo Verification Summary

- Command: `pnpm turbo run typecheck build test --concurrency=4`
- Result: **24/24 tasks passed** across 10 packages (`exit code 0`), **22/22 test files passed**, **274/274 automated tests passed** (`@messiah/server`: 138, `@messiah/mcp`: 43, `@messiah/bridge-daemon`: 40, `@messiah/providers`: 35, `@messiah/web`: 14, `@messiah/worker`: 4).
