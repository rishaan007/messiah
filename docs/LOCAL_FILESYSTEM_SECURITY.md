# Messiah Local Filesystem Security & PathGuard

**Status**: Phase 4B Security Hardened & Verified  
**Component**: `apps/bridge-daemon/src/filesystem/` (`PathGuard`, `SafeFileOperations`, `sensitiveFiles.ts`)

---

## 1. Race-Resistant Canonical Containment (`PathGuard`)

Every filesystem operation passes through `PathGuard`:

1. **Syntax & Unsupported Path Rejection**:
   - Rejects null bytes (`\0`) and control characters (`\r`, `\n`).
   - Rejects Windows UNC network paths (`\\server\share`, `//server/share`) and device namespace paths (`\\?\`, `\\.\`).
   - Rejects Windows Alternate Data Streams (`file.txt:stream`).
2. **Home / Root Scope Guard**: Refuses to approve `os.homedir()` or filesystem root (`/`, `C:\`) as project roots (`UNSAFE_APPROVED_ROOT`).
3. **Sibling-Prefix Boundary Separation**: Enforces `candidate === root || candidate.startsWith(root + path.sep)` (case-insensitive on Windows), preventing `/approved-root-evil` sibling escapes.
4. **Segment-by-Segment `lstatSync` Traversal**:
   - Walks every path component inside the approved root using `lstatSync`.
   - Rejects any intermediate or leaf symbolic link / reparse point (`SYMLINK_ESCAPE_DETECTED`).
   - Rejects filesystem mount crossings (`st.dev !== rootStat.dev` -> `MOUNT_CROSSING_DETECTED`).
   - Rejects hard-linked regular files (`st.nlink > 1` -> `HARD_LINK_DETECTED`).
5. **Sensitive Path Defense-in-Depth**: Even inside allowed folders, `.ssh`, `.aws`, `.gcp`, `.azure`, `.kube`, `.gnupg`, `.env.*`, `.kdbx`, `.keychain`, and `device.vault`/`device.dpapi` are blocked (`SENSITIVE_PATH_BLOCKED`).

---

## 2. Handle Validation, `O_NOFOLLOW`, Atomic Writes & Drift Detection

`SafeFileOperations` guards against TOCTOU race conditions during I/O:

- **`O_NOFOLLOW` Descriptor Opening**: Opens existing regular files using `fs.promises.open(path, flags | O_NOFOLLOW)`, checking `fstat` (`isFile()`, `nlink <= 1`) and re-verifying segments post-open.
- **Exclusive Temporary Files & Revalidation**: `createFile` and `modifyFile` create temporary files inside the validated directory via `O_CREAT | O_EXCL | O_NOFOLLOW` while preserving original file permissions.
- **Pre-Commit Hash & Inode Revalidation**: Immediately before `fs.promises.rename`, `modifyFile` re-verifies target `lstat` (no symlink appeared, `ino` unchanged) and rechecks `expectedPreviousSha256` (`CONCURRENT_MODIFICATION_DETECTED`).
- **Safe Deletion**: `deleteFile` never blindly removes across symlinks; directories are walked entry-by-entry with `lstat` rejecting symlinks before `unlink`/`rmdir`.
