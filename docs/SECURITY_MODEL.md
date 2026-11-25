# MESSIAH — SECURITY ARCHITECTURE & ZERO-TRUST MODEL

> **Document Stage**: Phase 0 — Architecture & Discovery  
> **Version**: 1.0.0  
> **Security Baseline**: Zero-Trust Architecture, Defense-in-Depth, OWASP Top 10 for LLMs

---

## 1. Threat Modeling & Security Principles

Messiah orchestrates code execution, filesystem manipulation, and API access across distributed developer machines and cloud models. Because autonomous agents can encounter malicious inputs (e.g., indirect prompt injection from fetched repositories or websites), the system operates on a **Zero-Trust Model**: _Never trust an incoming prompt, never grant persistent unconstrained execution privileges, and never expose raw terminal access to the cloud._

### 1.1 STRIDE Threat Analysis & Mitigations

| Threat Category            | Potential Attack Vector                                                                  | Messiah Mitigation Architecture                                                                                                                   |
| :------------------------- | :--------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Spoofing**               | Rogue machine impersonating an enrolled Local Agent Bridge.                              | Mutual cryptographic authentication using **Ed25519 keypairs** and ephemeral pairing tokens. Public key bound to workspace in database.           |
| **Tampering**              | Man-in-the-middle tampering of tool arguments or commands in transit.                    | Mandatory **TLS 1.3** for all transport; signed execution approval nonces verified by the local bridge daemon.                                    |
| **Repudiation**            | User or agent disavowing destructive local file edits or terminal commands.              | Tamper-evident, append-only **Audit Logs** recording initiating user, device fingerprint, raw command, and execution hash.                        |
| **Information Disclosure** | Leaking cloud LLM API keys or local source code files to unauthorized users or frontend. | **AES-256-GCM envelope encryption** for credentials; zero-exposure policy (keys never reach client browser); strict local directory whitelisting. |
| **Denial of Service**      | Infinite recursive agent loops exhausting provider API budgets or CPU.                   | Hard recursion depth limits, step timeouts, cooperative cancellation tokens, and Redis-backed token bucket rate limiters.                         |
| **Elevation of Privilege** | Agent executing arbitrary system binaries (`rm -rf /`, `curl                             | bash`, root escalation).                                                                                                                          | Strict **Human-in-the-Loop (HITL)** approval gating for Level 2 commands; hardcoded blacklist blocking root paths, sudo, and network pipelining. |

---

## 2. Authentication & Session Architecture

### 2.1 Identity Provider & Token Lifecycle (Phase 1B Implementation)

Messiah delegates authentication to **Supabase Auth** while keeping the internal application database completely authoritative:

- **Identity Mapping**: Users are mapped via immutable unique pairs `(external_provider, external_id)`. Messiah never stores or processes raw passwords or password hashes.
- **Next.js 16 Proxy Session Guard**: `apps/web/proxy.ts` intercepts incoming requests and invokes `supabase.auth.getUser()`. Never relies on unverified `getSession()` data, preventing token forging or replay attacks.
- **Server-Side JWT Verification (`jose`)**: Fastify's `fastify.authenticate` pre-handler cryptographically verifies incoming `Authorization: Bearer <token>` headers using `jose.jwtVerify`. Supports symmetric HS256 secret (`SUPABASE_JWT_SECRET`) or asymmetric JWKS remote key sets (`SUPABASE_JWKS_URL`).
- **Cryptographic Enforcement**:
  - Rejects missing or malformed `Authorization` headers with `401 Unauthorized` (`MISSING_TOKEN` / `MALFORMED_AUTH_HEADER`).
  - Rejects expired tokens with `401 Unauthorized` (`EXPIRED_TOKEN`).
  - Rejects signatures signed by rogue keys or tampered payloads with `401 Unauthorized` (`INVALID_TOKEN`).
- **Rate-Limiting**: `@fastify/rate-limit` enforces 100 requests per minute per IP on authenticated routes.

### 2.2 Server-Side Authorization & Tenancy Isolation (Anti-IDOR)

Every incoming HTTP and WebSocket request passes through Fastify pre-handler authorization guards:

1. **Token Verification**: Validates JWT cryptographic signature and checks expiration via `fastify.authenticate`.
2. **Transactional User Resolution**: `userService.findOrCreateUserFromAuth` runs inside an ACID PostgreSQL transaction on first auth, ensuring idempotent user creation and default personal workspace provisioning.
3. **IDOR Defense**: All workspace access (`GET /api/v1/workspaces/:workspaceId`) strictly enforces membership verification (`workspaceService.getWorkspaceById`). If the user does not belong to the requested workspace, the API returns a generic **`404 Not Found`** (`WORKSPACE_NOT_FOUND`) rather than `403 Forbidden`, preventing attackers from enumerating private workspace IDs.
4. **Role-Based Access Control (RBAC)**:
   - **`OWNER`**: Full billing, workspace deletion, credential management, member management.
   - **`ADMIN`**: Configure AI providers, register MCP servers, pair workspace devices, invite members.
   - **`MEMBER`**: Create threads, dispatch agents, approve tool calls on their enrolled devices.
   - **`VIEWER`**: Read-only access to conversation history and task execution traces.

---

## 3. Cryptographic Key Management & Secrets Isolation

### 3.1 Envelope Encryption Architecture

Provider API keys (OpenAI, Anthropic, Gemini) and remote MCP auth tokens are protected using **Envelope Encryption** with **AES-256-GCM**:

```
+--------------------------------------------------------------------------+
|                       MASTER KEY ENCRYPTION (KEK)                        |
|              (Managed via AWS KMS / HashiCorp Vault / Cloud Secret)      |
+------------------------------------+-------------------------------------+
                                     |
                                     | (Unwraps on startup)
                                     v
+------------------------------------+-------------------------------------+
|                     WORKSPACE DATA ENCRYPTION KEY (DEK)                  |
|                (Unique 256-bit symmetric key per workspace)              |
+------------------------------------+-------------------------------------+
                                     |
                                     | (Encrypts/Decrypts in memory)
                                     v
+------------------------------------+-------------------------------------+
|                      ENCRYPTED CREDENTIAL PAYLOAD                        |
|      Ciphertext (Base64) + 96-bit IV (Nonce) + 128-bit Auth Tag (GCM)    |
+--------------------------------------------------------------------------+
```

### 3.2 Security Guarantees & Phase 2A Vault Implementation:

- **Zero Plaintext Storage & Exposure**: Plaintext API keys and tokens are **never** stored unencrypted on disk or in database records, and **never** returned in API responses or UI representations. The frontend only receives connection metadata and masked fingerprints (e.g., `sk-ant...98aF`).
- **AES-256-GCM Authenticated Encryption**: Ciphertexts include 12-byte cryptographically random IVs and 16-byte GCM authentication tags. Tampering or truncation results in immediate decryption failure with zero secret leakage.
- **KMS Abstraction & Key Versioning**: The `EncryptedCredential` table tracks `key_version` (`v1`), managed via `IKmsService` and `LocalKmsService`. Supports background key rotation without service interruption. For in-depth cryptographic implementation, see [CREDENTIAL_VAULT.md](file:///Users/rishaankumar/Desktop/messiah/docs/CREDENTIAL_VAULT.md).
- **Audit Scrubbing**: Every credential lifecycle action triggers `AuditService.logAuditEvent()`, which strictly redacts secret tokens matching `/key|secret|token|password|auth|credential/i`.
- **Transient Memory Decryption**: Plaintext credentials only exist in transient memory during active API calls and are never retained globally.
- **RBAC & Anti-IDOR Enforcement**: Only workspace `OWNER` or `ADMIN` roles can create, update, test, or delete provider credentials (`MEMBER` and `VIEWER` receive 403 Forbidden). Cross-tenant queries return 404 Not Found to prevent workspace enumeration.

---

## 4. Device Pairing & Mutual Authentication Protocol

Local Agent Bridges connect personal workstations to the cloud without opening incoming firewall ports. To prevent unauthorized device attachment, Messiah implements a four-step cryptographic handshake:

```mermaid
sequenceDiagram
    autonumber
    actor Dev as Developer
    participant UI as Messiah Web / Mobile Console
    participant API as Messiah Cloud Gateway
    participant Daemon as Local Bridge Daemon (Machine)
    participant Keychain as Native OS Keychain

    Dev->>UI: Clicks "Enroll New Device"
    UI->>API: POST /api/devices/pairing-token
    API->>API: Generate crypto-random 8-digit OTP & 256-bit Token Hash
    API-->>UI: Display Token & CLI Command: `messiah-bridge pair <token>`

    Dev->>Daemon: Runs `messiah-bridge pair <token>`
    Daemon->>Daemon: Generate Ed25519 Public/Private Keypair
    Daemon->>API: POST /api/devices/pair (OTP, Ed25519 Public Key, Machine Fingerprint)

    API->>API: Verify Token Hash, check 5-min TTL, ensure not already used
    API->>API: Store Device Record (Status: PAIRED, Public Key: Ed25519)
    API->>API: Mark Pairing Token as CONSUMED
    API-->>Daemon: Return Device ID & Workspace Certificate

    Daemon->>Keychain: Store Ed25519 Private Key in OS Keychain (macOS Keychain / WinCred / libsecret)
    Daemon->>API: WSS Handshake with Challenge-Response Signature
    API-->>Daemon: Connection Verified -> State: ONLINE
```

### 4.1 Security Properties of Pairing:

- **Ephemeral Pairing Tokens**: Single-use tokens expire strictly after 300 seconds (5 minutes).
- **Key Generation & Storage**: The private key is generated locally on the workstation and never leaves the machine. It is stored securely in standard OS credential storage (macOS Keychain, Windows Credential Manager, or Linux Secret Service via DBus). (Note: OS credential stores vary across host configurations and are not automatically assumed to be hardware-backed TPMs/SEs).
- **Revocation**: A workspace administrator or user can revoke any device instantly from the Messiah dashboard, immediately dropping active WebSocket tunnels and rejecting further challenge signatures.

---

## 5. Tool Permissions, Capability Matrix & HITL Approvals

Messiah rejects the unsafe paradigm of allowing autonomous AI models unrestricted shell access. Security relies on **defense-in-depth**: explicit capabilities, process sandboxing, least privilege, and mandatory human-in-the-loop approvals. A command blacklist alone is strictly recognized as insufficient security against sophisticated command injection or obfuscation.

```
+-----------------------------------------------------------------------------------+
|                        MESSIAH CAPABILITY SAFETY TIERS                            |
+-----------------------------------------------------------------------------------+
| LEVEL 0: READ-ONLY SAFE      | Automatic execution.                               |
|                              | Examples: git status, git log, file read, npm ls   |
+------------------------------+----------------------------------------------------+
| LEVEL 1: SANDBOXED MUTATION  | Configurable: Auto inside whitelisted workspace.   |
|                              | Examples: file write, git checkout, npm install    |
+------------------------------+----------------------------------------------------+
| LEVEL 2: INTERACTIVE HITL    | Mandatory Human-in-the-Loop Approval.              |
|                              | Examples: bash execute, test runner, git push      |
+------------------------------+----------------------------------------------------+
| LEVEL 3: STRICTLY PROHIBITED | Hardcoded system block. Never executable.          |
|                              | Examples: sudo, rm -rf /, curl | bash, dd, mkfs    |
+-----------------------------------------------------------------------------------+
```

### 5.1 Cryptographic Approval Ticket Workflow

When an agent proposes a Level 2 action:

1. **Ticket Creation**: The backend creates an approval ticket containing:
   - Tool Name: `bash_execute`
   - Command: `npm test:coverage`
   - Working Directory: `/Users/developer/projects/messiah`
   - Execution Nonce: 256-bit cryptographically secure random value
   - Expiration: 10 minutes
2. **Out-of-Band Notification**: An interactive modal is pushed to all active user sessions (Web, Mobile App).
3. **User Inspection**: The user inspects the raw command, environment variables, and proposed directory.
4. **Digital Signature**: When the user clicks **Approve**, the backend signs the approval ticket with an internal HMAC-SHA256 signature and relays it to the Local Agent Bridge over the WebSocket channel.
5. **Bridge Verification**: The local bridge verifies the HMAC signature and matches the execution nonce before spawning the subprocess.

---

## 6. Local Bridge Execution Sandboxing & Jail Isolation

```mermaid
flowchart TD
    subgraph CloudRequest ["Cloud Execution Payload"]
        Payload["Command: 'pnpm test'\nTarget Path: './tests/auth.test.ts'"]
    end

    subgraph BridgeDaemon ["Local Agent Bridge Sandbox"]
        Check1{"1. Canonical Path Check\nDoes realpath fall inside\nAllowed Roots?"}
        Check2{"2. Command Blacklist Check\nDoes command match\nprohibited patterns?"}
        Check3{"3. Approval Nonce Valid\n& Cryptographically Signed?"}

        Spawn["Spawn Subprocess with\nClean Environment Variables\n& Dropped Privileges"]
        Reject["Reject with Security Error\n& Log Tamper Attempt"]
    end

    Payload --> Check1
    Check1 -- Yes --> Check2
    Check1 -- No --> Reject
    Check2 -- Yes --> Check3
    Check2 -- No --> Reject
    Check3 -- Yes --> Spawn
    Check3 -- No --> Reject
```

### 6.1 Canonical Path Jail

The Bridge daemon enforces directory containment using standard POSIX canonical path resolution:

```typescript
import fs from "node:fs";
import path from "node:path";

export function assertPathWithinSandbox(
  targetPath: string,
  allowedRoots: string[],
): string {
  // Resolve symbolic links and relative '../' traversals
  const realTargetPath = fs.realpathSync(path.resolve(targetPath));

  const isContained = allowedRoots.some((root) => {
    const realRoot = fs.realpathSync(path.resolve(root));
    return (
      realTargetPath.startsWith(realRoot + path.sep) ||
      realTargetPath === realRoot
    );
  });

  if (!isContained) {
    throw new SecurityException(
      `Access Denied: Path '${targetPath}' resolves outside allowed sandbox roots.`,
    );
  }

  return realTargetPath;
}
```

### 6.2 Prohibited Commands & Blacklist Engine

The bridge daemon inspects the raw tokenized command line. Any match against the blacklist triggers an immediate abort and security alert:

- **Root Escalation**: `sudo`, `su`, `doas`, `pkexec`.
- **System Destruction**: `rm -rf /`, `rm -rf /*`, `mkfs`, `dd if=`.
- **Arbitrary Remote Code Execution**: `curl ... | bash`, `wget ... | sh`, `python -c "import urllib..."`.
- **Sensitive System Locations**: `/etc`, `/var/root`, `C:\Windows\System32`, `~/.ssh`, `~/.gnupg`, `~/.aws`.

---

## 7. AI Safety & Prompt Injection Defenses

Because agents consume external text (documentation, GitHub issues, pull requests, webpage contents), they are vulnerable to **Indirect Prompt Injection**:

1. **Delimiter Sandboxing**: External content is strictly wrapped in unambiguous XML-style delimiters with structural typing:
   ```xml
   <user_instruction>
     Refactor the login component.
   </user_instruction>
   <untrusted_external_content source="github_pr_diff">
     <!-- Untrusted content is treated strictly as passive data -->
   </untrusted_external_content>
   ```
2. **System Prompt Hardening**: System prompts explicitly instruct the agent that instructions embedded inside `<untrusted_external_content>` tags have zero authority and must not alter system behavior or initiate unauthorized tool executions.
3. **Structured Tool Call Validation**: Tool calls are strictly parsed against **Zod** schemas. Arguments with unexpected keys or irregular data types are rejected prior to reaching the bridge.

---

## 8. Network Security, Rate Limiting & Audit Logging

### 8.1 Network & Transport Protection

- **TLS 1.3 Minimum**: Weak ciphers (TLS 1.0, 1.1, 1.2 with CBC) are rejected at the edge proxy.
- **Content Security Policy (CSP)**: Strict headers preventing cross-site scripting (`default-src 'self'`, `connect-src 'self' wss: https:`).

### 8.2 Token Bucket Rate Limiting (Redis-Backed)

To prevent accidental loops or malicious resource exhaustion:

- **Per User / IP**: 120 HTTP requests / minute.
- **Per Workspace LLM Inferences**: 60 completions / minute (burst 100).
- **Per Device WebSocket Frames**: 300 frames / minute.

### 8.3 Tamper-Evident Audit Logging

Every security-sensitive event writes an immutable record to the `audit_logs` table:

- **Identity**: User ID, Workspace ID, Device ID, Client IP, User Agent.
- **Context**: Action (`credential.decrypt`, `device.pair`, `tool.approve`, `tool.execute`, `chat.message_sent`).
- **Integrity**: SHA-256 hash of the command payload and result.

---

## 9. Realtime WebSocket & Vault v2 Cryptographic Security (Phase 2B)

### 9.1 Two-Stage Ticket WebSocket Authentication
- Long-lived Supabase JWTs are strictly excluded from WebSocket URLs and query parameters.
- Clients must first exchange their JWT via authenticated `POST /api/v1/realtime/ticket` for a 32-byte cryptographic random ticket (30s TTL).
- Plaintext tickets are never stored in cache or logs; only the SHA-256 hash is retained.
- The ticket is consumed atomically via `GETDEL` upon the WebSocket `auth` frame.
- Unauthenticated sockets are terminated after a strict 10-second timeout guard (code 4408).

### 9.2 Origin Header Validation & CSWSH Defense
- Fastify WebSocket upgrades validate incoming `Origin` headers before socket registration:
  - **Development / Test**: Permits configured `CORS_ORIGIN`, `localhost`, and `127.0.0.1` origins.
  - **Production (`NODE_ENV === "production"`)**: Strictly requires an explicit match against `MESSIAH_ALLOWED_ORIGINS`. Localhost and 127.0.0.1 are **never** auto-trusted in production.
  - Sockets with missing or untrusted `Origin` headers are immediately disconnected with RFC-compliant closure code `4403` (`Forbidden Origin`).

### 9.3 Additional Authenticated Data (AAD) Vault Hardening
- Vault `v2` enforces Additional Authenticated Data (AAD) binding on AES-256-GCM ciphertexts:
  `AAD = "workspaceId:<wsId>|providerConnectionId:<connId>|provider:<provider>|keyVersion:v2"`
- Attempting to transplant ciphertext across workspaces or connection IDs results in an immediate GCM authentication tag mismatch (`Tag mismatch: ciphertext has been tampered with`).
- Transparent fallback supports legacy `v1` credentials without downtime.

---

## 10. Execution Reliability, Concurrency Isolation & Content Security (Phase 2B.1)

### 10.1 Database-Level Concurrency Isolation
- **PostgreSQL Partial Unique Index**: `idx_generation_runs_single_active_per_thread` on `generation_runs("thread_id") WHERE status IN ('PENDING', 'STREAMING')`.
- Eliminates application-layer race conditions (TOCTOU). Concurrent execution requests for the same thread raise database constraint violation `P2002` and map to HTTP 409 `CONCURRENT_RUN_ACTIVE`.

### 10.2 Cryptographic Request Fingerprinting & Idempotency
- Requests compute a canonical SHA-256 hash over `{prompt, provider, model, systemPrompt, temperature, maxTokens}`.
- Dedicated `IdempotencyKey` model with composite unique constraint on `(threadId, key)`.
- Key replay with identical payload returns the existing run/messages (HTTP 200).
- Key reuse with altered payload is rejected with HTTP 422 `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`, preventing parameter injection or cache-poisoning attacks.

### 10.3 Financial Exhaustion & Rate-Limit Protection
- BullMQ chat generation jobs are strictly configured with `attempts: 1` (zero automatic retries on external LLM calls).
- Prevents runaway token billing, quota depletion, and provider rate-limiting spirals on downstream API failures.

### 10.4 Cross-Worker Distributed Cancellation
- Cancellation requests update PostgreSQL `cancellationRequestedAt` and publish an abort signal to Redis Pub/Sub channel `messiah:cancel:<runId>`.
- Any worker fleet instance actively executing the run receives the message and triggers its local `AbortController`.
- Terminal states (`COMPLETED`, `FAILED`, `CANCELLED`, `INTERRUPTED`) are immutable and reject subsequent cancellation attempts.

### 10.5 Frontend Markdown XSS & Reverse Tabnabbing Mitigation
- **Protocol Allowlist (`isSafeUrl`)**: Disallows execution vectors like `javascript:`, `data:`, `vbscript:`, and `file:`. Only `https:`, `http:`, `mailto:`, and relative paths are allowed. Dangerous URIs are rendered as inert text.
- **HTML Entity Escaping (`sanitizeRawHtml`)**: All raw `<`, `>`, `"`, and `'` characters outside code blocks are escaped to prevent DOM-based XSS attacks.
- **Reverse Tabnabbing Defense**: External links are automatically decorated with `target="_blank" rel="noopener noreferrer"`.

---

## 11. Model Context Protocol (MCP) Security & Governance (Phase 3A)

### 11.1 SSRF & Private Network Perimeter Defenses
- Remote MCP server endpoints undergo multi-layered validation via `validateMcpEndpointUrl`:
  - **HTTPS Enforcement**: In production (`NODE_ENV === "production"`), plaintext `http://` is strictly rejected.
  - **Restricted Port Blocking**: Ports commonly associated with database services, SSH, mail, or internal infrastructure (e.g. 21, 22, 23, 25, 53, 137, 139, 445, 3306, 5432, 6379) are blocked.
  - **IP Range Sanitization**: Private IPv4 (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16), loopback (127.0.0.0/8), link-local, carrier-grade NAT (100.64.0.0/10), AWS/GCP cloud metadata (`169.254.169.254`, `fd00:ec2::254`), and IPv6 ULA (`fc00::/7`) are strictly prohibited.

### 11.2 Socket-Level DNS Rebinding Prevention
- Traditional HTTP clients validate DNS records once before connecting. Attackers exploit Time-of-Check to Time-of-Use (TOCTOU) windows using short TTLs to rebind domain names to internal IP addresses.
- Messiah's `safeFetch` and `createSafeLookup` override Node.js socket-level DNS lookups, resolving addresses and re-validating them immediately before opening the network socket.
- Redirects are handled manually (`redirect: "manual"`), re-validating destination URLs at every hop and automatically stripping `Authorization` headers when host origins change.

### 11.3 AES-256-GCM v2 AAD Credential Vault for MCP
- MCP Bearer tokens and OAuth tokens are stored in `mcp_credentials` encrypted with AES-256-GCM v2.
- Additional Authenticated Data binds credentials cryptographically:
  `messiah:vault:v2:${workspaceId}:${connectionId}:mcp`
- Plaintext secrets are never returned in public API payloads and are automatically redacted by the audit logging engine.

### 11.4 Deny-by-Default Governance & Tool Execution Freeze
- All newly discovered tools default to `REQUIRE_APPROVAL` in `mcp_tool_permissions`.
- Tool annotations (e.g., `readOnly: true`) are informational metadata only and never grant automated authorization.
- Model-triggered execution is universally frozen in Phase 3A: any invocation attempt raises `McpPermissionError: MCP_EXECUTION_DISABLED_PHASE_3A`. Tool execution is scheduled for Phase 3B.

---

## 12. MCP Tool Execution & Agent Safety Governance (Phase 3B)

### 12.1 Gateway Authority: Models Never Execute Tools Directly
- AI models (OpenAI, Anthropic, Gemini) are strictly treated as untrusted text/call intent generators.
- Models never execute tools or access networking primitives directly.
- The Messiah backend intercepts tool calls, validates JSON schemas, evaluates permission policies, prompts human users when required, and executes via the official MCP TypeScript SDK v2 over `safeFetch`.

### 12.2 Defense Against Adversarial Schemas & DoS
- **Ajv Validation**: Schemas are compiled with `allErrors: true` and `coerceTypes: false`.
- **Payload Limits**: Argument payloads are capped at 64KB (65,536 bytes). Nesting depth is capped at 10 levels.
- **Remote Reference Rejection**: Any attempt to load external `$ref` URIs is rejected pre-execution.

### 12.3 Cryptographically Bound Single-Use Approvals & Concurrency Locks
- **Dual SHA-256 Binding**: Approvals bind the exact SHA-256 hash of canonicalized JSON arguments (`argumentsHash`) and tool schema (`schemaHash`), along with `toolCallId`, `generationRunId`, `threadId`, `connectionId`, and `toolName`. Any argument or schema drift aborts execution.
- **Strict Workspace RBAC**: Only workspace `OWNER` or `ADMIN` roles can approve or deny actions. Both `MEMBER` and `VIEWER` roles are rejected with `403 FORBIDDEN_ROLE`.
- **Atomic Concurrency Row Lock**: Concurrent approval attempts across multiple tabs or devices are locked via conditional `updateMany({ where: { id: approvalId, status: "PENDING" }, data: ... })`. Exactly one request succeeds; subsequent or concurrent requests are atomically rejected with HTTP 400 `ALREADY_DECIDED`.
- **Durable Resumption via Outbox**: Approval transactions atomically create an `OutboxEvent` with `eventType: "generation.resume"`, guaranteeing at-least-once BullMQ resumption even during Redis outages.
- **Dynamic 5-minute TTL**: Unapproved requests expire automatically after 300 seconds, transitioning to `EXPIRED`.

### 12.4 Execution Outcome Taxonomy & Indeterminate Failures (UNKNOWN_OUTCOME)
- **Application Failures vs. Transport Severance**: Application errors (HTTP 200 with JSON-RPC error, HTTP 400/404/422) transition to `FAILED` and return sanitized messages to the model.
- **Indeterminate Outcomes**: Socket disconnects (`ECONNRESET`, `UND_ERR_SOCKET`, socket destruction mid-stream) and gateway timeouts (`ETIMEDOUT`, HTTP 504) transition to `UNKNOWN_OUTCOME`.
- **No-Retry Invariant**: Mutating operations with `UNKNOWN_OUTCOME` are strictly barred from automated re-execution to prevent duplicate side effects (e.g. double charging, duplicate record creation). The model and user are notified of the ambiguous state.

### 12.5 Untrusted Output Sanitization & Prompt-Injection Mitigation
- Tool results are bounded to 512KB (524,288 bytes).
- Sensitive credentials (Bearer tokens, API keys for OpenAI/Anthropic/Gemini, AWS keys, private keys) are automatically stripped and replaced with `[REDACTED_SECRET]`.
- Dangerous protocols (`javascript:`, `data:text/html`, `vbscript:`) are stripped from outputs.
- Tool outputs are strictly passed as `TOOL` role messages and **never** injected into system/developer instructions.

### 12.6 Approval UI Defense-in-Depth
- Sensitive arguments matching credentials/tokens are masked with `••••••••••••` by default in `ToolApprovalCard`, with an explicit user reveal toggle.
- Prominent External Data Disclosure warning highlights the external MCP host and AI model provider receiving the parameters.
- Complex JSON payloads require explicit reviewer acknowledgment before the Approve action activates.

---

## 13. Local Agent Bridge Security & Device Identity (Phase 4A)

### 13.1 Zero Inbound Ports
- The Messiah Local Agent Bridge daemon binds zero TCP or UDP listener sockets.
- All communications are strictly outbound TLS/WSS (`wss://`) initiated from the user's computer to Messiah Cloud.
- Corporate firewalls, NAT routers, and VPNs are traversed seamlessly without port forwarding or UPnP punch-throughs.

### 13.2 Asymmetric Ed25519 Device Cryptography
- Every bridge instance generates an Ed25519 keypair locally on first launch.
- Private keys are stored in native OS credential stores (macOS Keychain, Windows DPAPI with user ACLs, Linux Secret Service failing closed headless without passphrase) or in the AES-256-GCM encrypted vault (`~/.messiah/bridge/device.vault`) with POSIX `0600` permissions, 32-byte salt, and **600,000 iterations PBKDF2-HMAC-SHA512**.
- Private keys are **never transmitted** over the network, written to logs, or exposed to the web application.
- Public keys are stored in the cloud database as SubjectPublicKeyInfo (SPKI) PEM along with an immutable SHA-256 binary DER fingerprint (`SHA256:<64-hex>`).

### 13.3 Ephemeral Cryptographic Challenge-Response Protocol
- WebSockets at `/api/v1/devices/connect` enforce immediate challenge-response authentication.
- Server issues a 256-bit cryptographic nonce, 30s TTL, audience tag, and protocol version.
- Bridge signs canonical ASCII string `MESSIAH_DEVICE_AUTH:<deviceId>:<challengeId>:<nonce>:<serverAudience>:<protocolVersion>:<expiresAt>`.
- Any signature mismatch, expired challenge, paused device, or revoked device results in immediate socket termination (`4401`, `4403`, `4410`).

### 13.4 256-Bit Pairing Secrets with Hashed Storage & Rate Limiting
- Pairing is initiated by workspace `OWNER` or `ADMIN`.
- The server generates a genuine 256-bit random token formatted as `MSH_<43-char-base64url>` and persists **only its SHA-256 hash** (`challengeHash`).
- CLI pairing (`messiah-bridge pair`) prompts interactively via masked stdin (`askSecret`) and never accepts tokens via CLI arguments or environment variables.
- Challenges expire in 5 minutes (300 seconds).
- Failed claim attempts are rate-limited and invalidate the challenge after 5 failures.
- Activation requires explicit workspace admin review and approval on the web dashboard.

### 13.5 Phase 4B Signed Task Authorization & Workstation Containment
- Tasks dispatched over WSS carry HMAC-SHA256 server signatures (`MESSIAH_TASK_AUTH:...`) verified locally with `ReplayGuard` nonce deduplication.
- Local filesystem mutations pass canonical `PathGuard` realpath containment checks against administrator-approved project roots, blocking symlinks escaping roots and high-risk secret files (`.ssh`, `.aws`, `.env`).
- Local processes spawn strictly with argument arrays (`shell: false`), scrubbed environments, and process-tree termination on timeout or cancellation.

---

_End of Document: Messiah Security Architecture & Zero-Trust Model._
