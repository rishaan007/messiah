# MESSIAH — DEVELOPMENT ROADMAP & EXECUTION PHASES

> **Document Stage**: Phase 0 — Architecture & Discovery  
> **Version**: 1.0.0  
> **Methodology**: Phased Milestone Delivery, Strict Verification Gates

---

## 1. Roadmap Overview & Timeline Strategy

The development of **MESSIAH** is structured into eight distinct phases (Phase 0 through Phase 7). Each phase builds upon the previous one with zero premature abstractions, requiring comprehensive automated test coverage, security checkpoints, and explicit project owner sign-off before advancing.

```mermaid
gantt
    title Messiah Phased Execution Roadmap
    dateFormat  YYYY-MM-DD
    section Discovery & Foundations
    Phase 0: Architecture & Blueprint   :done, p0, 2026-11-20, 2026-11-21
    Phase 1: Workspace & Core Monorepo   :active, p1, 2026-11-22, 2026-12-05
    section Core Agent Platform
    Phase 2: AI Providers & Chat Engine :p2, 2026-12-06, 2026-12-20
    Phase 3: MCP Protocol & Execution    :p3, 2026-12-21, 2027-01-08
    section Local Bridge & Swarms
    Phase 4: Local Bridge & Devices      :p4, 2027-01-09, 2027-01-26
    Phase 5: Multi-Agent Swarms & 3D UI  :p5, 2027-01-27, 2027-02-14
    section Memory & Ecosystem
    Phase 6: Vector Memory & Automation  :p6, 2027-02-15, 2027-03-05
    Phase 7: Native Clients & Hardening  :p7, 2027-03-06, 2027-03-25
```

---

## 2. Phase-by-Phase Execution Plan

### Phase 0: Product Discovery & Architecture (CURRENT STAGE)

- **Primary Goal**: Establish complete system architecture, database contracts, threat models, integration interfaces, and phased execution roadmap. Inspect existing workspace and preserve any prior work.
- **Key Deliverables**:
  - `docs/PRODUCT_VISION.md`
  - `docs/ARCHITECTURE.md`
  - `docs/DATABASE_SCHEMA.md`
  - `docs/SECURITY_MODEL.md`
  - `docs/INTEGRATION_STRATEGY.md`
  - `docs/DEVELOPMENT_ROADMAP.md`
- **Verification Criteria**:
  - Workspace inspection confirmed empty or existing files preserved.
  - Zero application scaffolding or speculative code implemented before review.
  - Full architectural sign-off from Project Owner.

---

### Phase 1A: Foundation & Workspace Scaffolding (COMPLETE)

- **Primary Goal**: Initialize the production-ready Turborepo monorepo with pnpm workspaces, build the Next.js 16 frontend command center shell with responsive navigation and empty states, configure the Fastify 5 backend foundation with liveness/readiness health probes and strict error handling, configure local Docker Compose infrastructure for PostgreSQL and Redis, and establish shared packages (`@messiah/shared`, `@messiah/config`, `@messiah/ui`, `@messiah/db`).
- **Status**: Completed. All packages, builds, liveness probes, and empty states verified.

### Phase 1B: Authentication, Identity & Workspace Tenancy (COMPLETE)

- **Primary Goal**: Implement Supabase Auth external identity integration, server-side JWT verification (`jose`), Next.js 16 `proxy.ts` session management, transactional user resolution, default personal workspace creation, and IDOR-safe workspace APIs.
- **Key Deliverables**:
  - **Supabase Auth Integration**: Registration, login, password reset request/completion, email confirmation, and session refresh.
  - **Next.js 16 Proxy Session Guard**: `apps/web/proxy.ts` enforcing authentic identity via `supabase.auth.getUser()`.
  - **Fastify 5 Authentication Hook**: `fastify.authenticate` supporting symmetric HS256 secret or asymmetric JWKS verification.
  - **Transactional Provisioning**: `findOrCreateUserFromAuth` ensures idempotent user record creation and default personal workspace provisioning on first auth.
  - **Workspace & Tenancy API**: `/api/v1/me`, `/api/v1/workspaces`, `/api/v1/workspaces/:workspaceId` with strict membership verification preventing IDOR leaks.
  - **Automated Test Suite**: 19 automated tests (14 auth + 5 health) verifying token validation, expired tokens, tampered signatures, user resolution, idempotency, profile updates, and multi-tenant isolation.
- **Verification Criteria**:
  - `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` all pass with 100% success.
  - Baselined database migration `0_init` applied with 0 schema drift.
  - Zero nonfunctional UI buttons; Obsidian dark theme authenticated shell.

---

### Phase 2A: AI Provider Connectors & Encrypted Credential Vault (COMPLETE)

- **Primary Goal**: Build the dedicated `@messiah/providers` package, integrate official SDKs for OpenAI, Anthropic, and Google Gemini, implement an AES-256-GCM zero-trust credential vault with KMS key abstraction and key versioning, implement RBAC and anti-IDOR protected backend endpoints, and provide an Obsidian dark theme Integration Center in Next.js 16.
- **Key Deliverables**:
  - **`@messiah/providers` Package**: Modular, decoupled architecture featuring `IProviderAdapter`, `ProviderRegistry`, `OpenAIAdapter`, `AnthropicAdapter`, and `GeminiAdapter`.
  - **Zero-Token Credential Verification**: Live validation using lightweight non-billable catalog metadata endpoints (`models.list`).
  - **AES-256-GCM Credential Vault**: `VaultService` with 12-byte IVs, 16-byte authentication tags, key versioning (`v1`), zero-plaintext guarantees, and `IKmsService` abstraction (`LocalKmsService`).
  - **Database & Audit Trail**: Migration `1_provider_connections` applying `ProviderStatus`, `ProviderConnection`, `EncryptedCredential`, and `AuditLog` tables.
  - **Backend API Layer**: Versioned REST endpoints (`/api/v1/providers`, `/api/v1/providers/:providerId/models`, `/api/v1/provider-connections*`) with strict `OWNER`/`ADMIN` RBAC and anti-IDOR controls.
  - **Frontend Integration Center**: `/settings/integrations` responsive dark UI with provider status cards, connect dialog, live testing, deletion confirmation, and model discovery modal.
  - **Automated Verification**: 55 automated tests passing with 100% success (18 provider unit tests + 37 server tests).
- **Status**: Completed.

### Phase 2B: Universal Streaming Chat Engine & Realtime Conversation Gateway (COMPLETE)

- **Primary Goal**: Build the universal streaming chat execution engine across OpenAI, Anthropic, and Gemini SDKs, Fastify WebSocket gateway with single-use ticket authentication, conversation thread and message persistence in PostgreSQL, Redis Pub/Sub multiplexing with local fallback, run cancellation propagation via AbortController, startup orphan run reconciliation, and rich Obsidian dark theme chat workspace in Next.js 16.
- **Key Deliverables**:
  - **Provider Streaming Layer (`@messiah/providers`)**: Extended `IProviderAdapter` with `streamResponse(request, abortSignal)` across official OpenAI, Anthropic (with thinking delta suppression), and Google Gemini SDKs.
  - **Cryptographically Bound Vault v2**: Hardened `AES-256-GCM` vault with Additional Authenticated Data (AAD) bound to `workspaceId`, `providerConnectionId`, `provider`, and `keyVersion` with seamless `v1` fallback.
  - **Database Migration `2_chat_engine`**: Applied schema for `Thread`, `Message`, `GenerationRun`, and enums `MessageRole`, `MessageStatus`, `RunStatus`.
  - **Asynchronous Chat Execution Engine (`apps/server/src/services/chat/`)**: Background streaming worker, 1.5s/200char PostgreSQL checkpoints, single-active-run concurrency guard (409 Conflict), idempotency key deduplication, and startup orphan run reconciliation.
  - **Realtime WebSocket Gateway**: Fastify WebSocket gateway at `/api/v1/realtime` secured via 30s single-use SHA-256 tickets (`POST /api/v1/realtime/ticket`), origin validation, and thread snapshot reconciliation.
  - **Next.js 16 Universal Chat Workspace**: Route `/chat` and `/chat/[threadId]` with conversation sidebar, thread search/rename/delete, provider/model picker, sanitized markdown renderer with code syntax highlighting, copy button, live streaming cursor, stop button, and multi-line composer.
  - **Automated Verification**: 76 automated tests passing with 100% success (24 provider streaming & catalog tests + 52 server chat, auth, provider, and health tests).
- **Status**: Completed.

### Phase 2B.1: Execution Reliability & Security Hardening (COMPLETE)

- **Primary Goal**: Harden the universal chat execution engine before introducing MCP tool execution. Implement database-enforced concurrency serialization, database-level idempotency with canonical SHA-256 fingerprinting, durable background execution with BullMQ and Transactional Outbox pattern, cross-worker cancellation via Redis Pub/Sub, strict WebSocket Origin enforcement, and frontend Markdown XSS sanitization.
- **Key Deliverables**:
  - **OpenAI Streaming Correction**: Updated `OpenAIAdapter` to accurately process Responses API incremental events (`response.output_text.delta` reading `.delta`, `response.output_text.done`, `response.completed`), with realistic SDK event fixtures.
  - **Database-Enforced Idempotency**: Added `IdempotencyKey` model with composite unique constraint on `(threadId, key)`. Canonical request fingerprinting detects payload changes on reused keys, rejecting with HTTP 422 `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`, while replaying identical requests with HTTP 200.
  - **Single Active Run Concurrency**: Applied PostgreSQL partial unique index `idx_generation_runs_single_active_per_thread` on `generation_runs("thread_id") WHERE status IN ('PENDING', 'STREAMING')`. Concurrent requests catch `P2002` and map to HTTP 409 `CONCURRENT_RUN_ACTIVE`.
  - **Durable Background Execution (`@messiah/worker`)**: Built BullMQ background worker package (`messiah-chat-generation`) with deterministic `jobId: run.id`, zero retries on LLM calls (`attempts: 1`), and a Transactional Outbox sweeper ensuring resilience across broker interruptions.
  - **Cross-Worker Cancellation**: Redis Pub/Sub channel `messiah:cancel:<runId>` broadcasts cancellations across multi-worker clusters. Terminal runs (`COMPLETED`, `FAILED`, `CANCELLED`, `INTERRUPTED`) cannot be cancelled.
  - **WebSocket Security Hardening**: Strict Origin checks against `MESSIAH_ALLOWED_ORIGINS` in production (`NODE_ENV === "production"`), closing untrusted connections with code 4403.
  - **Frontend Content Security**: Hardened `MarkdownRenderer` with URL protocol allowlists (`https:`, `http:`, `mailto:`, relative paths; blocking `javascript:`, `data:`, `vbscript:`, `file:`), raw HTML character escaping, and `rel="noopener noreferrer"`.
  - **Automated Verification**: 102 automated tests passing monorepo-wide (27 provider tests + 60 server tests + 4 worker tests + 11 web tests).
- **Status**: Completed.

---

### Phase 3A: MCP Server Connections & Tool Registry (COMPLETE)

- **Primary Goal**: Establish secure Model Context Protocol connection, discovery, and governance infrastructure conforming to the **2026-07-28 MCP Specification** using the official TypeScript SDK v2 (`@modelcontextprotocol/client` and `@modelcontextprotocol/core`).
- **Key Deliverables**:
  - **Dedicated `@messiah/mcp` Package**: Modular client factory, transport factory (`StreamableHTTPClientTransport` + `SSEClientTransport`), workspace-isolated `McpConnectionManager`, discovery service, in-memory tool registry with TTL expiration, OAuth2/PKCE auth service, and health probing.
  - **Enterprise SSRF & Network Security Layer**: Strict IPv4/IPv6 private IP, loopback, link-local, carrier-grade NAT, and cloud metadata sanitization. HTTPS enforced in production. Socket-level DNS rebinding defense (`createSafeLookup` / `safeFetch`) hooks directly into socket connections.
  - **Deterministic Discovery & Schema Hashing**: Computes SHA-256 `schemaHash` to detect tool definition changes. Formats unambiguous namespaced tool identifiers (`serverIdentifier.toolName`).
  - **Zero-Trust Credential Vault Binding**: AES-256-GCM v2 AAD context bound to `workspaceId`, `connectionId`, and provider `"mcp"`.
  - **Deny-by-Default Governance & Execution Freeze**: Newly discovered tools default to `REQUIRE_APPROVAL`. Server annotations are untrusted informational metadata. Model execution is strictly frozen in Phase 3A (`assertExecutionDisabled`).
  - **Database Migration `4_mcp_connections`**: Adds `McpServerConnection`, `McpCredential`, `McpToolDefinition`, and `McpToolPermission` models.
  - **Backend API Layer**: REST endpoints at `/api/v1/mcp/*` with RBAC (`OWNER`/`ADMIN`) and anti-IDOR protections.
  - **Frontend MCP Connection Center**: Next.js 16 UI at `/settings/mcp` and `/settings/mcp/[connectionId]` with server cards, modal, live health probes, tool inspection, and permission dropdowns.
  - **Automated Verification**: 135 automated tests passing monorepo-wide (15 MCP package tests + 78 server tests + 27 provider tests + 4 worker tests + 11 web tests).
- **Status**: Completed.

### Phase 3A.1: MCP Transport Security & Protocol Hardening (COMPLETE)

- **Primary Goal**: Perform targeted security verification and protocol hardening of Messiah's MCP infrastructure, closing socket-level interception gaps in Node.js 18+/24, enforcing strict production egress-port policy, sanitizing evasive IP encodings, updating wire protocol handling to the MCP 2026-07-28 stateless standard, and hardening OAuth RFC 9207 issuer validation.
- **Key Deliverables**:
  - **Undici Socket-Level DNS Rebinding Protection (`safeFetch`)**: Integrated `undici.Agent` dispatcher with custom `connect: { lookup: safeLookup }` socket hook, guaranteeing DNS is validated at TCP connection time and preventing TOCTOU rebinding while preserving TLS SNI certificate validation.
  - **Explicit Production Egress-Port Policy**: Replaced port blocklists with an explicit allowlist policy: HTTPS only, Port 443 by default in production. Custom egress ports (e.g. 8443) strictly require configuration via `allowedPorts` or `MCP_ALLOWED_EGRESS_PORTS`.
  - **Evasive IP & Zone Identifier Detection**: Sanitizes raw URL hostnames to reject octal (`0177.0.0.1`), hexadecimal (`0x7f.0.0.1`), dword integers (`2130706433`), short numerics (`127.1`), and IPv6 zone identifiers (`%eth0`, `%25eth0`). Handles 6to4 addresses (`2002::/16`) and IPv4-mapped IPv6 hex/dot representations.
  - **Safe Redirects with Credential Stripping**: `safeFetch` re-evaluates SSRF and egress port policy on every hop (max 3), immediately strips `Authorization`, `Proxy-Authorization`, and `Cookie` headers on cross-origin redirects, and aborts redirects attempting to hit internal hosts or cloud metadata (`169.254.169.254`).
  - **MCP 2026-07-28 Wire Compliance**: Updated `StreamableHTTPClientTransport` with `redirectPolicy: "same-origin"`. Stateless client factory omits deprecated capabilities (`roots`, `sampling`, `logging`) from client defaults.
  - **OAuth Security & RFC 9207 Issuer Validation**: Enforces RFC 9207 issuer verification during authorization code exchange to prevent mix-up attacks. Generates high-entropy PKCE S256 challenges and CSRF state parameters.
  - **Workspace & Permission Isolation**: Database constraints and service-level checks guarantee that tool permissions strictly inherit `workspaceId` from the parent connection and cross-workspace access is rejected with HTTP 404 anti-IDOR. Deny-by-default (`REQUIRE_APPROVAL`) and execution freeze (`assertExecutionDisabled`) maintained.
  - **Automated Verification**: 147 automated tests passing monorepo-wide (25 MCP tests + 80 server tests + 27 provider tests + 4 worker tests + 11 web tests).
- **Status**: Completed.

### Phase 3B: Autonomous MCP Tool Execution & Agent ReAct Engine (COMPLETE)

- **Primary Goal**: Integrate discovered MCP tools into the chat execution engine, enabling models to autonomously invoke tools within controlled ReAct reasoning loops with Human-in-the-Loop (HITL) approvals.
- **Key Deliverables**:
  - **Tool Schema Translation (`@messiah/mcp`)**: Automatic bidirectional translation from JSON Schema into provider-specific tool schemas (OpenAI function calling, Anthropic tool definitions, Gemini function declarations) with validation and argument casting.
  - **ReAct Execution Engine (`apps/server`, `@messiah/worker`)**: Multi-step tool-calling agent loop in BullMQ worker with checkpointing, iteration limits, error handling, and cancellation propagation.
  - **Human-in-the-Loop (HITL) Broker**: `ToolApprovalService` with cryptographic argument hashing (`argumentsHash`), permission governance, and secure approval card generation for tools requiring confirmation.
  - **Streaming Tool Execution UI (`apps/web`)**: Interactive chat cards (`ToolCallCard`, `ToolApprovalCard`) showing arguments, execution state, output, error traces, and approval workflows in Obsidian dark theme.
  - **Database Migration `5_mcp_tool_execution`**: Added `ToolCall` and `ToolApproval` models and associated enums (`ToolCallStatus`, `ToolApprovalStatus`).
  - **Automated Verification**: 182 automated tests passing monorepo-wide.
- **Status**: Completed.

### Phase 3B.1: Agent Execution Reliability & Approval Security Verification (COMPLETE)

- **Primary Goal**: Perform targeted verification and security hardening of the multi-turn agent tool execution engine without rewriting working functionality. Enforce provider protocol consistency, collision-resistant tool aliasing, durable outbox resumption, execution outcome correctness (`UNKNOWN_OUTCOME`), and defense-in-depth approval UI security.
- **Key Deliverables**:
  - **Provider Protocol Consistency (`@messiah/providers`)**: Strictly separated OpenAI Responses API (`function_call`/`function_call_output` with `call_id`) and Chat Completions (`tool_calls`/`role: "tool"` with `tool_call_id`) preventing context corruption. Enforced Anthropic SDK turn alternation (merging multiple parallel tool results into a single user turn) and Gemini candidate function parts consolidation.
  - **Collision-Resistant Tool Aliasing (`@messiah/mcp`)**: Deterministic scoped alias format `mcp__<connectionSlug>_<connectionIdSuffix>__<toolName>` ($\le 64$ characters) derived from a 6-character hex connection UUID substring, eliminating collisions between identical tool names across different MCP servers.
  - **Durable Approval Resumption via Transactional Outbox (`apps/server`)**: Bound approval decisions to a single atomic PostgreSQL transaction verifying approver role (`OWNER`/`ADMIN`), dual SHA-256 hashes (`schemaHash`, `argumentsHash`), contextual bindings, and conditional row locks (`updateMany` with `status: "PENDING"` throwing `ALREADY_DECIDED`). Created durable `OutboxEvent` with `eventType: "generation.resume"`.
  - **Dual Dispatch & Outbox Sweeper**: Fast-path enqueue with deterministic `jobId: ${runId}-resume-${outboxEventId}` backed by `ChatQueueManager.sweepOutbox()` background resilience, guaranteeing at-least-once BullMQ resumption.
  - **Execution Outcome Correctness (`UNKNOWN_OUTCOME`)**: Categorized severed sockets (`ECONNRESET`, `UND_ERR_SOCKET`) and gateway timeouts (`ETIMEDOUT`, 504) as `UNKNOWN_OUTCOME`. Mutating operations with unknown outcomes are strictly barred from auto-retry.
  - **Approval UI Hardening (`apps/web`)**: Enhanced `ToolApprovalCard` with sensitive credential masking (`••••••••••••`), interactive unmask toggle, explicit external data disclosure warning (MCP host + AI provider), live 5-minute countdown, and concurrent cross-device decision rejection (`ALREADY_DECIDED` banner).
  - **Controllable Test MCP Server & Verification Suite**: Streamable HTTP MCP server implementing standard, error, timeout, and socket-severing operations. Added 10 integration tests in `agentReliability.test.ts`.
  - **Automated Verification**: 198 automated tests passing monorepo-wide with 100% pass rate across 13 test suites in 9 packages.
- **Status**: Completed.

---

### Phase 4: Local Agent Bridge & Device Management (NEXT)

- **Primary Goal**: Build the headless Local Agent Bridge daemon, establish the outbound-only WebSocket pairing protocol, and deliver the Human-in-the-Loop (HITL) approval broker.
- **Key Deliverables**:
  - **Bridge CLI Daemon**: Lightweight Node.js/TypeScript daemon (`messiah-bridge`).
  - **Pairing Handshake**: Ephemeral OTP pairing flow, Ed25519 keypair generation, OS keychain storage.
  - **Sandboxed Runner**: Canonical path containment (`realpath`), command blacklist validator, and clean subprocess spawning.
  - **Approval Broker**: Interactive push modal on Web/Mobile for Level 2 commands with cryptographic nonce verification.
  - **Device Console**: Dashboard displaying connected devices, OS metrics, bridge status, and one-click revocation.
- **Automated Verification**:
  - Path traversal attack penetration test: 20+ malicious paths (`../`, symlinks) attempting sandbox escape blocked.
  - Blacklist validation tests: `rm -rf`, `sudo`, `curl | bash` rejected immediately.
  - Outbound pairing test: End-to-end device pairing completed without opening any inbound ports.
- **Exit Criteria**: User can pair their local machine, run a prompt on the web UI, approve a `git status` or `npm test` command via the modal, and view live terminal output streamed to the browser.

---

### Phase 5: Multi-Agent Orchestration & 3D Topology Visualization

- **Primary Goal**: Implement multi-agent coordination patterns (Supervisor-Worker and Swarms) and deliver the interactive 3D WebGL workspace visualizer with accessibility fallbacks.
- **Key Deliverables**:
  - **Agent Registry**: UI for configuring custom agent personas, system prompts, model bindings, and tool permissions.
  - **Supervisor Runtime**: Multi-agent delegation runtime with infinite loop detection and token budget ceilings.
  - **3D Swarm Visualizer**: Three.js / React Three Fiber interactive constellation displaying agent nodes, state glows, and particle data streams.
  - **Accessibility 2D Fallback**: Automatic detection of low-power devices and `prefers-reduced-motion` switching to a 2D SVG D3 force-directed graph.
- **Automated Verification**:
  - Multi-agent delegation unit tests verifying task handoffs and cycle detection triggers.
  - Visual regression testing on 3D canvas and 2D fallback.
  - Performance benchmark: 60 FPS rendering maintained on modern desktop browsers with 15 active nodes.
- **Exit Criteria**: A supervisor agent decomposes a task across two specialized agents, renders live interaction arcs in the 3D visualizer, and presents an aggregated solution.

---

### Phase 6: Vector Memory & Workflow Automation

- **Primary Goal**: Deploy semantic long-term memory using PostgreSQL `pgvector`, build the visual workflow DAG engine, and support event triggers and cron automations.
- **Key Deliverables**:
  - **Vector Memory**: Ingestion pipeline computing embeddings, storing in `pgvector` with HNSW indexing, and querying via cosine similarity.
  - **Memory Scopes**: Workspace shared knowledge base vs agent-specific episodic memory.
  - **Visual Workflow Builder**: Node-based DAG interface for composing automated pipelines.
  - **Triggers**: Scheduled cron jobs, external webhooks (GitHub, Slack), and manual dispatch.
- **Automated Verification**:
  - HNSW query performance benchmark: < 20ms similarity retrieval across 100,000 vectors.
  - DAG execution test verifying topological sorting and parallel branch execution.
- **Exit Criteria**: Agents recall relevant context from prior conversations, and an automated workflow triggers successfully on a webhook event.

---

### Phase 7: Cross-Platform Clients & Production Hardening

- **Primary Goal**: Package native desktop and mobile clients, conduct security audits and penetration testing, execute load tests, and satisfy all production readiness criteria.
- **Key Deliverables**:
  - **Desktop App**: Tauri 2.0 application for macOS, Windows, and Linux with embedded bridge daemon and system tray controls.
  - **Mobile PWA / Expo**: High-performance mobile client with offline shell caching and native push notifications.
  - **Security Audit**: Penetration testing against prompt injection, credential extraction, and WebSocket socket starvation.
  - **Production CI/CD**: GitHub Actions pipelines for linting, testing, Docker builds, and automated semantic versioning.
- **Automated Verification**:
  - End-to-end Cypress/Playwright test suites covering 100% of critical user journeys.
  - Load testing: 1,000 concurrent active users and 200 concurrent tool executions without degradation.
  - WCAG 2.1 AA accessibility audit verification.
- **Exit Criteria**: Native installers built for macOS (.dmg), Windows (.msi), and Linux (.AppImage/.deb); production security review signed off.

---

_End of Document: Messiah Development Roadmap & Execution Phases._
