# Messiah Local Agent Adapters

**Status**: Phase 4B Implemented & Verified  
**Capabilities**: `agent.start`, `agent.status`, `agent.cancel`

---

## 1. Scoped Workstation Subagents

Through `agent.start`, `agent.status`, and `agent.cancel`, Messiah supports orchestrating scoped subagent runtimes directly on the developer's workstation (e.g., running local test suites, refactoring multi-file codebases, or interacting with local linters).

### Adapter Boundaries:
- **Directory Scope Enforcement**: Every local agent session is bound to explicit `resourceScopes` validated by `PathGuard` before initialization.
- **Resource & Process Ceilings**: Bound to workspace `devicePolicy` limits (`maxExecutionTimeoutMs`, `maxMemoryBytes`, `maxProcesses`).
- **Real-Time Telemetry**: Subagent progress and output streams continuously back to Messiah Cloud via `device.task.log` and `device.task.progress` frames, enabling live visibility across iPhone, iPad, Windows, and web browsers.
- **Deterministic Cancellation**: `agent.cancel` immediately dispatches `device.task.cancel`, killing the process group cleanly via `ProcessSandbox`.
