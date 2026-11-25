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

export class SafeFileOperations {
  /**
   * Computes SHA-256 hash of a file's content.
   */
  public static computeFileHash(content: string | Buffer): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  /**
   * Lists contents of a directory inside an approved root.
   */
  public static async listDirectory(
    allowedRoots: string[],
    rootPath: string,
    relativePath = ""
  ): Promise<FileEntryInfo[]> {
    const targetDir = PathGuard.resolveAndValidate(allowedRoots, rootPath, relativePath);

    const stat = await fs.promises.stat(targetDir);
    if (!stat.isDirectory()) {
      throw new PathGuardError("NOT_A_DIRECTORY", `Path '${targetDir}' is not a directory.`);
    }

    const dirents = await fs.promises.readdir(targetDir, { withFileTypes: true });
    const results: FileEntryInfo[] = [];

    for (const ent of dirents) {
      // Skip hidden git internals
      if (ent.name === ".git") continue;

      const fullChildPath = path.join(targetDir, ent.name);
      try {
        const childStat = await fs.promises.stat(fullChildPath);
        results.push({
          name: ent.name,
          path: path.relative(rootPath, fullChildPath),
          isDirectory: ent.isDirectory(),
          sizeBytes: childStat.size,
          modifiedAt: childStat.mtime.toISOString(),
        });
      } catch {
        // Skip unreadable files
      }
    }

    return results;
  }

  /**
   * Reads file contents up to maxBytes.
   */
  public static async readFile(
    allowedRoots: string[],
    rootPath: string,
    relativePath: string,
    maxBytes = 1048576 // 1MB default limit
  ): Promise<{ content: string; hash: string; sizeBytes: number }> {
    const targetFile = PathGuard.resolveAndValidate(allowedRoots, rootPath, relativePath);

    const stat = await fs.promises.stat(targetFile);
    if (stat.isDirectory()) {
      throw new PathGuardError("IS_A_DIRECTORY", `Path '${targetFile}' is a directory.`);
    }

    if (stat.size > maxBytes) {
      throw new PathGuardError(
        "FILE_TOO_LARGE",
        `File size (${stat.size} bytes) exceeds limit of ${maxBytes} bytes.`
      );
    }

    const buffer = await fs.promises.readFile(targetFile);
    const content = buffer.toString("utf-8");
    const hash = this.computeFileHash(buffer);

    return { content, hash, sizeBytes: stat.size };
  }

  /**
   * Searches file contents across approved root matching text or pattern.
   */
  public static async searchFiles(
    allowedRoots: string[],
    rootPath: string,
    query: string,
    maxResults = 50
  ): Promise<Array<{ path: string; lineNumber: number; lineContent: string }>> {
    const validatedRoot = PathGuard.resolveAndValidate(allowedRoots, rootPath, "");
    const results: Array<{ path: string; lineNumber: number; lineContent: string }> = [];

    async function walk(dir: string) {
      if (results.length >= maxResults) return;

      const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const ent of dirents) {
        if (results.length >= maxResults) break;
        if (ent.name === ".git" || ent.name === "node_modules" || ent.name === ".next") continue;

        const fullPath = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          await walk(fullPath);
        } else if (ent.isFile()) {
          try {
            const stat = await fs.promises.stat(fullPath);
            if (stat.size > 500_000) continue; // Skip large binary/source files

            const content = await fs.promises.readFile(fullPath, "utf-8");
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
          } catch {}
        }
      }
    }

    await walk(validatedRoot);
    return results;
  }

  /**
   * Creates a new file atomically using temp file + rename.
   */
  public static async createFile(
    allowedRoots: string[],
    rootPath: string,
    relativePath: string,
    content: string
  ): Promise<{ path: string; hash: string; sizeBytes: number }> {
    const targetFile = PathGuard.resolveAndValidate(allowedRoots, rootPath, relativePath);

    if (fs.existsSync(targetFile)) {
      throw new PathGuardError("FILE_ALREADY_EXISTS", `File already exists at '${targetFile}'. Use modifyFile.`);
    }

    const dir = path.dirname(targetFile);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o755 });

    // Atomic write via temp file in the same filesystem directory
    const tempFile = path.join(dir, `.tmp_messiah_${crypto.randomBytes(6).toString("hex")}`);
    await fs.promises.writeFile(tempFile, content, { encoding: "utf-8", mode: 0o644 });
    await fs.promises.rename(tempFile, targetFile);

    const hash = this.computeFileHash(content);
    return { path: relativePath, hash, sizeBytes: Buffer.byteLength(content) };
  }

  /**
   * Modifies an existing file safely:
   * 1. Verifies existing content hash matches expectedPreviousHash (prevents race condition overwrites).
   * 2. Writes atomically via temp file in same directory.
   */
  public static async modifyFile(
    allowedRoots: string[],
    rootPath: string,
    relativePath: string,
    newContent: string,
    expectedPreviousHash?: string
  ): Promise<FileDiffResult> {
    const targetFile = PathGuard.resolveAndValidate(allowedRoots, rootPath, relativePath);

    let previousContent = "";
    let previousHash: string | null = null;

    if (fs.existsSync(targetFile)) {
      const buffer = await fs.promises.readFile(targetFile);
      previousContent = buffer.toString("utf-8");
      previousHash = this.computeFileHash(buffer);

      if (expectedPreviousHash && previousHash !== expectedPreviousHash) {
        throw new PathGuardError(
          "CONCURRENT_MODIFICATION_DETECTED",
          `File has changed on disk since diff was prepared (current: ${previousHash}, expected: ${expectedPreviousHash}).`
        );
      }
    }

    // Atomic write
    const dir = path.dirname(targetFile);
    const tempFile = path.join(dir, `.tmp_messiah_${crypto.randomBytes(6).toString("hex")}`);
    await fs.promises.writeFile(tempFile, newContent, { encoding: "utf-8", mode: 0o644 });
    await fs.promises.rename(tempFile, targetFile);

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
   * Deletes a file inside an approved root.
   */
  public static async deleteFile(
    allowedRoots: string[],
    rootPath: string,
    relativePath: string
  ): Promise<{ path: string; deleted: boolean }> {
    const targetFile = PathGuard.resolveAndValidate(allowedRoots, rootPath, relativePath);

    if (!fs.existsSync(targetFile)) {
      throw new PathGuardError("FILE_NOT_FOUND", `File not found at '${targetFile}'.`);
    }

    const stat = await fs.promises.stat(targetFile);
    if (stat.isDirectory()) {
      await fs.promises.rm(targetFile, { recursive: true, force: true });
    } else {
      await fs.promises.unlink(targetFile);
    }

    return { path: relativePath, deleted: true };
  }

  /**
   * Generates a simple unified diff representation between previous and new text.
   */
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
