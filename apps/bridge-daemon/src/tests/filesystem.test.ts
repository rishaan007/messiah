import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PathGuard, PathGuardError } from "../filesystem/pathGuard.js";
import { SafeFileOperations } from "../filesystem/safeFileOperations.js";

describe("Phase 4B: Local Filesystem Security & Safe Operations", () => {
  const testRoot = path.join(os.tmpdir(), `messiah-fs-test-${Date.now()}`);
  const outsideDir = path.join(os.tmpdir(), `messiah-outside-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(testRoot, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testRoot)) fs.rmSync(testRoot, { recursive: true, force: true });
    if (fs.existsSync(outsideDir)) fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  describe("PathGuard Containment & Traversal Defense", () => {
    it("allows valid paths inside the approved root", () => {
      const filePath = path.join(testRoot, "src", "index.ts");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "console.log('hello');");

      const resolved = PathGuard.resolveAndValidate([testRoot], testRoot, "src/index.ts");
      expect(resolved).toBe(fs.realpathSync(filePath));
    });

    it("rejects path traversal attempting to escape root via ../", () => {
      expect(() => {
        PathGuard.resolveAndValidate([testRoot], testRoot, "../../etc/passwd");
      }).toThrowError(PathGuardError);
    });

    it("rejects paths containing null bytes", () => {
      expect(() => {
        PathGuard.resolveAndValidate([testRoot], testRoot, "index.ts\0.exe");
      }).toThrowError(/null byte/i);
    });

    it("rejects symlinks that resolve outside the approved project root", () => {
      const secretFile = path.join(outsideDir, "secret.key");
      fs.writeFileSync(secretFile, "super-secret");

      const symlinkPath = path.join(testRoot, "leak-link");
      try {
        fs.symlinkSync(secretFile, symlinkPath);

        expect(() => {
          PathGuard.resolveAndValidate([testRoot], testRoot, "leak-link");
        }).toThrowError(/symlink|reparse point/i);
      } catch (err: any) {
        if (err.code === "EPERM") {
          // Windows unprivileged symlink restriction
          return;
        }
        throw err;
      }
    });

    it("strictly blocks access to sensitive credentials files (e.g. .ssh, id_rsa, .aws)", () => {
      const sshDir = path.join(testRoot, ".ssh");
      fs.mkdirSync(sshDir, { recursive: true });
      const idRsa = path.join(sshDir, "id_rsa");
      fs.writeFileSync(idRsa, "dummy private key");

      expect(() => {
        PathGuard.resolveAndValidate([testRoot], testRoot, ".ssh/id_rsa");
      }).toThrowError(/sensitive/i);
    });
  });

  describe("SafeFileOperations (Atomic Writes, Diffs, and Hash Checks)", () => {
    it("creates files atomically via temp file replacement", async () => {
      const res = await SafeFileOperations.createFile([testRoot], testRoot, "app.ts", "const x = 42;");
      expect(res.path).toBe("app.ts");
      expect(res.sizeBytes).toBe(13);

      const content = fs.readFileSync(path.join(testRoot, "app.ts"), "utf-8");
      expect(content).toBe("const x = 42;");
    });

    it("reads files up to maxBytes limit and rejects oversized files", async () => {
      fs.writeFileSync(path.join(testRoot, "large.txt"), "A".repeat(5000));

      const res = await SafeFileOperations.readFile([testRoot], testRoot, "large.txt", 10000);
      expect(res.sizeBytes).toBe(5000);
      expect(res.content.length).toBe(5000);

      // Exceed limit
      await expect(
        SafeFileOperations.readFile([testRoot], testRoot, "large.txt", 1000)
      ).rejects.toThrowError(/exceeds limit/i);
    });

    it("modifies file, generates unified diff, and detects concurrent modification drift", async () => {
      await SafeFileOperations.createFile([testRoot], testRoot, "config.ts", "export const PORT = 3000;");

      const readRes = await SafeFileOperations.readFile([testRoot], testRoot, "config.ts");
      const originalHash = readRes.hash;

      // 1. Successful modification when expected hash matches
      const modifyRes = await SafeFileOperations.modifyFile(
        [testRoot],
        testRoot,
        "config.ts",
        "export const PORT = 4000;",
        originalHash
      );
      expect(modifyRes.hasChanged).toBe(true);
      expect(modifyRes.diffText).toContain("-export const PORT = 3000;");
      expect(modifyRes.diffText).toContain("+export const PORT = 4000;");

      // 2. Reject modification if file changed on disk behind our back (concurrent modification)
      await expect(
        SafeFileOperations.modifyFile(
          [testRoot],
          testRoot,
          "config.ts",
          "export const PORT = 5000;",
          originalHash // Stale hash
        )
      ).rejects.toThrowError(/File has changed on disk/i);
    });

    it("lists directory contents and searches file content cleanly", async () => {
      await SafeFileOperations.createFile([testRoot], testRoot, "fileA.txt", "Hello Messiah world!");
      await SafeFileOperations.createFile([testRoot], testRoot, "fileB.txt", "Another test document");

      const list = await SafeFileOperations.listDirectory([testRoot], testRoot, "");
      expect(list.some((f) => f.name === "fileA.txt")).toBe(true);
      expect(list.some((f) => f.name === "fileB.txt")).toBe(true);

      const search = await SafeFileOperations.searchFiles([testRoot], testRoot, "Messiah");
      expect(search.length).toBe(1);
      expect(search[0]?.path).toBe("fileA.txt");
      expect(search[0]?.lineContent).toContain("Hello Messiah world!");
    });

    it("deletes file safely", async () => {
      await SafeFileOperations.createFile([testRoot], testRoot, "to_delete.txt", "goodbye");
      const res = await SafeFileOperations.deleteFile([testRoot], testRoot, "to_delete.txt");
      expect(res.deleted).toBe(true);
      expect(fs.existsSync(path.join(testRoot, "to_delete.txt"))).toBe(false);
    });
  });
});
