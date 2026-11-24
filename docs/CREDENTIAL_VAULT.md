# MESSIAH — Encrypted Credential Vault Specification

## 1. Overview & Threat Model

MESSIAH acts as the central workspace coordinator across external AI providers. To orchestrate LLM requests on behalf of users, workspace credentials (such as API keys and organization identifiers) must be stored persistently while adhering to zero-trust storage standards.

### Core Guarantees
1. **Zero Plaintext Storage**: Plaintext secrets are never stored on disk, written to database columns, serialized in error traces, or printed in application logs.
2. **Authenticated Encryption**: All secrets are encrypted using authenticated encryption (`AES-256-GCM`). Any ciphertext tampering or truncation fails decryption with an explicit error.
3. **Never Returned to Frontend**: After initial connection creation, the API key is never serialized or returned in any API response or UI view.
4. **Tenant Isolation**: Encrypted credentials are strictly scoped to a `ProviderConnection` which is owned by a specific `Workspace`. Cross-workspace access is forbidden at both the database and service layers.
5. **Key Versioning & Rotation Support**: Ciphertext payloads encapsulate key version IDs (`v1`), enabling transparent re-encryption when primary keys are rotated.

---

## 2. Cryptographic Architecture

### Algorithm: AES-256-GCM (Authenticated Encryption with Associated Data)
- **Cipher**: `aes-256-gcm`
- **Key Length**: 256 bits (32 bytes), represented as a 64-character hexadecimal string in environment/KMS configuration.
- **Initialization Vector (IV)**: 12 bytes (96 bits) securely generated per encryption event using Node.js `crypto.randomBytes(12)`. IVs are never reused.
- **Authentication Tag**: 16 bytes (128 bits), computed by the GCM cipher to guarantee ciphertext authenticity and integrity.
- **Additional Authenticated Data (AAD)**: Optional contextual binding (e.g. workspace ID or connection ID) to cryptographically prevent ciphertext swapping between entities.

### Ciphertext Payload Structure
The resulting encrypted artifact stored in the `EncryptedCredential` database table:

```json
{
  "keyVersion": "v1",
  "iv": "<hex-encoded 12 bytes>",
  "tag": "<hex-encoded 16 bytes>",
  "ciphertext": "<hex-encoded encrypted payload>"
}
```

Stored alongside metadata:
- `secretType`: `"API_KEY"` | `"OAUTH_REFRESH_TOKEN"` | `"SERVICE_ACCOUNT"`
- `algorithm`: `"AES-256-GCM"`
- `fingerprint`: First 6 chars + `"..."` + last 4 chars (e.g., `sk-ant...90ab`) for safe UI identification without secret disclosure.
- `lastRotatedAt`: Timestamp of the latest credential rotation.

---

## 3. KMS Abstraction Layer (`IKmsService`)

MESSIAH decouples the cryptographic engine from the key management implementation:

```typescript
export interface IKmsService {
  getActiveKeyId(): string;
  getKey(keyId: string): Buffer;
}
```

### Implementations:
1. **`LocalKmsService`** (Current Phase 2A):
   - Reads `VAULT_ENCRYPTION_KEY` from validated server environment variables.
   - Validates that the key is exactly 32 bytes (64 hex characters).
   - Serves key version `v1` as the active key.
2. **`CloudKmsService`** (Production Cloud Target):
   - AWS KMS, GCP Cloud KMS, or HashiCorp Vault integration.
   - Leverages envelope encryption where the database stores data encryption keys (DEK) encrypted by a cloud-managed Key Encryption Key (KEK).

---

## 4. Key Rotation Procedure

To rotate the root encryption key:
1. Configure secondary key in the KMS registry:
   - `VAULT_KEY_V1`: existing key
   - `VAULT_KEY_V2`: new 256-bit key
   - Active key ID set to `v2`.
2. All new credentials encrypted with `v2`.
3. Background migration job reads credentials where `keyVersion === 'v1'`, decrypts with `v1`, re-encrypts with `v2`, and updates the record transactionally with an updated `lastRotatedAt` timestamp.
4. Once all records are upgraded to `v2`, `v1` is permanently retired.

---

## 5. Security & Sanitization Controls

- **Audit Logging**: Any credential lifecycle action (`CREDENTIAL_CREATE`, `CREDENTIAL_UPDATE`, `CREDENTIAL_DELETE`, `CONNECTION_TEST`) emits a structured audit record via `AuditService`. The payload is strictly scrubbed through `sanitizeAuditDetails()`:
  ```typescript
  export function sanitizeAuditDetails(details: Record<string, unknown>): Record<string, unknown> {
    // Redacts any key matching /key|secret|token|password|auth|credential/i
  }
  ```
- **Error Protection**: Decryption failures produce a uniform `VaultError("Decryption failed or ciphertext was tampered with", "DECRYPTION_FAILED")` without leaking raw error internals to API clients.
