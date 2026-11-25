# Messiah Device Pairing Protocol & Governance

**Status**: Phase 4A Implemented & Verified  
**Endpoints**:
- Web Initiation: `POST /api/v1/devices/pair/initiate`
- CLI Claim: `POST /api/v1/devices/pair/claim`
- Web Pending List: `GET /api/v1/devices/pending`
- Web Approval: `POST /api/v1/devices/pair/approve`
- Web Rejection: `POST /api/v1/devices/pair/reject`

---

## 1. Overview & Threat Model

Pairing is the security boundary where an unauthenticated physical machine is registered and associated with a specific Messiah Workspace. 

### Threats Mitigated:
1. **Unauthorized Device Association**: Rogue machines claiming workspace association without administrative consent.
2. **Brute-Force Enumeration**: Attackers guessing short numeric PIN codes.
3. **Challenge Interception & Replay**: Re-submitting claimed or consumed pairing tokens.
4. **Data Breaches & Code Leaks**: Database dumps exposing active pairing codes.
5. **Cross-Tenant IDOR**: Non-members approving or inspecting devices of other workspaces.

---

## 2. Pairing Sequence & State Machine

```
   [ Admin in Web Dashboard ]                       [ Bridge Daemon CLI ]
                |                                             |
  1. POST /devices/pair/initiate                              |
     (Requires OWNER or ADMIN)                                |
                |                                             |
                v                                             |
     Returns 256-bit Code                                     |
     "MSH-B4E8-29FA-881C"                                     |
     (Only SHA-256 stored in DB)                              |
                |                                             |
                +--- User copies code to CLI workstation ---> |
                                                              |
                                                2. messiah-bridge pair MSH-...
                                                   - Generates Ed25519 Keypair
                                                   - Computes SHA256 Fingerprint
                                                   - POST /devices/pair/claim
                                                              |
                <--- Challenge marked CLAIMED ----------------+
                     Device created as PENDING_APPROVAL
                |
  3. Dashboard shows Device Card:
     - Name: "Rishaan's MacBook Pro"
     - OS: macOS arm64 (Bridge v0.1.0)
     - Fingerprint: SHA256:7f83...
                |
  4. Admin reviews & clicks "Approve":
     POST /devices/pair/approve
                |
                v
     PostgreSQL Transaction:
     - Challenge -> CONSUMED
     - Device -> ACTIVE
                |
                v
  5. Bridge Daemon connects via WSS (/api/v1/devices/connect)
```

---

## 3. Protocol Rules & Technical Guarantees

### A. Full 256-Bit Pairing Secret & Masked CLI Input
- The pairing code is generated using 32 cryptographically strong random bytes (`crypto.randomBytes(32)`) encoded as a full 43-character Base64URL string prefixed with `MSH_` (i.e. `MSH_<43-char-base64url>`), preserving genuine 256-bit entropy.
- **No CLI Argument/Env Secret Exposure**: `messiah-bridge pair` prompts interactively via masked terminal input (`askSecret`) rather than accepting the pairing token as a command-line argument or environment variable, preventing exposure in `ps`, shell history, or system logs.
- The plaintext token is returned **once and only once** in the HTTP response of `/pair/challenge`.
- Only the **SHA-256 hash** of the token (`challengeHash`) is persisted in the PostgreSQL database. Even with full database access, active codes cannot be recovered.

### B. Time-To-Live (TTL) & Rate Limiting
- **Expiration Window**: 5 minutes (300,000 ms). Expired challenges are rejected with HTTP 400 `CHALLENGE_EXPIRED`.
- **Brute Force Protection**: Each challenge tracks `failedAttempts`. After 5 incorrect attempts, the challenge is immediately invalidated with status `EXPIRED`.
- Global IP rate limiting applies to the public `/pair/claim` endpoint (10 requests per minute).

### C. Public Key Fingerprint Re-Verification
When the CLI calls `/pair/claim`, it supplies:
- `pairingCode`: Plaintext code string.
- `deviceName`: Human-readable device name.
- `publicKey`: SPKI PEM string.
- `publicKeyFingerprint`: SHA-256 hex string.
- `platform`: `darwin` | `linux` | `win32`.
- `architecture`: `arm64` | `x64`.
- `bridgeVersion`: Daemon semantic version.

The server independently computes the SPKI DER SHA-256 hash of the incoming PEM. If it does not match the provided `publicKeyFingerprint`, the claim is rejected with HTTP 400 `INVALID_FINGERPRINT`.

### D. Role-Based Access Control (RBAC) & Governance
- Initiating a pairing challenge requires `OWNER` or `ADMIN` role in the workspace.
- Approving or rejecting a pending device requires `OWNER` or `ADMIN` role in the workspace.
- Regular `MEMBER` and `VIEWER` roles attempting initiation, approval, or rejection receive HTTP 403 `FORBIDDEN_ROLE`.
- Non-workspace users attempting any access receive HTTP 404 anti-IDOR errors.

### E. Atomic Consumption
Approval executes inside a PostgreSQL ACID transaction:
```typescript
await prisma.$transaction(async (tx) => {
  // 1. Lock and verify challenge is in CLAIMED state
  // 2. Transition challenge to CONSUMED
  // 3. Transition device to ACTIVE
});
```
This ensures zero race conditions or double-activation of devices.
