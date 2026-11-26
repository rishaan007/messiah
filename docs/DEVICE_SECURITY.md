# Messiah Device Security Architecture & Boundaries

**Status**: Phase 4B Security Hardened & Verified  
**Applies to**: `apps/bridge-daemon`, `apps/server`, `apps/web`

---

## 1. Zero Inbound Port Security

The Messiah Local Agent Bridge daemon binds zero TCP or UDP listener sockets. All traffic flows over outbound-only TLS/WSS (`/api/v1/devices/connect`).

---

## 2. Cryptographic Identity & Native Keystore Implementations

1. **Device Ed25519 Identity**: Generated locally; private keys never leave the host. Public keys persist as SPKI PEM + SHA-256 fingerprint.
2. **Per-Platform Storage Backends**:
   - **macOS (`KeychainStore`)**: Uses native `/usr/bin/security` macOS Keychain (`com.messiah.bridge.device-identity`), independently verified on macOS ARM64.
   - **Windows (`WindowsCredentialStore`)**: Uses a **custom DPAPI-protected file** (`%APPDATA%\Messiah\bridge\device.dpapi`) encrypted via `ProtectedData.Protect(..., CurrentUser)` and locked down with `icacls /inheritance:r` user-only NTFS ACLs. Credentials are passed via environment variables to avoid PowerShell string-interpolation injection. *(Note: This uses DPAPI file encryption, NOT `CredWriteW` Windows Credential Manager vault.)*
   - **Linux (`LinuxSecretServiceStore`)**: Uses freedesktop.org Secret Service (`secret-tool`) when a D-Bus session is present; **fails closed** on headless Linux without a D-Bus session unless `MESSIAH_VAULT_PASSPHRASE` is set.
   - **Software Passphrase Vault v2 (`SecureFileKeystore`)**: AES-256-GCM with AAD `MESSIAH_DEVICE_KEYSTORE_V2`, 32-byte salt, and **600,000 iterations PBKDF2-HMAC-SHA512** (`0600` permissions). Incorrect passphrases never silently regenerate or overwrite an existing vault.

---

## 3. Pairing Token & Anti-Exposure Protections

- **Full 256-Bit Entropy**: Server generates 32 random bytes (`crypto.randomBytes(32)`) encoded as untruncated 43-character Base64URL (`MSH_<43-char-base64url>`), preserving exact Base64URL case during CLI submission.
- **Hashed Persistence & Masked CLI Input**: Only SHA-256(`token`) persists in Postgres. `messiah-bridge pair` prompts via masked stdin (`askSecret`) and never accepts tokens via CLI arguments or environment variables.

---

## 4. Phase 4B Execution & Containment Boundaries

- **Fail-Closed OS Sandboxing**: `ProcessSandbox` runs Seatbelt `(deny default)` on macOS, Bubblewrap namespaces on Linux, and fails closed (`SANDBOX_UNAVAILABLE`) when OS enforcement is unavailable (e.g. Windows without AppContainer helper).
- **TOCTOU-Resistant Filesystem Operations (`PathGuard` + `SafeFileOperations`)**: Uses segment-by-segment `lstatSync`, `O_NOFOLLOW`, hard-link (`nlink <= 1`) & mount checks, sibling-prefix separation, UNC/ADS rejection, exclusive temp files (`O_EXCL`), and pre-swap hash revalidation.
- **Sandboxed Local Stdio MCP**: Runs inside the same OS sandbox with `EnvAllowlist`, default-deny network, executable SHA-256 pinning, and `MCP_SCHEMA_CHANGED` detection.
