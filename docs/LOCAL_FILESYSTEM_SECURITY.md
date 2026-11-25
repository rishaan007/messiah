# Messiah Local Filesystem Security & PathGuard

**Status**: Phase 4B Implemented & Verified  
**Component**: `apps/bridge-daemon/src/filesystem/` (`PathGuard`, `SafeFileOperations`, `sensitiveFiles.ts`)

---

## 1. Canonical Path Containment (`PathGuard`)

Every filesystem operation passes through `PathGuard.resolveAndValidate(targetPath, allowedRoots, options)`:

1. **Null Byte & Malformed Input Rejection**: Paths containing `\0` or invalid control sequences are rejected immediately.
2. **Unicode Normalization**: Paths are normalized to `NFC` form before comparison to prevent homograph/decomposed traversal attacks.
3. **Allowed Roots Canonicalization**: Each configured root directory is resolved via `fs.realpathSync`. (Essential on macOS where `/var` symlinks to `/private/var`.)
4. **Symlink Escape Prevention**:
   - If the target file/directory exists, `fs.realpathSync(resolved)` resolves all intermediate and leaf symlinks before checking containment against canonical roots.
   - If creating a new file that does not yet exist, `PathGuard` walks upward to the nearest existing ancestor directory and verifies its `realpathSync` remains strictly inside an allowed root.
5. **Sensitive File Exclusion (`sensitiveFiles.ts`)**:
   Access to high-risk credential directories and files is blocked even if situated inside an allowed directory:
   - `.ssh/`, `.aws/`, `.gcp/`, `.gnupg/`, `.kube/`
   - `.env`, `.env.local`, `.env.production`
   - `*.pem`, `*.key`, `*.p12`, `*.kdbx`, macOS `.keychain`

---

## 2. Atomic Writes & Concurrent Drift Detection

`SafeFileOperations` guards against partial file corruption and race conditions:

- **Atomic Creation & Modification**: Modifications are written first to a hidden sibling temporary file (`.messiah-tmp-<uuid>`) in the same directory, synced, and atomically swapped into place via `fs.renameSync`.
- **Optimistic Concurrency Control**: `filesystem.modify` supports `expectedPreviousSha256`. Before overwriting, `SafeFileOperations` computes the current SHA-256 of the file on disk. If it mismatches, the write fails with `CONCURRENT_MODIFICATION_DRIFT`, preventing agents from clobbering concurrent user edits.
- **Line Diff Preview**: Every file mutation calculates a structured diff summary returned in the task output for cross-device code review.
