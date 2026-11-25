# Messiah Workstation Sandboxing & Process Isolation

**Status**: Phase 4B Implemented & Verified  
**Component**: `apps/bridge-daemon/src/sandbox/` (`ISandboxProvider`, `ProcessSandbox`, `SandboxDetector`)

---

## 1. Security Model

Workstation command execution never invokes arbitrary shell strings. Every process execution inside `apps/bridge-daemon` is governed by `ProcessSandbox` implementing `ISandboxProvider`.

### Core Guarantees:
- **Zero Shell Interpolation**: Subprocesses are spawned directly via `child_process.spawn(executable, args, { shell: false })`. Shell metacharacters (`;`, `&&`, `|`, `$()`) cannot escape the argument boundary.
- **Working Directory Containment**: Before spawn, the working directory (`cwd`) is verified through `PathGuard.resolveAndValidate` to confirm it resides inside an authorized project root.
- **Environment Scrubbing**: Host environment secrets (`AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `OPENAI_API_KEY`, `DATABASE_URL`, etc.) are stripped. Only safe minimal variables (`PATH`, `HOME`, `LANG`, `TERM`, `NODE_ENV`, plus explicitly allow-listed keys) are forwarded.
- **Execution Timeouts & Process Tree Kill**: Processes run with an enforced timeout (default 120s, max 600s). Timeout triggers `SIGKILL` across the entire process tree (on Unix via detached process group `-pid`; on Windows via `taskkill /T /F /PID`).
- **Output Byte Capping**: `stdout` and `stderr` buffers are capped (default 1 MB per task) to prevent memory exhaustion (`OOM`) from infinite-loop outputs. Truncation is flagged immediately in the returned execution metadata.

---

## 2. Platform Sandbox Profiles

`SandboxDetector` inspects available OS primitives at startup and reports profile readiness:

| Operating System | Primary Isolation Mechanism | Fallback Behavior |
| :--- | :--- | :--- |
| **macOS** (`darwin`) | `sandbox-exec` (Seatbelt dynamic profile) + argument arrays + scrubbed env | Native `ProcessSandbox` containment with PathGuard + scrubbed env |
| **Linux** (`linux`) | `bwrap` (Bubblewrap user namespaces & read-only/writable bind mounts) | Native `ProcessSandbox` containment with PathGuard + scrubbed env |
| **Windows** (`win32`) | Windows Job Objects process tree management + ACL isolation | Native `ProcessSandbox` containment with `taskkill /T /F` cleanup |
