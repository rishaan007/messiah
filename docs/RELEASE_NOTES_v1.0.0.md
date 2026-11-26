# MESSIAH v1.0.0 Release Notes — Phase 7 Final Planned Release

**Release Date:** 2026-11-26  
**Milestone:** Phase 7 — Cross-Platform Clients, Production Hardening & Release (`v1.0.0`)

---

## Highlights

1. **Tauri 2 Desktop Client (`apps/desktop`)**:
   - Native Apple Silicon ARM64 macOS build (`MESSIAH.app` + `MESSIAH_1.0.0_aarch64.dmg`) compiled and tested.
   - System tray controls, minimize-to-tray behavior, OS notification dispatch, deep-link validation (`messiah://`), autostart settings, OS keychain integration (`keyring`), Local Agent Bridge lifecycle management, and signed Ed25519/minisign auto-updater configuration.
   - Strict Tauri v2 least-privilege capability definitions (`default.json`), restrictive CSP, and URL allowlist enforcement.
2. **Installable PWA & Native Mobile Wrapper (`apps/web` + `apps/mobile`)**:
   - Installable Progressive Web App (`/manifest.webmanifest`, icons, `/offline.html`, zero-API-cache `/sw.js`, iOS `apple-touch-icon` & safe-area support).
   - Dedicated responsive mobile bottom navigation (`MobileBottomNav`), offline chat composer draft persistence, and Universal Links / App Links manifests (`.well-known`).
   - Capacitor 8 (`@messiah/mobile`) mobile wrapper configuration and tested bridge helpers (`mobileBridge.ts`) ready for Xcode (`iOS`/`iPadOS`) and Android Studio (`Android`) native signing and build generation.
3. **Cross-Device Approvals, Notification Channels & Audit Explorer**:
   - Unified Human-in-the-Loop approvals center (`/approvals` + `GET /api/v1/approvals`) aggregating MCP tools, Bridge actions, Swarm plans, and Workflow gates across devices.
   - Persistent `notification_items`, `notification_devices`, and `notification_preferences` (migration `10_notifications_push_and_sessions`), secret-scrubbed alert previews (`sanitizeNotificationPreview`), duplicate suppression (`dedupKey`), Web Push (`web-push`), WebSocket `workspace.subscribe`, notification drawer, and `/settings/notifications`.
   - Workspace security audit explorer at `/audit` (`GET /api/v1/audit-logs`).
4. **Production Hardening, Observability & Disaster Recovery**:
   - Fail-closed startup guardrails (`validateProductionSecurityConfig`), production strict CORS & Helmet HSTS/CSP, expanded Pino secret log redaction (`LOG_REDACT_PATHS`), and bearer-protected `/metrics` Prometheus exporter.
   - Multi-stage Dockerfiles (`server`, `worker`, `web`), `.dockerignore`, production Compose + Nginx + Prometheus stack (`infrastructure/production/`), `.env.{staging,production}.example`, and tested PostgreSQL 16 + `pgvector` backup/restore scripts.
   - Windows Win32 AppContainer C++ helper implementation (`apps/bridge-daemon/native/win-appcontainer-helper`) checked in fail-closed awaiting Windows compilation/signing.

---

## Known Platform & Signing Limitations

- **macOS Code Signing & Notarization**: Local `.app` and `.dmg` artifacts built unsigned; Apple Developer ID signing certificates and notarization credentials plus production `TAURI_SIGNING_PRIVATE_KEY` / public key provisioning are required before external end-user distribution.
- **Windows & Linux Desktop Binaries**: Packaging targets and CI workflow (`.github/workflows/ci-release.yml`) are configured cleanly, while native `.msi`/NSIS, `.AppImage`/`.deb`, and Windows AppContainer binary compilation must execute on Windows and Linux build runners respectively.
- **Linux Bubblewrap Validation**: Probed inside macOS Docker Desktop Linux container where `bwrap` failed closed due to disabled container unprivileged user namespaces; bare-metal Linux workstation verification with `kernel.unprivileged_userns_clone=1` and Secret Service remains pending.
- **iOS & Android Store Packages**: Native `.ipa` and `.aab`/`.apk` compilation requires full Xcode and Android SDK installations unavailable on this headless macOS host.
