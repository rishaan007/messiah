# MESSIAH Production Deployment & Operations Guide

> **Version:** 1.0.0  
> **Scope:** Staging & Production Rollout, Environment Security, TLS Reverse Proxy, Backups, Recovery & Observability.

---

## 1. Prerequisites & Container Architecture

Messiah deploys as three application containers plus stateful data and edge services defined in [`infrastructure/production/docker-compose.prod.yml`](file:///Users/rishaankumar/Desktop/messiah/infrastructure/production/docker-compose.prod.yml):

- **`postgres` (`pgvector/pgvector:pg16`)**: Primary PostgreSQL 16 database with `vector` extension (`pgvector`) for semantic HNSW search (`1536d` and `768d`), transactional outbox, workflows, and RBAC.
- **`redis` (`redis:7.2-alpine`)**: Authenticated Redis (`--requirepass`, `--appendonly yes`) backing BullMQ (`messiah-chat-generation`), ephemeral device presence, WebSocket tickets, and real-time pub/sub.
- **`server` (`apps/server/Dockerfile`)**: Fastify 5 API, WebSocket gateway (`/api/v1/realtime` & `/api/v1/devices/connect`), and embedded metrics exporter (`/metrics`).
- **`worker` (`apps/worker/Dockerfile`)**: Standalone BullMQ consumer executing AI chats, multi-turn MCP tools, swarms, workflow DAGs, transactional outbox sweep (`5000ms`), and PostgreSQL cron scheduler (`15000ms`).
- **`web` (`apps/web/Dockerfile`)**: Next.js 16 (`MESSIAH_NEXT_OUTPUT=standalone`) server-rendered web application and installable PWA assets (`/manifest.webmanifest`, `/sw.js`, `/offline.html`).
- **`nginx` (`infrastructure/production/nginx.conf`)**: TLS/HTTP reverse proxy routing `/api/*` and WebSocket upgrades (`Upgrade`/`Connection`) to `server:3001`, and frontend traffic to `web:3000`.
- **`prometheus` (`infrastructure/production/prometheus.yml`)**: Metrics scraper targeting `server:3001/metrics`.

---

## 2. Environment Configuration

Copy the appropriate template and populate secrets externally (AWS Secrets Manager, GCP Secret Manager, Vault, or protected host `.env.production`):

- **Staging:** [`.env.staging.example`](file:///Users/rishaankumar/Desktop/messiah/.env.staging.example)
- **Production:** [`.env.production.example`](file:///Users/rishaankumar/Desktop/messiah/.env.production.example)

Required security variables enforced **fail-closed** when `NODE_ENV=production` (`validateProductionSecurityConfig` in `apps/server/src/config/env.ts`):

| Variable | Generation / Requirement |
| :--- | :--- |
| `VAULT_ENCRYPTION_KEY` | 64-character hex string (`openssl rand -hex 32`); never use the dev placeholder |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET` | Real Supabase project credentials; `SUPABASE_JWT_SECRET` $\ge 32$ chars |
| `CORS_ORIGIN`, `MESSIAH_ALLOWED_ORIGINS` | Exact HTTPS origins (e.g., `https://app.messiah.example`); wildcard `*` is rejected |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `DATABASE_URL` | Unique database password (`?schema=public&connection_limit=20`) |
| `REDIS_PASSWORD`, `REDIS_URL` | Strong Redis password matching `--requirepass` |
| `MESSIAH_METRICS_TOKEN` | Bearer token protecting `/metrics` scrapes |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Optional Web Push keys (`npx web-push generate-vapid-keys`) |

---

## 3. Initial Boot & Database Migration Sequence

```bash
# 1. Start core stateful infrastructure
docker compose --env-file .env.production -f infrastructure/production/docker-compose.prod.yml up -d postgres redis

# 2. Apply Prisma migrations (includes 10_notifications_push_and_sessions + pgvector HNSW indexes)
DATABASE_URL="$(grep '^DATABASE_URL=' .env.production | cut -d= -f2-)" \
  pnpm --filter @messiah/db exec prisma migrate deploy

# 3. Verify migration state
DATABASE_URL="$(grep '^DATABASE_URL=' .env.production | cut -d= -f2-)" \
  pnpm --filter @messiah/db exec prisma migrate status

# 4. Build & launch server, worker, web, nginx, and prometheus
docker compose --env-file .env.production -f infrastructure/production/docker-compose.prod.yml up -d --build
```

---

## 4. Health Checks & Monitoring

- **Liveness**: `GET /health/live` -> HTTP `200` `{ status: "alive", version: "1.0.0" }`.
- **Readiness**: `GET /health/ready` -> Verifies PostgreSQL + Redis round-trip latency; returns `503` when either dependency fails.
- **Prometheus Metrics**: `GET /metrics` (requires `Authorization: Bearer $MESSIAH_METRICS_TOKEN` when configured) exports `messiah_db_up`, `messiah_pgvector_enabled`, `messiah_redis_up`, `messiah_outbox_pending_total`, `messiah_outbox_failed_total`, `messiah_active_devices_total`, `messiah_active_workflows_total`, `messiah_process_resident_memory_bytes`, and `messiah_http_requests_total`.

---

## 5. Backup & Disaster Recovery

> **Important Version Alignment Note**: Always match the `pg_dump` / `pg_restore` major version (`16.x`) to the target PostgreSQL 16 (`pgvector/pgvector:pg16`) container or managed RDS instance. Running `pg_dump` v17+ (e.g., PostgreSQL 18 client on macOS) emits `SET transaction_timeout = 0;` which fails `pg_restore` against PostgreSQL 16 servers.

### Automated Backup

[`infrastructure/scripts/backup-postgres.sh`](file:///Users/rishaankumar/Desktop/messiah/infrastructure/scripts/backup-postgres.sh) automatically strips Prisma's `?schema=...` query parameter, produces a compressed custom-format archive (`--format=custom --compress=9`), validates archive structure with `pg_restore --list`, and writes a `.sha256` checksum manifest:

```bash
DATABASE_URL="postgresql://..." ./infrastructure/scripts/backup-postgres.sh /var/backups/messiah
```

### Verified Restore Procedure

[`infrastructure/scripts/restore-postgres.sh`](file:///Users/rishaankumar/Desktop/messiah/infrastructure/scripts/restore-postgres.sh) verifies the SHA-256 checksum, guarantees `CREATE EXTENSION IF NOT EXISTS vector`, runs `pg_restore --clean --if-exists --no-owner --no-acl`, and queries restored `memories` and `workflow_definitions` row counts:

```bash
./infrastructure/scripts/restore-postgres.sh \
  /var/backups/messiah/messiah_YYYYMMDDTHHMMSSZ.dump \
  "postgresql://user:pass@host:5432/messiah_restore_target"
```

---

## 6. Desktop & Mobile Release Signing Readiness

- **macOS Desktop (`.app` / `.dmg`)**: Configure GitHub Actions secrets `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, and `TAURI_SIGNING_PRIVATE_KEY` (`apps/desktop/src-tauri/entitlements.plist` and `tauri.conf.json` ready). Update `plugins.updater.pubkey` in `tauri.conf.json` before cutting signed public releases.
- **Windows Desktop (`.msi` / NSIS + `messiah-win-appcontainer-helper.exe`)**: Compile [`apps/bridge-daemon/native/win-appcontainer-helper`](file:///Users/rishaankumar/Desktop/messiah/apps/bridge-daemon/native/win-appcontainer-helper/CMakeLists.txt) on Windows with MSVC (`cmake --build --config Release`), code-sign the helper + NSIS/MSI installers via Authenticode, and verify on a real Windows host before enabling `MESSIAH_WIN_APPCONTAINER_HELPER`.
- **Linux Desktop (`.AppImage` / `.deb`)**: Build on Ubuntu via `.github/workflows/ci-release.yml` with `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `libsecret-1-dev`. Verify kernel unprivileged user namespaces (`bwrap`) on the target workstation before enabling sandboxed local execution.
- **iOS & Android (`apps/mobile`)**: Open generated Capacitor projects via `npx cap add ios && npx cap sync` (requires full macOS Xcode) and `npx cap add android && npx cap sync` (requires Android Studio / SDK), configure APNs / Firebase Cloud Messaging keys, and upload signed App Store / Play Store bundles.
