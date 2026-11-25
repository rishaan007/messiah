# Messiah Cross-Device Execution & Continuity

**Status**: Phase 4B Implemented & Verified  
**Supported Clients**: Web/PWA, macOS, Windows, Linux, iPhone, iPad, Android

---

## 1. Unified Multi-Device Workflow

Messiah decouples **control surface** from **execution host**. Any authorized device signed into the workspace (such as an iPhone or iPad on mobile data) can safely orchestrate work on a paired workstation (such as a MacBook Pro or Linux workstation at the office or home).

### End-to-End Flow:
1. **Workstation Pairing**: Developer pairs their workstation via `messiah-bridge pair` using an interactive masked 256-bit pairing token (`MSH_<43-char-base64url>`).
2. **Outbound Connectivity**: `messiah-bridge start` establishes an outbound TLS WebSocket session to `/api/v1/devices/connect` and reports capabilities and allowed roots.
3. **Cross-Device Targeting**: From any client (`ChatWorkspace`), the user selects their paired workstation from the **Target** dropdown.
4. **Execution & Review**: Tasks dispatch with signed authorization envelopes (`MESSIAH_TASK_AUTH:...`). Sensitive mutations pause in `AWAITING_APPROVAL`, rendering interactive approval cards across all authorized sessions.
5. **Audit Persistence**: All task inputs, approval decisions, diffs, exit codes, and `stdout`/`stderr` logs persist in PostgreSQL (`bridge_tasks`, `bridge_task_approvals`, `bridge_task_logs`) for synchronized review across all user devices.
