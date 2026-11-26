# MESSIAH User Guide & Cross-Platform Troubleshooting

> **Product:** MESSIAH — The Universal AI Agent Workspace (`v1.0.0`)

---

## 1. Getting Started Across Devices

1. **Web & Installable PWA**: Open Messiah in Chrome, Safari (iOS 16.4+ "Add to Home Screen"), Edge, or Firefox. Sign in with Supabase Auth on `/login`, select or create your workspace from the top header switcher, and explore the interactive onboarding checklist on `/`.
2. **macOS / Windows / Linux Desktop App (Tauri 2)**:
   - Install `MESSIAH` (`.dmg` on Apple Silicon/Intel macOS, `.exe`/`.msi` on Windows, `.AppImage`/`.deb` on Linux).
   - Use **Settings -> Paired Devices** (`/settings/devices`) to inspect desktop Local Agent Bridge controls (`Start`, `Stop`, `Refresh`, capability diagnostics), toggle launch-at-login, or trigger signed updater checks.
   - Closing the main window can minimize to the OS system tray rather than terminating active bridge monitoring.
3. **iPhone, iPad & Android Phones/Tablets**:
   - Install as a full-screen PWA (via Safari Share -> **Add to Home Screen** on iOS/iPadOS, or Chrome **Install App** prompt on Android) or launch via the Capacitor native shell (`@messiah/mobile`).
   - Use the bottom navigation bar (`Chat`, `Swarms`, `Workflows`, `Approvals`, `Devices`) for one-thumb mobile triage.
   - Offline chat messages written while disconnected are stored safely as per-thread local drafts (`apps/web/lib/offlineDrafts.ts`) and restore automatically on reconnection; `/api/*` data and secrets are never cached offline.

---

## 2. Approvals, Notifications & Audit Trail

- **Cross-Device Approvals Queue (`/approvals`)**: Review and approve or reject pending MCP remote tool calls, Local Agent Bridge workstation commands, Swarm plans, and Workflow `approval_gate` pauses from any phone, tablet, or desktop. Concurrent cross-device approvals are protected by atomic single-use locks (`ALREADY_DECIDED`).
- **Notifications Drawer & Preferences (`/settings/notifications`)**: Receive live WebSocket (`workspace.subscribe`), desktop OS, and Web Push alerts. Configure category filters (`Approvals`, `Completions`, `Failures`, `Device Status`), UTC quiet hours, and revoke lost push devices immediately.
- **Governance Audit Explorer (`/audit`)**: Filter historical workspace security and operational actions by event action, resource type, and actor (`MEMBER` or higher required).

---

## 3. Troubleshooting Common Issues

| Symptom | Likely Cause | Resolution |
| :--- | :--- | :--- |
| **"Workspace Not Found" or empty sidebar after switching pages** | Workspace ID stale in browser storage or unauthenticated cookie refresh | Refresh the page or re-select an active workspace from the top header switcher; check `/api/v1/workspaces` response |
| **Web Push button shows "Not configured on server"** | Missing `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` or unverified origin | Generate VAPID keys (`web-push generate-vapid-keys`), set them in server `.env`, and serve over HTTPS (`localhost` works in dev) |
| **Bridge capability shows Unsupported / Disabled** | Missing OS kernel sandbox prerequisite (`sandbox-exec` on macOS, `bwrap` userns on Linux, `MESSIAH_WIN_APPCONTAINER_HELPER` on Windows) | Inspect diagnostics on `/settings/devices`. Do not disable sandbox guarantees; enable `bwrap` userns on Linux or deploy signed Win32 helper on Windows |
| **Tauri Desktop cannot connect in production** | `MESSIAH_WEB_ORIGIN` unreachable or rejected by backend CORS | Verify `MESSIAH_ALLOWED_ORIGINS` includes the served web origin and TLS certificates are valid |
| **`pg_restore` fails with `unrecognized configuration parameter "transaction_timeout"`** | Dump created with PostgreSQL 17/18 `pg_dump` targeting PostgreSQL 16 server | Recreate dump using PostgreSQL 16 client binaries matching `pgvector/pgvector:pg16` |
