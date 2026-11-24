# Messiah Device Security Architecture & Boundaries

**Status**: Phase 4A Implemented & Verified  
**Applies to**: `apps/bridge-daemon`, `apps/server`, `apps/web`

---

## 1. Zero Inbound Port Security

A foundational security requirement for enterprise and workstation deployment is that the software must never turn a user's computer into a listening server.

- **Zero Listening Ports**: The Messiah Local Agent Bridge daemon binds zero TCP or UDP listener sockets.
- **Firewall & NAT Transparency**: Because the connection is outbound-only over standard TLS/WSS (`443`), it traverses corporate firewalls, NAT routers, and VPNs seamlessly without port forwarding or UPnP punch-throughs.
- **No Local Web Services**: The daemon does not expose local HTTP servers or IPC sockets accessible to malicious local software running under other user accounts.

---

## 2. Cryptographic Security & Private Key Containment

1. **Local Key Generation**:
   - Ed25519 keypairs are generated directly on the target host using cryptographically secure PRNG.
   - Private keys are never transmitted over the network under any circumstance—not during pairing, handshake, diagnostics, or synchronization.
2. **Keystore Protection**:
   - **macOS**: Stored in the encrypted macOS Keychain (`com.messiah.bridge`).
   - **Linux & Windows**: Stored in an AES-256-GCM encrypted file vault (`~/.messiah/bridge/device.vault`) using PBKDF2 key derivation with 100,000 iterations and POSIX `0600` permissions.
3. **Public Key SPKI Fingerprint**:
   - The cloud database only stores the SPKI PEM public key and its SHA-256 binary DER hash.
   - A compromise of the cloud database cannot expose private keys or compromise workstation integrity.

---

## 3. Replay Protection & Nonce Validation

Every WebSocket connection challenge is protected against replay attacks:
1. **Fresh Nonce**: The server generates a high-entropy 256-bit cryptographically random nonce for every challenge.
2. **Ephemeral TTL**: Challenges expire in strictly 30 seconds (`expiresAt`).
3. **Canonical Domain Separation**: Signatures bind the `deviceId`, `challengeId`, `nonce`, `serverAudience`, and `protocolVersion`. A signature generated for one challenge or server audience cannot be repurposed or replayed.
4. **Single-Use Challenge**: Once validated or expired, the ephemeral challenge is immediately purged from memory.

---

## 4. Multi-Tenant Workspace Isolation (Anti-IDOR)

Messiah enforces strict workspace-level isolation for all device operations:
- Every `BridgeDevice` and `DevicePairingChallenge` record is strictly scoped to a `workspace_id`.
- API endpoints require standard Bearer JWT authentication and verify that the calling user is a member of the workspace with sufficient RBAC permissions (`OWNER` or `ADMIN`).
- Cross-workspace queries are rejected with HTTP 404 anti-IDOR responses, preventing attackers from probing the existence of devices or pairing codes in other organizations.

---

## 5. Strict Phase 4A Boundary Enforcement

Phase 4A is strictly dedicated to **Bridge Foundation & Secure Device Connectivity**. 

To maintain security and integrity, the following boundaries are strictly enforced:
- **NO Command Execution**: No shell, subprocess, exec, or bash execution endpoints exist.
- **NO Filesystem Manipulation**: No reading, writing, or listing of local workstation files.
- **NO Child Process Spawning**: No local stdio MCP server spawning or process management.
- **NO Remote Desktop / Screen Inspection**: No screen capture, virtual keyboard, or mouse injection.
- **NO Browser Automation**: No local Chromium / Playwright driver processes.

These capabilities are reserved for future phases (Phase 4B+) and will be governed by explicit user approval cards, execution sandboxes, and granular workspace permission policies.
