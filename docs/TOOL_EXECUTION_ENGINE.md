# MESSIAH — MCP Tool Execution Engine

## 1. Executive Summary

The **MESSIAH Tool Execution Engine** bridges universal AI models (OpenAI, Anthropic, Google Gemini) and discovered remote Model Context Protocol (MCP) servers. In Messiah, AI models are strictly treat-as-untrusted generators of invocation intents: **models never execute tools directly**. 

Instead, Messiah acts as an authorized gateway:
1. Translates discovered MCP tool schemas into provider-native tool definitions.
2. Intercepts and parses model tool-call intents using deterministic safe aliases.
3. Performs strict server-side Ajv JSON Schema validation and permission policy enforcement.
4. Executes approved tools via the official MCP TypeScript SDK v2 (`@modelcontextprotocol/client`) over SSRF-protected transports with DNS pinning and socket-level timeouts.
5. Redacts secrets, strips dangerous URI protocols, enforces size caps (512KB), and formats results into provider-native message frames for continuation of the multi-turn agent loop.

---

## 2. Safe Tool Aliasing & Namespace Isolation

Provider APIs impose strict format constraints on tool and function names:
- OpenAI: `^[a-zA-Z0-9_-]{1,64}$`
- Anthropic: `^[a-zA-Z0-9_-]{1,64}$`
- Google Gemini: `^[a-zA-Z0-9_]{1,64}$`

To ensure cross-provider compatibility and prevent tool-name collisions across multiple connected servers, Messiah establishes a canonical namespacing convention:

$$\text{Provider Tool Alias} = \texttt{mcp\_\_} + \text{ConnectionSlug} + \texttt{\_\_} + \text{ToolName}$$

### Invariants:
1. **Total Length Limit**: Guaranteed $\le 64$ characters. If the slug or tool name exceeds available budget, deterministic truncation occurs while preserving a 6-character cryptographic suffix.
2. **Safe Character Set**: Strictly alphanumeric characters and underscores (`[a-zA-Z0-9_]`). All hyphens or invalid symbols are converted to underscores.
3. **Deterministic Round-Trip**: The backend can unambiguously parse `mcp__<connectionSlug>__<toolName>` back into the underlying connection identifier and tool definition record.

```typescript
// Example:
// Connection Slug: "github_prod"
// Tool Name: "create_pull_request"
// Resulting Alias: "mcp__github_prod__create_pull_request"
```

---

## 3. Schema Translation & Provider Normalization

Discovered MCP tool definitions specify JSON Schema definitions (Draft-07, 2019-09, or 2020-12). However, frontier model APIs reject certain JSON Schema keywords (e.g., remote `$ref`, `$schema`, `default` in certain contexts, or unbounded `additionalProperties`).

`ToolSchemaTranslator` sanitizes input schemas before advertising them to providers:
1. **Schema Stripping**: Recursively removes `$schema`, `$id`, `$ref`, and unresolvable pointer annotations.
2. **Fallback Defaults**: Ensures `type: "object"` and an explicit `properties` map are defined.
3. **Provider Adaptation**:
   - **OpenAI**: Formatted as `{ type: "function", function: { name, description, parameters, strict: false } }`.
   - **Anthropic**: Formatted as `{ name, description, input_schema }`.
   - **Google Gemini**: Formatted as `FunctionDeclaration` with `Schema` types converted to uppercase `OBJECT`, `STRING`, `INTEGER`, etc.

---

## 4. Execution Lifecycle & Budget Enforcement

```mermaid
sequenceDiagram
    autonumber
    participant Model as AI Model (OpenAI/Anthropic/Gemini)
    participant Worker as BullMQ Worker (@messiah/worker)
    participant Auth as ToolAuthorizationService
    participant Reg as ToolExecutionRegistry
    participant SDK as MCP TypeScript Client (SDK v2)
    participant Remote as Remote MCP Server

    Model->>Worker: Stream tool_call request (mcp__slug__tool, args)
    Worker->>Reg: Resolve alias & tool definition in workspace
    Worker->>Worker: Ajv JSON Schema validation (max 64KB, max 10 depth)
    Worker->>Auth: Evaluate Workspace & Tool Permission Mode
    alt Requires Approval
        Worker->>Worker: Persist ToolCall (AWAITING_APPROVAL) & ToolApproval (PENDING)
        Worker-->>Model: Pause Run; Worker finishes cleanly (no block)
    else Permitted (READ_ONLY or EXPLICITLY_AUTHORIZED)
        Worker->>SDK: Call tool via McpClientFactory (safeFetch, 30s timeout)
        SDK->>Remote: POST /mcp (SSRF protected)
        Remote-->>SDK: MCP CallToolResult (content)
        SDK-->>Worker: Tool execution result
        Worker->>Worker: ToolResultSanitizer (redact secrets, cap 512KB)
        Worker->>Worker: Persist ToolCall (SUCCEEDED) & Message (role: TOOL)
        Worker->>Model: Resubmit thread messages with tool result
    end
```

### Execution Budgets:
- **Per-Tool Timeout**: Strict 30,000ms socket-level and `AbortController` timeout.
- **Maximum Arguments Size**: 65,536 bytes (64KB). Payloads exceeding this are rejected pre-execution.
- **Maximum Output Size**: 524,288 bytes (512KB). Payloads exceeding this are truncated with clear metadata.
- **Maximum Multi-Turn Rounds**: 6 iterations per generation run.
- **Maximum Cumulative Tool Invocations**: 10 tool calls per run.
- **Run Wall-Clock Deadline**: 10 minutes (600 seconds) maximum lifecycle.

---

## 5. Result Sanitization & Prompt-Injection Mitigation

All tool execution results originate from external untrusted environments and are treated as **untrusted data**.

1. **Secret Redaction**:
   - Regular expression scanning matches Bearer tokens, OpenAI keys (`sk-...`), Anthropic keys (`sk-ant-...`), Google AI keys (`AIzaSy...`), AWS access keys (`AKIA...`), and PEM private key blocks (`-----BEGIN ... PRIVATE KEY-----`).
   - Matched substrings are replaced with `[REDACTED_SECRET]`.
2. **Dangerous URI Protocol Stripping**:
   - Strips `javascript:`, `vbscript:`, and `data:text/html` protocols from tool output to prevent XSS.
3. **Context Isolation**:
   - Tool execution results are **never** placed into system prompts or developer instructions.
   - They are persisted exclusively as messages with `role: "TOOL"`, clearly segmented from system instructions.

---

## 6. Execution Outcome Classification & Indeterminate States (UNKNOWN_OUTCOME)

To protect against duplicate external side effects during transport blips, MESSIAH classifies execution outcomes into three distinct states:

| Outcome State | Transport / Response Pattern | Database Status | Automated Retry Policy |
| :--- | :--- | :--- | :--- |
| **SUCCESS** | HTTP 200, valid MCP JSON-RPC result | `SUCCESS` | Completed |
| **FAILED** | Tool application error (`isError: true`), HTTP 400/404/422 | `FAILED` | Model may adjust parameters |
| **UNKNOWN_OUTCOME** | Connection severed (`ECONNRESET`, `UND_ERR_SOCKET`), gateway timeout (`ETIMEDOUT`, 504), client abort | `UNKNOWN_OUTCOME` | **Strictly Prohibited** |

When an operation is marked `UNKNOWN_OUTCOME`, the execution engine:
1. Emits a `tool.unknown_outcome` WebSocket stream event.
2. Injects an ambiguity warning back to the model: *"The external server may have processed or begun processing the request. Operation outcome is unknown. Do not automatically re-execute."*
3. Alerts the user to verify external system state before re-running mutating operations.
