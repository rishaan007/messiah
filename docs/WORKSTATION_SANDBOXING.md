# Messiah Workstation Sandboxing & Process Isolation

**Status**: Phase 4B Security Hardened & Verified  
**Component**: `apps/bridge-daemon/src/sandbox/` (`ISandboxProvider`, `ProcessSandbox`, `SandboxDetector`, `EnvAllowlist`)

---

## 1. Fail-Closed OS Sandbox Architecture

Every `process.run` and local stdio MCP execution MUST execute inside a genuine OS-enforced sandbox boundary verified by `SandboxDetector.detect()`. If no supported kernel isolation primitive can be initialized on the host, execution **fails closed** with `SANDBOX_UNAVAILABLE`, logs the security reason to the audit stream, and refuses to fall back to unsandboxed user-level `spawn()`.

### Core Guarantees:
- **Zero Shell Interpolation**: Subprocesses are never invoked with `shell: true`. Only executable paths and strict argument arrays are passed.
- **Strict Environment Allowlist (`EnvAllowlist`)**: Environments are constructed cleanly from scratch containing only minimal runtime keys (`PATH`, `LANG`, `LC_ALL`, `TERM`, `NODE_ENV`) plus ephemeral isolated `HOME` and `TMPDIR` folders. Any key matching `TOKEN`, `SECRET`, `KEY`, `PASSWORD`, `PASSPHRASE`, `AUTH`, `CREDENTIAL`, `DATABASE_URL`, `REDIS_URL`, or `SUPABASE` is stripped unless explicitly authorized.
- **Per-Task Process Tree Tracking & Confirmed Termination**: `ProcessSandbox` tracks child processes by `taskId`. Cancellation kills the full process tree (`process.kill(-pid, "SIGKILL")` on POSIX / `taskkill /T /F /PID` on Windows) and awaits exit confirmation before marking the task `CANCELLED`.
- **Resource & Output Limits**: Enforces execution timeouts (`124`), memory RSS watchdog (`137`), and `1MB` stdout/stderr output byte caps with `LogRedactor` secret scrubbing.

---

## 2. OS Isolation Profiles by Platform

| Operating System | OS Enforcement Mechanism | Fail-Closed Behavior & Verification Status |
| :--- | :--- | :--- |
| **macOS ARM64** | `/usr/bin/sandbox-exec` Seatbelt profile starting from `(version 1)(deny default)(import "system.sb")`, `(allow process-info* (target self))`, `(allow signal (target self))`, read-only `/usr`/`/bin`/`/opt/homebrew`, explicit read-only vs read-write mount rules, sensitive regex denies, and default-denied `(deny network*)`. | **Independently Platform-Verified** on macOS 27.2.1 Apple Silicon M1 (`homeDir`, `.env`, outside keys, RO writes, PID 1 signals, child escapes, and TCP network all blocked by kernel `EPERM`). |
| **Linux x64/ARM64** | Bubblewrap (`bwrap`) with `--unshare-user --unshare-pid --unshare-ipc --unshare-uts --unshare-net` (unless `networkAllowed`), `--die-with-parent`, `--clearenv`, `--ro-bind` vs `--bind` mounts, and isolated `/proc`/`/dev`/`/tmp`. | **Implemented (Fail-Closed Verified)** — fails closed with `SANDBOX_UNAVAILABLE` if `bwrap` or unprivileged user namespaces are unavailable; requires live Linux x64 run for host platform verification. |
| **Windows x64** | Requires explicit AppContainer helper (`MESSIAH_WIN_APPCONTAINER_HELPER`) for kernel token, filesystem, registry, and network capability isolation; Windows Job Objects manage lifecycle only. | **Implemented Fail-Closed** — Windows Job Objects alone are **never** treated as a sandbox; refuses execution with `SANDBOX_UNAVAILABLE` unless verified AppContainer helper is present. |
