import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PathGuard, PathGuardError } from "./pathGuard.js";

export interface FileEntryInfo {
  name: string;
  path: string;
  isDirectory: boolean;
  sizeBytes: number;
  modifiedAt: string;
}

export interface FileDiffResult {
  filePath: string;
  previousHash: string | null;
  newHash: string;
  hasChanged: boolean;
  diffText: string;
}

const NOFOLLOW_FLAG = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;

export class SafeFileOperations {
  public static computeFileHash(content: string | Buffer): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  /**
   * Opens a validated file using O_NOFOLLOW and verifies via fstat that the opened file descriptor
   * is a regular file on the expected device and not hard-linked (nlink <= 1).
   */
  private static async openValidatedRegularFile(
    allowedRoots: string[],
    rootPath: string,
    relativePath: string,
    flags: number
  ): Promise<{ fh: fs.promises.FileHandle; targetFile: string; canonicalRoot: string }> {
    const targetFile = PathGuard.resolveAndValidate(allowedRoots, rootPath, relativePath, {
      allowMissingLeaf: false,
    });
    const canonicalRoot = PathGuard.resolveAndValidate(allowedRoots, rootPath, "");

    const fh = await fs.promises.open(targetFile, flags | NOFOLLOW_FLAG);
    try {
      const fstat = await fh.stat();
      if (fstat.isDirectory()) {
        throw new PathGuardError("IS_A_DIRECTORY", `Path '${targetFile}' is a directory.`);
      }
      if (!fstat.isFile()) {
        throw new PathGuardError("NOT_A_REGULAR_FILE", `Path '${targetFile}' is not a regular file.`);
      }
      if (fstat.nlink > 1) {
        throw new PathGuardError("HARD_LINK_DETECTED", `Refusing hard-linked file (nlink=${fstat.nlink}).`);
      }

      // Re-verify post-open that path segments and parent directory weren't swapped during open
      PathGuard.validateSegmentsWithinRoot(canonicalRoot, targetFile, false);
      return { fh, targetFile, canonicalRoot };
    } catch (err) {
      await fh.close().catch(() => {});
      throw err;
    }
  }

  public static async listDirectory(
    allowedRoots: string[],
    rootPath: string,
    relativePath = ""
  ): Promise<FileEntryInfo[]> {
    const targetDir = PathGuard.resolveAndValidate(allowedRoots, rootPath, relativePath, {
      allowMissingLeaf: false,
    });

    const stat = await fs.promises.lstat(targetDir);
    if (stat.isSymbolicLink()) {
      throw new PathGuardError("SYMLINK_ESCAPE_DETECTED", `Directory '${targetDir}' is a symbolic link.`);
    }
    if (!stat.isDirectory()) {
      throw new PathGuardError("NOT_A_DIRECTORY", `Path '${targetDir}' is not a directory.`);
    }

    const dirents = await fs.promises.readdir(targetDir, { withFileTypes: true });
    const results: FileEntryInfo[] = [];

    for (const ent of dirents) {
      if (ent.name === ".git") continue;
      if (ent.isSymbolicLink()) continue; // Never expose or traverse symlinks

      const fullChildPath = path.join(targetDir, ent.name);
      try {
        const childStat = await fs.promises.lstat(fullChildPath);
        if (childStat.isSymbolicLink()) continue;
        results.push({
          name: ent.name,
          path: path.relative(rootPath, fullChildPath),
          isDirectory: childStat.isDirectory(),
          sizeBytes: childStat.size,
          modifiedAt: childStat.mtime.toISOString(),
        });
      } catch {}
    }

    return results;
  }

  public static async readFile(
    allowedRoots: string[],
    rootPath: string,
    relativePath: string,
    maxBytes = 1048576
  ): Promise<{ content: string; hash: string; sizeBytes: number }> {
    const { fh } = await this.openValidatedRegularFile(
      allowedRoots,
      rootPath,
      relativePath,
      fs.constants.O_RDONLY
    );

    try {
      const fstat = await fh.stat();
      if (fstat.size > maxBytes) {
        throw new PathGuardError(
          "FILE_TOO_LARGE",
          `File size (${fstat.size} bytes) exceeds limit of ${maxBytes} bytes.`
        );
      }
      const buffer = await fh.readFile();
      const content = buffer.toString("utf-8");
      const hash = this.computeFileHash(buffer);
      return { content, hash, sizeBytes: fstat.size };
    } finally {
      await fh.close().catch(() => {});
    }
  }

  public static async searchFiles(
    allowedRoots: string[],
    rootPath: string,
    query: string,
    maxResults = 50
  ): Promise<Array<{ path: string; lineNumber: number; lineContent: string }>> {
    const validatedRoot = PathGuard.resolveAndValidate(allowedRoots, rootPath, "", {
      allowMissingLeaf: false,
    });
    const rootDev = fs.lstatSync(validatedRoot).dev;
    const results: Array<{ path: string; lineNumber: number; lineContent: string }> = [];

    async function walk(dir: string) {
      if (results.length >= maxResults) return;

      const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const ent of dirents) {
        if (results.length >= maxResults) break;
        if (ent.name === ".git" || ent.name === "node_modules" || ent.name === ".next") continue;
        if (ent.isSymbolicLink()) continue; // Never follow symlinks

        const fullPath = path.join(dir, ent.name);
        try {
          const st = await fs.promises.lstat(fullPath);
          if (st.isSymbolicLink() || st.dev !== rootDev) continue;

          if (st.isDirectory()) {
            await walk(fullPath);
          } else if (st.isFile() && st.nlink <= 1) {
            if (st.size > 500_000) continue;
            const fh = await fs.promises.open(fullPath, fs.constants.O_RDONLY | NOFOLLOW_FLAG);
            try {
              const content = (await fh.readFile()).toString("utf-8");
              const lines = content.split("\n");
              for (let i = 0; i < lines.length; i++) {
                if (results.length >= maxResults) break;
                if (lines[i]!.includes(query)) {
                  results.push({
                    path: path.relative(validatedRoot, fullPath),
                    lineNumber: i + 1,
                    lineContent: lines[i]!.trim().slice(0, 200),
                  });
                }
              }
            } finally {
              await fh.close().catch(() => {});
            }
          }
        } catch {}
      }
    }

    await walk(validatedRoot);
    return results;
  }

  /**
   * Creates a new file atomically within the validated directory boundary using O_CREAT | O_EXCL | O_NOFOLLOW.
   */
  public static async createFile(
    allowedRoots: string[],
    rootPath: string,
    relativePath: string,
    content: string
  ): Promise<{ path: string; hash: string; sizeBytes: number }> {
    const targetFile = PathGuard.resolveAndValidate(allowedRoots, rootPath, relativePath, {
      allowMissingLeaf: true,
    });
    const canonicalRoot = PathGuard.resolveAndValidate(allowedRoots, rootPath, "");

    if (fs.existsSync(targetFile)) {
      throw new PathGuardError("FILE_ALREADY_EXISTS", `File already exists at '${targetFile}'. Use modifyFile.`);
    }

    const dir = path.dirname(targetFile);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o755 });

    // Revalidate parent directory hierarchy after mkdir
    PathGuard.validateSegmentsWithinRoot(canonicalRoot, dir, false);

    // Safe exclusive temporary file creation inside validated target directory
    const tempFile = path.join(dir, `.tmp_messiah_${crypto.randomBytes(8).toString("hex")}`);
    const fh = await fs.promises.open(
      tempFile,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW_FLAG,
      0o644
    );
    try {
      await fh.writeFile(content, "utf-8");
      await fh.sync();
    } finally {
      await fh.close().catch(() => {});
    }

    // Revalidate immediately before atomic commit
    if (fs.existsSync(targetFile)) {
      await fs.promises.unlink(tempFile).catch(() => {});
      throw new PathGuardError("FILE_ALREADY_EXISTS", `Concurrent file creation detected at '${targetFile}'.`);
    }
    PathGuard.validateSegmentsWithinRoot(canonicalRoot, dir, false);
    await fs.promises.rename(tempFile, targetFile);

    const hash = this.computeFileHash(content);
    return { path: relativePath, hash, sizeBytes: Buffer.byteLength(content) };
  }

  /**
   * Modifies an existing file safely:
   * 1. Opens existing file descriptor with O_NOFOLLOW, verifies nlink <= 1 & expectedPreviousHash.
   * 2. Preserves original permissions.
   * 3. Writes temp file exclusively (O_EXCL | O_NOFOLLOW) inside validated directory, revalidates target, and swaps atomically.
   */
  public static async modifyFile(
    allowedRoots: string[],
    rootPath: string,
    relativePath: string,
    newContent: string,
    expectedPreviousHash?: string
  ): Promise<FileDiffResult> {
    const canonicalRoot = PathGuard.resolveAndValidate(allowedRoots, rootPath, "");
    const targetFile = PathGuard.resolveAndValidate(allowedRoots, rootPath, relativePath, {
      allowMissingLeaf: true,
    });

    let previousContent = "";
    let previousHash: string | null = null;
    let preservedMode = 0o644;
    let initialIno: number | bigint | null = null;

    if (fs.existsSync(targetFile)) {
      const { fh } = await this.openValidatedRegularFile(
        allowedRoots,
        rootPath,
        relativePath,
        fs.constants.O_RDONLY
      );
      try {
        const fstat = await fh.stat();
        preservedMode = fstat.mode & 0o777;
        initialIno = fstat.ino;
        const buffer = await fh.readFile();
        previousContent = buffer.toString("utf-8");
        previousHash = this.computeFileHash(buffer);

        if (expectedPreviousHash && previousHash !== expectedPreviousHash) {
          throw new PathGuardError(
            "CONCURRENT_MODIFICATION_DETECTED",
            `File has changed on disk since diff was prepared (current: ${previousHash}, expected: ${expectedPreviousHash}).`
          );
        }
      } finally {
        await fh.close().catch(() => {});
      }
    } else if (expectedPreviousHash) {
      throw new PathGuardError(
        "CONCURRENT_MODIFICATION_DETECTED",
        `Expected previous file with hash ${expectedPreviousHash}, but file no longer exists.`
      );
    }

    const dir = path.dirname(targetFile);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o755 });
    PathGuard.validateSegmentsWithinRoot(canonicalRoot, dir, false);

    const tempFile = path.join(dir, `.tmp_messiah_${crypto.randomBytes(8).toString("hex")}`);
    const tmpFh = await fs.promises.open(
      tempFile,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW_FLAG,
      preservedMode
    );
    try {
      await tmpFh.writeFile(newContent, "utf-8");
      await tmpFh.sync();
    } finally {
      await tmpFh.close().catch(() => {});
    }

    // Revalidate immediately before committing rename (detect race replacement + expected hash drift)
    try {
      if (fs.existsSync(targetFile)) {
        const currentStat = await fs.promises.lstat(targetFile);
        if (currentStat.isSymbolicLink()) {
          throw new PathGuardError("SYMLINK_ESCAPE_DETECTED", `Symlink appeared at '${targetFile}' before commit.`);
        }
        if (initialIno !== null && currentStat.ino !== initialIno) {
          throw new PathGuardError("CONCURRENT_MODIFICATION_DETECTED", "Target file inode changed prior to atomic swap.");
        }
        if (expectedPreviousHash) {
          const checkBuf = await fs.promises.readFile(targetFile);
          const checkHash = this.computeFileHash(checkBuf);
          if (checkHash !== expectedPreviousHash) {
            throw new PathGuardError("CONCURRENT_MODIFICATION_DETECTED", "File content changed between read and commit.");
          }
        }
      }
      PathGuard.validateSegmentsWithinRoot(canonicalRoot, dir, false);
      await fs.promises.rename(tempFile, targetFile);
    } catch (err) {
      await fs.promises.unlink(tempFile).catch(() => {});
      throw err;
    }

    const newHash = this.computeFileHash(newContent);
    const diffText = this.generateUnifiedDiff(relativePath, previousContent, newContent);

    return {
      filePath: relativePath,
      previousHash,
      newHash,
      hasChanged: previousHash !== newHash,
      diffText,
    };
  }

  /**
   * Deletes a file or empty/contained directory safely without following symlinks.
   */
  public static async deleteFile(
    allowedRoots: string[],
    rootPath: string,
    relativePath: string
  ): Promise<{ path: string; deleted: boolean }> {
    const canonicalRoot = PathGuard.resolveAndValidate(allowedRoots, rootPath, "");
    const targetFile = PathGuard.resolveAndValidate(allowedRoots, rootPath, relativePath, {
      allowMissingLeaf: false,
    });

    if (targetFile === canonicalRoot) {
      throw new PathGuardError("ROOT_DELETE_PROHIBITED", "Cannot delete the approved project root itself.");
    }

    const stat = await fs.promises.lstat(targetFile);
    if (stat.isSymbolicLink()) {
      throw new PathGuardError("SYMLINK_ESCAPE_DETECTED", `Refusing to delete symbolic link at '${targetFile}'.`);
    }

    if (stat.isDirectory()) {
      // Safe non-symlink recursive removal
      const safeRmDir = async (dirPath: string) => {
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        for (const ent of entries) {
          const child = path.join(dirPath, ent.name);
          const cst = await fs.promises.lstat(child);
          if (cst.isSymbolicLink()) {
            throw new PathGuardError("SYMLINK_ESCAPE_DETECTED", `Encountered symlink inside delete target: '${child}'.`);
          }
          if (cst.isDirectory()) {
            await safeRmDir(child);
          } else {
            await fs.promises.unlink(child);
          }
        }
        await fs.promises.rmdir(dirPath);
      };
      await safeRmDir(targetFile);
    } else {
      await fs.promises.unlink(targetFile);
    }

    return { path: relativePath, deleted: true };
  }

  public static generateUnifiedDiff(filePath: string, oldText: string, newText: string): string {
    const oldLines = oldText ? oldText.split("\n") : [];
    const newLines = newText ? newText.split("\n") : [];
    const diffLines: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];

    let hasDiff = false;
    const max = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < max; i++) {
      const oldLine = oldLines[i];
      const newLine = newLines[i];

      if (oldLine !== newLine) {
        hasDiff = true;
        if (oldLine !== undefined) diffLines.push(`-${oldLine}`);
        if (newLine !== undefined) diffLines.push(`+${newLine}`);
      }
    }

    return hasDiff ? diffLines.join("\n") : "";
  }
}
