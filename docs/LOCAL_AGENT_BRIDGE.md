# Messiah Local Agent Bridge Architecture

**Status**: Phase 4A Implemented & Verified  
**Package**: `apps/bridge-daemon` (`@messiah/bridge-daemon`)  
**Tagline**: *One intelligence layer. Every agent. Every device.*

---

## 1. Overview & Purpose

The Messiah Local Agent Bridge is a lightweight, background daemon designed to run on user workstations and servers (macOS ARM64/x64, Linux x64/ARM64, Windows x64/ARM64). It acts as the secure edge execution node connecting a user's machine to the Messiah AI Agent Workspace.

In Phase 4A, the Bridge establishes the **foundational secure communication plane**:
- **Outbound-Only Connectivity**: Strictly connects outward via TLS/WSS to Messiah Cloud. The Bridge never binds to or exposes inbound TCP/UDP ports on the user's computer.
- **Cryptographic Device Binding**: Uses an Ed25519 keypair generated on the machine, stored exclusively in the OS-backed secure credential store (macOS Keychain / AES-256-GCM encrypted vault with `0600` permissions).
- **Zero Remote Execution (Phase 4A Bound)**: Purely handles pairing, cryptographic authentication, and bidirectional heartbeat maintenance. No command execution, terminal sessions, child process spawning, filesystem manipulation, or remote desktop capabilities are enabled in Phase 4A.

```
+-------------------------------------------------------------------------+
|                              USER MACHINE                               |
|                                                                         |
|  +-------------------------------------------------------------------+  |
|  |                 apps/bridge-daemon (messiah-bridge)               |  |
|  |                                                                   |  |
|  |  +--------------------+  +------------------+  +---------------+  |  |
|  |  |   Ed25519 Keystore |  |  Pairing Client  |  | Bridge Client |  |  |
|  |  | (Keychain / Vault) |  |   (CLI Claim)    |  | (WSS Client)  |  |  |
|  |  +--------------------+  +------------------+  +---------------+  |  |
|  |           |                       |                    |          |  |
|  +-----------|-----------------------|--------------------|----------+  |
+--------------|-----------------------|--------------------|-------------+
               |                       |                    |
               |                       | Outbound HTTPS     | Outbound WSS
               |                       | (/api/v1/devices/  | (/api/v1/devices/
               |                       |  pair/claim)       |  connect)
               v                       v                    v
+-------------------------------------------------------------------------+
|                             MESSIAH CLOUD                               |
|                                                                         |
|  +-----------------------+  +-------------------+  +-----------------+  |
|  | DevicePairingService  |  |  DevicePresence   |  | DeviceGateway   |  |
|  |  (Hash & Rate Limit)  |  | (Redis Ephemeral) |  | (Challenge-Auth)|  |
|  +-----------------------+  +-------------------+  +-----------------+  |
|                                                                         |
|  +-----------------------+  +---------------------------------------+  |
|  | PostgreSQL (Prisma)   |  | Real-Time Web Workspace (apps/web)   |  |
|  |  - BridgeDevice       |  |  - Admin Approval / Revocation Cards  |  |
|  |  - PairingChallenge   |  |  - Live Heartbeat Pulse Indicator     |  |
|  +-----------------------+  +---------------------------------------+  |
+-------------------------------------------------------------------------+
```

---

## 2. CLI Command Surface

The Bridge provides a modular command-line interface via `messiah-bridge` (or `pnpm --filter @messiah/bridge-daemon dev` in development):

### `messiah-bridge pair <code>`
- Reads or creates the local device Ed25519 identity.
- Computes the SHA-256 public key fingerprint.
- Submits an HTTP POST claim to `/api/v1/devices/pair/claim` with the 256-bit human-readable pairing code (format `MSH-XXXX-XXXX-XXXX`).
- Saves device registration details to `~/.messiah/bridge/config.json` in state `PENDING_APPROVAL`.
- Notifies the user to approve the pairing in the Messiah Web Dashboard.

### `messiah-bridge start`
- Verifies that the device is paired and configured.
- Loads the private key securely from the OS keystore.
- Connects via outbound WSS to `/api/v1/devices/connect`.
- Responds to the server's cryptographic challenge (`device.challenge`) with an Ed25519 signature proof (`device.auth.proof`).
- Upon receiving `device.auth.success`, initiates the 15-second heartbeat ping loop.
- Manages exponential backoff with jitter on network disconnections.

### `messiah-bridge status`
- Inspects local keystore presence, device ID, public key fingerprint, active configuration, and local daemon status.

### `messiah-bridge diagnostics`
- Runs self-diagnostics:
  1. Validates local OS environment, architecture, Node.js version, and available memory.
  2. Tests keystore read/write/delete integrity.
  3. Verifies network connectivity and DNS resolution to the Messiah server endpoint.

### `messiah-bridge unpair`
- Prompts for confirmation and cleans up local `config.json` and device credentials from the keystore.

---

## 3. Daemon Lifecycle & Process Architecture

1. **Bootstrap Phase**:
   - `BridgeClient` validates configuration and verifies that the private key exists.
   - Sets up POSIX signal listeners (`SIGINT`, `SIGTERM`) for graceful teardown.
2. **Handshake Phase**:
   - Opens WebSocket connection to Messiah Cloud.
   - Enforces 64KB maximum incoming frame size.
   - Waits for `device.challenge` containing `challengeId`, `nonce`, `serverAudience`, `protocolVersion`, and `expiresAt` (30s TTL).
   - Signs canonical authentication string `MESSIAH_DEVICE_AUTH:<deviceId>:<challengeId>:<nonce>:<serverAudience>:<protocolVersion>:<expiresAt>` using the private Ed25519 key.
   - Transmits `device.auth.proof` within the timeout window.
3. **Active Connection Phase**:
   - Server validates signature against stored SPKI public key and confirms device status is `ACTIVE`.
   - Server returns `device.auth.success`.
   - Daemon starts a 15-second interval timer sending `device.heartbeat` frames.
   - Server responds with `device.heartbeat.ack` and refreshes Redis presence (`TTL: 45 seconds`).
4. **Resilience & Reconnection**:
   - Disconnections trigger exponential backoff reconnection:
     $$\Delta t = \min(30000, 1000 \times 1.8^n) + \text{jitter}(0, 1000\text{ ms})$$
   - Automatic reconnect is immediately aborted if the server returns non-retryable close codes:
     - `4401`: `DEVICE_AUTHENTICATION_FAILED` (tampered key or invalid signature)
     - `4403`: `DEVICE_UNAUTHORIZED` (device paused or unapproved)
     - `4404`: `DEVICE_NOT_FOUND`
     - `4410`: `DEVICE_REVOKED`
5. **Teardown Phase**:
   - On shutdown signal, daemon sends clean disconnect, clears intervals, closes socket with code `1000 Normal Closure`, and releases memory.

---

## 4. Multi-Platform Support Matrix

| OS Target | Architecture | Daemon Support | Keystore Backend | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **macOS** | Apple Silicon (`arm64`) | Supported | macOS Keychain / AES Vault | Native security CLI integration |
| **macOS** | Intel (`x64`) | Supported | macOS Keychain / AES Vault | Native security CLI integration |
| **Linux** | `x64` / `arm64` | Supported | Secure AES-256-GCM Vault | Enforces `0600` file permissions |
| **Windows** | `x64` / `arm64` | Supported | Secure AES-256-GCM Vault | Protected application data path |
| **iOS / iPadOS** | ARM | Web / PWA only | WebAuthn / Session | Device management & chat UI |
| **Android** | ARM / x64 | Web / PWA only | WebAuthn / Session | Device management & chat UI |
