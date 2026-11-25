import fs from "node:fs";
import path from "node:path";
import { SensitiveFilesGuard } from "../security/sensitiveFiles.js";

export class PathGuardError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "PathGuardError";
  }
}

export class PathGuard {
  /**
   * Resolves and validates a target relative path against an approved project root.
   * Enforces:
   * 1. No null bytes
   * 2. Unicode normalization (NFC)
   * 3. Parent directory traversal rejection (../)
   * 4. Realpath containment resolution (blocks symlink escapes)
   * 5. Sensitive credentials directory blocking
   */
  public static resolveAndValidate(
    allowedRoots: string[],
    rootPath: string,
    relativePath = ""
  ): string {
    // 1. Check for null bytes
    if (rootPath.includes("\0") || relativePath.includes("\0")) {
      throw new PathGuardError("NULL_BYTE_DETECTED", "Path contains null byte character.");
    }

    // 2. Unicode normalization (NFC)
    const normalizedRoot = path.resolve(rootPath.normalize("NFC"));
    const canonicalRoot = fs.existsSync(normalizedRoot)
      ? fs.realpathSync(normalizedRoot)
      : normalizedRoot;
    const normalizedRelative = relativePath.normalize("NFC");

    // 3. Verify rootPath is among allowed roots (comparing canonical paths)
    const canonicalAllowedRoots = allowedRoots.map((allowed) => {
      const p = path.resolve(allowed.normalize("NFC"));
      return fs.existsSync(p) ? fs.realpathSync(p) : p;
    });

    const isAllowedRoot = canonicalAllowedRoots.some((allowed) => {
      return canonicalRoot === allowed || canonicalRoot.startsWith(allowed + path.sep);
    });

    if (!isAllowedRoot) {
      throw new PathGuardError(
        "ROOT_NOT_ALLOWED",
        `Directory '${normalizedRoot}' is not in the list of approved project roots.`
      );
    }

    // 4. Combine and normalize target path
    const candidatePath = path.resolve(canonicalRoot, normalizedRelative);

    // Ensure candidate starts with root path
    if (!candidatePath.startsWith(canonicalRoot)) {
      throw new PathGuardError(
        "PATH_TRAVERSAL_DETECTED",
        `Target path '${candidatePath}' escapes approved root '${canonicalRoot}'.`
      );
    }

    // 5. Sensitive credential directory/file check BEFORE realpath
    const sensitiveCheck = SensitiveFilesGuard.isSensitivePath(candidatePath);
    if (sensitiveCheck.blocked) {
      throw new PathGuardError(
        "SENSITIVE_PATH_BLOCKED",
        sensitiveCheck.reason || "Access to sensitive file or credential path is blocked."
      );
    }

    // 6. If target file or directory exists, verify realpath canonical resolution (symlink escape defense)
    if (fs.existsSync(candidatePath)) {
      try {
        const canonicalRealpath = fs.realpathSync(candidatePath);
        if (!canonicalRealpath.startsWith(canonicalRoot)) {
          throw new PathGuardError(
            "SYMLINK_ESCAPE_DETECTED",
            `Symlink resolves to '${canonicalRealpath}', escaping approved root '${canonicalRoot}'.`
          );
        }
      } catch (err: unknown) {
        if (err instanceof PathGuardError) throw err;
        throw new PathGuardError("CANONICALIZATION_FAILED", `Failed to resolve realpath for '${candidatePath}'.`);
      }
    } else {
      // If parent exists, verify parent realpath
      const parentDir = path.dirname(candidatePath);
      if (fs.existsSync(parentDir)) {
        const canonicalParent = fs.realpathSync(parentDir);
        if (!canonicalParent.startsWith(canonicalRoot)) {
          throw new PathGuardError(
            "SYMLINK_ESCAPE_DETECTED",
            `Parent directory resolves to '${canonicalParent}', escaping approved root '${canonicalRoot}'.`
          );
        }
      }
    }

    return candidatePath;
  }
}
