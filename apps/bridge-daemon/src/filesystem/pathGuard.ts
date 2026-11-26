import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SensitiveFilesGuard } from "../security/sensitiveFiles.js";

export class PathGuardError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "PathGuardError";
  }
}

export interface ValidatedTargetHandle {
  canonicalRoot: string;
  canonicalPath: string;
  relativePath: string;
  rootDev: number | bigint;
  parentIno?: number | bigint;
}

export class PathGuard {
  private static isPathWithinRoot(candidate: string, root: string): boolean {
    const isWin = os.platform() === "win32";
    const normCandidate = isWin ? candidate.toLowerCase() : candidate;
    const normRoot = isWin ? root.toLowerCase() : root;
    const rootWithSep = normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep;
    return normCandidate === normRoot || normCandidate.startsWith(rootWithSep);
  }

  /**
   * Rejects dangerous/unsupported path forms:
   * - Null bytes or control chars
   * - Windows UNC network paths (\\server\share or //server/share)
   * - Windows device namespace paths (\\?\, \\.\)
   * - Windows Alternate Data Streams (e.g. file.txt:stream)
   */
  public static assertSupportedPathSyntax(rawPath: string): void {
    if (/[\0\r\n]/.test(rawPath)) {
      throw new PathGuardError("NULL_BYTE_DETECTED", "Path contains null byte or control character.");
    }
    if (rawPath.startsWith("\\\\") || rawPath.startsWith("//")) {
      throw new PathGuardError("UNSUPPORTED_PATH_FORM", "UNC network and device namespace paths are prohibited.");
    }
    // Check Alternate Data Streams (colon outside valid Windows drive prefix like C:\)
    const colonIdx = rawPath.indexOf(":");
    if (colonIdx !== -1) {
      const isValidWinDrive = os.platform() === "win32" && colonIdx === 1 && /^[A-Za-z]:/.test(rawPath);
      if (!isValidWinDrive || rawPath.indexOf(":", colonIdx + 1) !== -1) {
        throw new PathGuardError("UNSUPPORTED_PATH_FORM", "Alternate Data Streams or invalid colon paths are prohibited.");
      }
    }
  }

  /**
   * Ensures an allowed root never spans the entire user home directory or filesystem root.
   */
  public static assertSafeApprovedRoot(rootPath: string): string {
    this.assertSupportedPathSyntax(rootPath);
    const resolved = path.resolve(rootPath.normalize("NFC"));
    const canonical = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;

    const home = fs.existsSync(os.homedir()) ? fs.realpathSync(os.homedir()) : path.resolve(os.homedir());
    const fsRoot = path.parse(canonical).root;

    const isWin = os.platform() === "win32";
    const eq = (a: string, b: string) => (isWin ? a.toLowerCase() === b.toLowerCase() : a === b);

    if (eq(canonical, home) || eq(canonical, fsRoot)) {
      throw new PathGuardError(
        "UNSAFE_APPROVED_ROOT",
        `Granting filesystem scope to entire home or filesystem root ('${canonical}') is prohibited.`
      );
    }

    return canonical;
  }

  /**
   * Walks every segment inside canonicalRoot using lstatSync (rejecting intermediate symlinks,
   * cross-device mounts, and hard links on leaf files) to defend against parent-directory
   * and leaf symlink replacement races.
   */
  public static validateSegmentsWithinRoot(
    canonicalRoot: string,
    candidatePath: string,
    allowMissingLeaf = false
  ): ValidatedTargetHandle {
    const rootStat = fs.lstatSync(canonicalRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new PathGuardError("INVALID_ROOT", `Approved root '${canonicalRoot}' is not a real directory.`);
    }

    const rel = path.relative(canonicalRoot, candidatePath);
    if (rel === "") {
      return {
        canonicalRoot,
        canonicalPath: canonicalRoot,
        relativePath: "",
        rootDev: rootStat.dev,
        parentIno: rootStat.ino,
      };
    }

    const segments = rel.split(path.sep).filter(Boolean);
    let current = canonicalRoot;
    let parentIno: number | bigint = rootStat.ino;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      if (seg === "." || seg === "..") {
        throw new PathGuardError("PATH_TRAVERSAL_DETECTED", `Invalid path traversal segment '${seg}'.`);
      }

      const next = path.join(current, seg);
      const isLast = i === segments.length - 1;

      // Check sensitive paths at every segment boundary
      const sensitiveCheck = SensitiveFilesGuard.isSensitivePath(next);
      if (sensitiveCheck.blocked) {
        throw new PathGuardError(
          "SENSITIVE_PATH_BLOCKED",
          sensitiveCheck.reason || "Access to sensitive file or credential path is blocked."
        );
      }

      if (!fs.existsSync(next)) {
        if (allowMissingLeaf) {
          // If intermediate parents don't exist yet for create, stop at nearest existing ancestor
          return {
            canonicalRoot,
            canonicalPath: candidatePath,
            relativePath: rel,
            rootDev: rootStat.dev,
            parentIno,
          };
        }
        throw new PathGuardError("PATH_NOT_FOUND", `Path does not exist: '${next}'.`);
      }

      const st = fs.lstatSync(next);
      // Reject ANY symlink / reparse point inside the operation path
      if (st.isSymbolicLink()) {
        throw new PathGuardError(
          "SYMLINK_ESCAPE_DETECTED",
          `Untrusted symbolic link or reparse point rejected at '${next}'.`
        );
      }
      // Reject mount-point traversal crossing filesystem boundaries
      if (st.dev !== rootStat.dev) {
        throw new PathGuardError(
          "MOUNT_CROSSING_DETECTED",
          `Path '${next}' crosses filesystem mount boundary (dev ${st.dev} !== ${rootStat.dev}).`
        );
      }
      // Reject hard-linked regular files (nlink > 1) that could alias files outside root
      if (st.isFile() && st.nlink > 1) {
        throw new PathGuardError(
          "HARD_LINK_DETECTED",
          `Hard-linked file rejected (nlink=${st.nlink}) at '${next}' to prevent out-of-root aliasing.`
        );
      }

      if (!isLast) {
        if (!st.isDirectory()) {
          throw new PathGuardError("NOT_A_DIRECTORY", `Intermediate segment '${next}' is not a directory.`);
        }
        parentIno = st.ino;
      }

      current = next;
    }

    return {
      canonicalRoot,
      canonicalPath: current,
      relativePath: rel,
      rootDev: rootStat.dev,
      parentIno,
    };
  }

  /**
   * Resolves and validates a target relative path against approved project roots.
   */
  public static resolveAndValidate(
    allowedRoots: string[],
    rootPath: string,
    relativePath = "",
    options?: { allowMissingLeaf?: boolean }
  ): string {
    this.assertSupportedPathSyntax(rootPath);
    this.assertSupportedPathSyntax(relativePath);

    const normalizedRoot = path.resolve(rootPath.normalize("NFC"));
    const canonicalRoot = fs.existsSync(normalizedRoot)
      ? fs.realpathSync(normalizedRoot)
      : normalizedRoot;
    const normalizedRelative = relativePath.normalize("NFC");

    // Verify rootPath is within allowed roots and none span full home/fs root
    const canonicalAllowedRoots = allowedRoots.map((allowed) => this.assertSafeApprovedRoot(allowed));

    const isAllowedRoot = canonicalAllowedRoots.some((allowed) => this.isPathWithinRoot(canonicalRoot, allowed));

    if (!isAllowedRoot) {
      throw new PathGuardError(
        "ROOT_NOT_ALLOWED",
        `Directory '${normalizedRoot}' is not in the list of approved project roots.`
      );
    }

    if (!fs.existsSync(canonicalRoot)) {
      throw new PathGuardError("ROOT_NOT_FOUND", `Approved root directory '${canonicalRoot}' does not exist.`);
    }

    const candidatePath = path.resolve(canonicalRoot, normalizedRelative);

    // Proper boundary check with path.sep (prevents sibling prefix /root vs /root-evil)
    if (!this.isPathWithinRoot(candidatePath, canonicalRoot)) {
      throw new PathGuardError(
        "PATH_TRAVERSAL_DETECTED",
        `Target path '${candidatePath}' escapes approved root '${canonicalRoot}'.`
      );
    }

    const sensitiveCheck = SensitiveFilesGuard.isSensitivePath(candidatePath);
    if (sensitiveCheck.blocked) {
      throw new PathGuardError(
        "SENSITIVE_PATH_BLOCKED",
        sensitiveCheck.reason || "Access to sensitive file or credential path is blocked."
      );
    }

    // Walk segments strictly (blocking symlinks, mounts, hard links, and parent races)
    const validated = this.validateSegmentsWithinRoot(
      canonicalRoot,
      candidatePath,
      options?.allowMissingLeaf ?? true
    );

    return validated.canonicalPath;
  }
}
