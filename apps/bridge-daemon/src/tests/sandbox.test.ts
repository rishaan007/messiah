import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { ProcessSandbox } from "../sandbox/processSandbox.js";
import { SandboxDetector } from "../sandbox/sandboxDetector.js";

describe("Phase 4B: Workstation Sandboxing & Process Runner", () => {
  const testRoot = path.join(os.tmpdir(), `messiah-sandbox-test-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(testRoot, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testRoot)) fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("detects sandbox availability on current platform", async () => {
    const status = await SandboxDetector.detect();
    expect(status.platform).toBe(os.platform());
    expect(status.available).toBe(true);
    expect(status.providerName).toBeDefined();
  });

  it("executes command using argument array with separate stdout and stderr", async () => {
    const sandbox = new ProcessSandbox();

    // Use node executable to run a safe inline command
    const res = await sandbox.execute({
      executable: process.execPath,
      args: ["-e", 'console.log("standard-out"); console.error("standard-err");'],
      cwd: testRoot,
      allowedMounts: [testRoot],
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("standard-out");
    expect(res.stderr).toContain("standard-err");
    expect(res.truncated).toBe(false);
  });

  it("scrubs sensitive host credentials from child environment", async () => {
    const sandbox = new ProcessSandbox();

    // Attempt to read process.env in child
    const res = await sandbox.execute({
      executable: process.execPath,
      args: ["-e", 'console.log(JSON.stringify(process.env));'],
      cwd: testRoot,
      allowedMounts: [testRoot],
      env: {
        SSH_AUTH_SOCK: "/tmp/leak_ssh",
        AWS_SECRET_ACCESS_KEY: "secret_aws",
        CUSTOM_SAFE_VAR: "allowed_value",
      },
      explicitAllowedEnvKeys: ["CUSTOM_SAFE_VAR"],
    });

    expect(res.exitCode).toBe(0);
    const childEnv = JSON.parse(res.stdout.trim());
    expect(childEnv.SSH_AUTH_SOCK).toBeUndefined();
    expect(childEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(childEnv.CUSTOM_SAFE_VAR).toBe("allowed_value");
  });

  it("enforces execution timeout and terminates process tree", async () => {
    const sandbox = new ProcessSandbox();

    const res = await sandbox.execute({
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 60000);"], // Sleeps for 60s
      cwd: testRoot,
      allowedMounts: [testRoot],
      timeoutMs: 500, // 500ms timeout
    });

    expect(res.exitCode).toBe(124);
    expect(res.stderr).toContain("TIMEOUT_EXCEEDED (500ms)");
    expect(res.truncated).toBe(true);
  });

  it("truncates output when exceeding maxOutputBytes ceiling", async () => {
    const sandbox = new ProcessSandbox();

    const res = await sandbox.execute({
      executable: process.execPath,
      args: ["-e", 'console.log("X".repeat(5000));'],
      cwd: testRoot,
      allowedMounts: [testRoot],
      maxOutputBytes: 1000,
    });

    expect(res.truncated).toBe(true);
    expect(res.stdout).toContain("truncated");
  });
});
