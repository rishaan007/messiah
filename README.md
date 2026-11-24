# MESSIAH — The Universal AI Agent Workspace

> **Tagline:** One intelligence layer. Every agent. Every device.  
> **Stage:** Phase 3B Complete — MCP Tool Execution & Controlled Multi-Turn Agent Engine  
> **License:** UNLICENSED (Proprietary)

---

## 1. Project Overview

**MESSIAH** is a centralized, cross-platform workspace that allows engineering teams and power users to connect, manage, and coordinate AI agents across diverse model providers, cloud infrastructure, and local developer workstations.

Key architectural pillars:

- **Modular Monolith Architecture**: High-throughput Fastify 5 core with modular domain plugins and asynchronous worker offloading.
- **Dedicated Provider Adapters (`@messiah/providers`)**: Direct integration with official OpenAI, Anthropic, and Google Gemini SDKs with zero intermediate gateway dependencies.
- **Universal Streaming Chat Engine**: Fastify WebSocket gateway (`/api/v1/realtime`) with two-stage ticket auth, Redis Pub/Sub multiplexing, and live character streaming.
- **Durable Checkpointing & Orphan Reconciliation**: Asynchronous background workers with periodic DB checkpoints and startup recovery for orphaned runs.
- **Zero-Token Credential Verification**: Non-billable catalog testing ensures API keys are verified without burning inference tokens.
- **Cryptographically Bound Vault v2**: AES-256-GCM authenticated encryption with Additional Authenticated Data (AAD) bound to workspace, connection ID, and provider.
- **Cross-Platform Continuity**: Access identical conversation state and task execution across Web (PWA), macOS, Windows, Linux, iOS, and Android.
- **Zero-Inbound Local Agent Bridge**: Local machines establish outbound-only TLS 1.3 WebSocket connections without requiring public IP addresses, VPNs, or open inbound ports.
- **Human-in-the-Loop (HITL) Security**: Multi-tier capability controls requiring explicit human approvals for sensitive local file and command mutations.

---

## 2. Monorepo Repository Structure

Messiah is structured as a **Turborepo** monorepo managed with **pnpm workspaces**:

```
messiah/
├── apps/
│   ├── web/                         # Next.js 16 (React 19) Command Center Web UI
│   │   ├── app/                     # App Router pages (/login, /signup, /chat, /settings/integrations)
│   │   ├── components/              # ChatWorkspace, MarkdownRenderer, Header, Sidebar
│   │   └── lib/                     # Supabase client, auth helpers, API clients
│   ├── worker/                      # BullMQ background chat execution worker
│   └── server/                      # Fastify 5 Modular Monolith API Gateway
│       ├── src/config/              # Strict environment validation (Zod)
│       ├── src/plugins/             # Security (Cors, Helmet), Prisma, Redis, Auth, WebSocket
│       ├── src/routes/              # /threads*, /runs*, /realtime*, /providers*, /mcp*, /workspaces*
│       ├── src/services/            # ChatService, McpServerService, VaultService, ReconciliationService
│       └── src/tests/               # Vitest test suites (182 passing tests across monorepo)
├── packages/
│   ├── mcp/                         # Model Context Protocol SDK v2, SSRF security & registry
│   ├── providers/                   # Official AI SDK adapters (OpenAI, Anthropic, Gemini)
│   ├── shared/                      # Canonical TypeScript types, schemas, and enums
│   ├── config/                      # Base TypeScript and ESLint configs
│   ├── ui/                          # Reusable UI primitives, design tokens & components
│   └── db/                          # Prisma ORM schema, client singleton & migrations
├── docs/                            # Architectural specs, CHAT_ENGINE.md, REALTIME_PROTOCOL.md
├── infrastructure/                  # Local and production infrastructure manifests
├── docker-compose.yml               # Local PostgreSQL 16 & Redis 7.2 stack
├── pnpm-workspace.yaml              # Workspace directory mappings
├── turbo.json                       # Turborepo task pipeline configuration
├── package.json                     # Monorepo root scripts
└── README.md
```

---

## 3. Technology Stack (Phase 1A Baseline)

- **Frontend**: Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS, Lucide React, Framer Motion.
- **Backend**: Node.js (v24/v26 LTS), TypeScript, Fastify 5, Zod, Pino structured logging.
- **Database & Storage**: PostgreSQL 16 (Alpine), Prisma ORM v6, Redis 7.2 (Alpine).
- **Monorepo Engine**: Turborepo v2, pnpm workspaces (v12).
- **Containerization**: Docker Compose v2.

---

## 4. Prerequisites

Ensure the following tools are installed on your host system:

1. **Node.js**: `v24.0.0` or higher (verified on Node.js v24.2.0)
2. **pnpm**: `pnpm >= 9.0.0` (or install via `npm install -g pnpm`)
3. **Docker & Docker Compose**: Docker 20+ with Docker Compose v2

---

## 5. Local Setup & Installation

### Step 1: Clone and Install Dependencies

```bash
git clone <repository-url> messiah
cd messiah

# Install all workspace dependencies cleanly
pnpm install
```

### Step 2: Configure Environment Variables

Copy the template configuration file:

```bash
cp .env.example .env
```

Default local values:

- Fastify Backend: `http://localhost:3001`
- Next.js Web: `http://localhost:3000`
- PostgreSQL: `localhost:5432` (`messiah_admin` / `messiah_dev_secure_password_replace_in_prod`)
- Redis: `localhost:6380` (`messiah_redis_dev_password`)

### Step 3: Start Local Infrastructure (Docker)

Start PostgreSQL and Redis in the background:

```bash
pnpm docker:up
```

Verify container health:

```bash
docker compose ps
```

Both `messiah-postgres` and `messiah-redis` should report `Up (healthy)`.

### Step 4: Generate Database Client & Synchronize Schema

```bash
# Generate Prisma Client types
pnpm db:generate

# Push schema directly to the local PostgreSQL instance
pnpm db:push
```

---

## 6. Development & Run Commands

| Command                             | Action                                                                                 |
| :---------------------------------- | :------------------------------------------------------------------------------------- |
| `pnpm dev`                          | Starts all applications in parallel (Web on `:3000`, Server on `:3001`) via Turborepo. |
| `pnpm --filter @messiah/server dev` | Starts only the Fastify backend server with hot-reload (`tsx watch`).                  |
| `pnpm --filter @messiah/web dev`    | Starts only the Next.js 16 frontend app.                                               |
| `pnpm build`                        | Executes cached production builds for all packages and apps.                           |
| `pnpm typecheck`                    | Runs TypeScript compiler checks across all workspaces.                                 |
| `pnpm lint`                         | Executes linter checks across all workspaces.                                          |
| `pnpm test`                         | Runs automated test suites via Vitest.                                                 |
| `pnpm docker:down`                  | Stops and tears down local Docker containers.                                          |

---

## 7. Health & Verification Endpoints

The backend provides zero-leakage health endpoints for orchestrators and load balancers:

### Liveness Probe (`GET /health/live`)

Returns process state without querying external dependencies:

```bash
curl http://localhost:3001/health/live
```

```json
{
  "status": "alive",
  "uptimeSeconds": 42,
  "timestamp": "2026-11-21T05:45:00.000Z",
  "version": "0.1.0"
}
```

### Readiness Probe (`GET /health/ready`)

Tests PostgreSQL and Redis connectivity, returning HTTP 200 when ready or HTTP 503 if any dependency is unreachable:

```bash
curl http://localhost:3001/health/ready
```

```json
{
  "status": "healthy",
  "timestamp": "2026-11-21T05:45:00.000Z",
  "version": "0.1.0",
  "checks": {
    "database": {
      "status": "healthy",
      "latencyMs": 3,
      "message": "Database responsive",
      "timestamp": "2026-11-21T05:45:00.000Z"
    },
    "redis": {
      "status": "healthy",
      "latencyMs": 1,
      "message": "Redis responsive",
      "timestamp": "2026-11-21T05:45:00.000Z"
    }
  }
}
```

---

## 8. Authentication & Workspace Architecture (Phase 1B)

Messiah uses **Supabase Auth** as its external identity provider while maintaining PostgreSQL as the authoritative application database via Prisma ORM:

- **Identity Mapping**: Supabase external identities (`auth.users.id`) map to internal Messiah `User` records through `(externalProvider, externalId)` unique indexing.
- **Zero Password Duplication**: Password credentials, hashes, and recovery flows are securely offloaded to Supabase Auth.
- **Server Token Verification**: Fastify's `fastify.authenticate` preHandler validates inbound JWTs using `jose` with symmetric HS256 secret or Supabase JWKS discovery.
- **Transactional Tenancy**: On first authentication, the backend automatically provisions the user record and their default personal workspace with the user assigned as `OWNER`.
- **IDOR Protection**: All workspace operations strictly enforce membership validation. Unauthorized requests return generic `404 Not Found` responses to prevent workspace existence enumeration.
- **Next.js 16 Proxy Convention**: `apps/web/proxy.ts` performs server-side session refreshes via `supabase.auth.getUser()`, ensuring spoofed JWTs are rejected.

### Protected API Endpoints

All protected endpoints require `Authorization: Bearer <token>`:

| Method  | Endpoint                         | Description                                                             |
| :------ | :------------------------------- | :---------------------------------------------------------------------- |
| `GET`   | `/api/v1/me`                     | Resolves or idempotently provisions user profile and workspace listing. |
| `PATCH` | `/api/v1/me`                     | Updates user profile metadata (`fullName`, `avatarUrl`).                |
| `GET`   | `/api/v1/workspaces`             | Lists all workspaces where the user is an active member.                |
| `POST`  | `/api/v1/workspaces`             | Provisions a new workspace, auto-assigning the user as `OWNER`.         |
| `GET`   | `/api/v1/workspaces/:workspaceId`| Fetches specific workspace details (enforcing membership check).        |

---

## 9. AI Providers & Encrypted Credential Vault (Phase 2A)

Messiah connects to external AI providers through official vendor SDKs and stores workspace API keys inside an **AES-256-GCM Encrypted Credential Vault**:

- **Official SDK Integrations**: `openai`, `@anthropic-ai/sdk`, and `@google/genai` encapsulated in `@messiah/providers`.
- **Zero-Token Credential Verification**: Live validation tests API keys against non-billable catalog metadata endpoints (`models.list`) to verify credentials without consuming inference tokens.
- **Authenticated Encryption**: `AES-256-GCM` with 12-byte IVs, 16-byte authentication tags, key versioning (`v1`), and `IKmsService` abstraction (`LocalKmsService`).
- **Zero-Plaintext Policy**: Raw API keys never touch disk, database columns, logs, or API responses after submission.
- **RBAC & Anti-IDOR**: Workspace `OWNER` or `ADMIN` roles required for credential management (`MEMBER` and `VIEWER` receive 403 Forbidden). Cross-tenant queries return 404 Not Found.
- **Frontend Integration Center**: Responsive Obsidian dark UI at `/settings/integrations` supporting connection creation, live testing, renaming, model discovery, and deletion.

### Provider API Endpoints

All provider management endpoints require `Authorization: Bearer <token>`:

| Method   | Endpoint                                  | Role Required   | Description                                                           |
| :------- | :---------------------------------------- | :-------------- | :-------------------------------------------------------------------- |
| `GET`    | `/api/v1/providers`                       | Member          | Lists all supported providers and their normalized capabilities.      |
| `GET`    | `/api/v1/providers/:providerId/models`    | Admin / Owner   | Lists live available models using a workspace's saved connection.     |
| `GET`    | `/api/v1/provider-connections`            | Member          | Lists active connections in a workspace (with masked fingerprints).   |
| `POST`   | `/api/v1/provider-connections`            | Admin / Owner   | Validates with provider, encrypts with vault, and creates connection. |
| `POST`   | `/api/v1/provider-connections/:id/test`   | Admin / Owner   | Executes live zero-token credential verification against provider.    |
| `PATCH`  | `/api/v1/provider-connections/:id`        | Admin / Owner   | Renames a connection or updates status.                               |
| `DELETE` | `/api/v1/provider-connections/:id`        | Admin / Owner   | Permanently removes connection and deletes encrypted vault secrets.   |

---

## 10. Current Implementation Scope & Phased Roadmap

| Milestone     | Status       | Description                                                                          |
| :------------ | :----------- | :----------------------------------------------------------------------------------- |
| **Phase 0**   | **COMPLETE** | Architectural Discovery, Threat Modeling, Database & Integration Blueprint.          |
| **Phase 1A**  | **COMPLETE** | Monorepo scaffolding, Fastify 5 core, Next.js 16 shell, Docker stack, health probes. |
| **Phase 1B**  | **COMPLETE** | Supabase Auth, Next.js 16 proxy session guard, workspace tenancy & RBAC security.   |
| **Phase 2A**  | **COMPLETE** | AI Provider connectors (OpenAI, Anthropic, Gemini), AES-256-GCM Vault, UI Center.     |
| **Phase 2B**  | **COMPLETE** | Universal streaming chat engine, Fastify WebSocket gateway, thread persistence.      |
| **Phase 2B.1**| **COMPLETE** | Concurrency hardening (partial unique index), idempotency, cross-worker cancel.     |
| **Phase 3A**  | **COMPLETE** | Remote MCP server connections (SDK v2), tool discovery, schema hashing, registry.    |
| **Phase 3A.1**| **COMPLETE** | Transport security hardening, safeFetch Undici dispatcher, egress port restriction.  |
| **Phase 3B**  | **COMPLETE** | Controlled MCP tool execution, multi-turn ReAct agent loop, human approvals (5m TTL).|
| **Phase 4**   | Pending      | Local Agent Bridge daemon, outbound pairing, HITL approval broker.                   |
| **Phase 5**   | Pending      | Multi-Agent Swarms, 3D WebGL Constellation with 2D fallback.                         |
| **Phase 6**   | Pending      | Vector memory (pgvector), workflow automation DAG engine.                            |
| **Phase 7**   | Pending      | Native cross-platform packaging, production security audit.                          |

> **Strict Scope Notice**: In Phase 3B, the controlled MCP tool execution and multi-turn agent engine is fully operational and verified by 182 automated tests across the monorepo. Local agent bridges, multi-agent swarms, and vector memory remain strictly in subsequent phases.
