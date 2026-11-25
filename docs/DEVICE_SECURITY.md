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
   - **macOS**: Stored in the encrypted macOS Keychain (`com.messiah.bridge`) via `KeychainStore`.
   - **Windows**: Protected via Windows DPAPI and strict user-only ACLs (`WindowsCredentialStore`).
   - **Linux**: Protected via Linux Secret Service / `secret-tool` (`LinuxSecretServiceStore`); fails closed on headless sessions unless a user passphrase is supplied for the local encrypted vault.
   - **Software Vault Fallback (v2)**: Stored in an AES-256-GCM encrypted file vault (`~/.messiah/bridge/device.vault`) with AAD `MESSIAH_DEVICE_KEYSTORE_V2`, 32-byte salt, **600,000 iterations PBKDF2-HMAC-SHA512**, and POSIX `0600` permissions (with automatic backwards-compatible v1 migration).
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

## 5. Phase 4B Workstation Sandboxing & Execution Boundaries

Phase 4B introduces bounded local execution strictly governed by layered OS and cryptographic protections:
- **Zero Shell Interpolation**: All process execution uses argument arrays (`shell: false`). Arbitrary raw shell injection is structurally impossible.
- **Canonical Path Containment (`PathGuard`)**: Filesystem reads, searches, creations, edits, and deletions are restricted to administrator-approved project roots after resolving symlinks (`realpathSync`), blocking null bytes, and excluding `.ssh`, `.aws`, `.gcp`, `.env`, and keychains.
- **Signed Task Envelopes**: Workstations reject any task without a valid server signature (`MESSIAH_TASK_AUTH:...`), unexpired TTL, and unused 256-bit nonce (`ReplayGuard`).
- **Human-in-the-Loop Approvals**: Sensitive mutations and terminal operations require explicit approval (`BridgeTaskApproval`) from authorized `OWNER` or `ADMIN` workspace members.
