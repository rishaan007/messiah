# Messiah Local Execution Engine

**Status**: Phase 4B Implemented & Verified  
**Component**: `apps/bridge-daemon` (`TaskExecutor`, `CapabilityRegistry`, `LocalDevicePolicy`)

---

## 1. Architecture Overview

The **Local Execution Engine** connects Messiah's cloud orchestration layer to authorized workstation capabilities through a strict capability-broker architecture. Every remote instruction delivered to a paired computer is authenticated, authorized against workspace and local policies, confined to approved project roots, and executed within a sandboxed runner.

```
[ Messiah Cloud / Chat ]
         │
         ▼
  TaskAuthorizationService (Signs MESSIAH_TASK_AUTH:... HMAC payload)
         │
         ▼ (Outbound WSS /api/v1/devices/connect)
  [ BridgeClient ] ──► [ TaskExecutor ]
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
  SignatureVerifier      ReplayGuard      LocalDevicePolicy
         │                    │                    │
         └────────────────────┼────────────────────┘
                              ▼
                     [ CapabilityRegistry ]
             ┌────────────────┼────────────────┐
             ▼                ▼                ▼
    SafeFileOperations   ProcessSandbox   LocalMcpRegistry
```

---

## 2. Registered Capabilities

The Capability Registry enforces explicit allow-listing across 13 structured workstation capabilities:

| Group | Capability ID | Description |
| :--- | :--- | :--- |
| **Filesystem** | `filesystem.list` | Lists directory contents within an approved project root. |
| **Filesystem** | `filesystem.read` | Reads file contents with configurable byte capping. |
| **Filesystem** | `filesystem.search` | Searches files by pattern or content inside allowed roots. |
| **Filesystem** | `filesystem.create` | Creates new files atomically using temp file replacement. |
| **Filesystem** | `filesystem.modify` | Modifies files atomically with optional expected SHA-256 hash check to detect drift. |
| **Filesystem** | `filesystem.delete` | Deletes files strictly within writable project roots. |
| **Local MCP** | `mcp.discover` | Discovers registered stdio MCP servers and tool schemas. |
| **Local MCP** | `mcp.invoke` | Executes a specific tool exposed by a local stdio MCP server. |
| **Process** | `process.run` | Runs an argument-array command in `ProcessSandbox` (no shell interpolation). |
| **Process** | `process.inspect` | Checks execution status and metrics of running local processes. |
| **Agent** | `agent.start` | Launches a scoped subagent session inside an approved project root. |
| **Agent** | `agent.status` | Polls active workstation agent status and stream progress. |
| **Agent** | `agent.cancel` | Terminates a running workstation agent and its process group. |

---

## 3. Execution Lifecycle & Replay Protection

1. **Envelope Verification**: `TaskSignatureVerifier` validates the server HMAC signature over the canonical string `MESSIAH_TASK_AUTH:taskId:requestId:deviceId:workspaceId:capability:sortedScopes:argumentsHash:issuedAt:expiresAt:nonce:policyVersion:approvalReference`.
2. **TTL & Nonce Enforcement**: `ReplayGuard` verifies the task has not expired and records the 256-bit `nonce` and `requestId` to prevent replay attacks or duplicate execution.
3. **Policy Evaluation**: `LocalDevicePolicy` (`~/.messiah/bridge/policy.json`) verifies the target capability is locally enabled and checks whether human approval (`device.approval.required`) is needed.
4. **Streaming & Termination**: Output streams (`stdout`, `stderr`, `system`) are forwarded back in sequenced `device.task.log` frames. Process completion yields `device.task.completed`, `device.task.failed`, or `device.task.unknown_outcome`.
