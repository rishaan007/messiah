import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { TaskExecutor } from "../tasks/taskExecutor.js";
import { TaskSignatureVerifier } from "../security/taskSignatureVerifier.js";
import { ReplayGuard } from "../security/replayGuard.js";
import type { DeviceTaskDispatchFrame } from "@messiah/shared";

describe("Phase 4B: Task Authorization & Signed Execution", () => {
  const testRoot = path.join(os.tmpdir(), `messiah-task-test-${Date.now()}`);
  const configDir = path.join(os.tmpdir(), `messiah-task-config-${Date.now()}`);
  const TEST_SERVER_SECRET = "messiah_test_server_signing_secret_min_32_chars";

  let executor: TaskExecutor;

  beforeEach(() => {
    fs.mkdirSync(testRoot, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    ReplayGuard.clear();
    executor = new TaskExecutor(configDir);
    executor.getPolicyService().addProjectRoot(testRoot, true);
  });

  afterEach(() => {
    if (fs.existsSync(testRoot)) fs.rmSync(testRoot, { recursive: true, force: true });
    if (fs.existsSync(configDir)) fs.rmSync(configDir, { recursive: true, force: true });
  });

  function createSignedTaskFrame(overrides: Partial<DeviceTaskDispatchFrame> = {}): DeviceTaskDispatchFrame {
    const taskId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const deviceId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const capability = "filesystem.read";
    const resourceScopes = [testRoot];
    const parameters = { rootPath: testRoot, relativePath: "hello.txt" };
    const serializedParams = JSON.stringify(parameters);
    const argumentsHash =
      overrides.argumentsHash || crypto.createHash("sha256").update(serializedParams).digest("hex");
    const issuedAt = Date.now();
    const expiresAt = overrides.expiresAt || issuedAt + 60_000;
    const nonce = overrides.nonce || crypto.randomBytes(16).toString("hex");
    const policyVersion = "2026-08-01";

    const canonicalPayload = TaskSignatureVerifier.formatCanonicalPayloadV2({
      taskId,
      requestId,
      deviceId,
      workspaceId,
      capability,
      resourceScopes,
      argumentsHash,
      issuedAt,
      expiresAt,
      nonce,
      policyVersion,
    });

    const serverSignature =
      overrides.serverSignature ||
      crypto
        .createHmac("sha256", TEST_SERVER_SECRET)
        .update(canonicalPayload)
        .digest("base64");

    return {
      type: "device.task.dispatch",
      taskId,
      requestId,
      deviceId,
      workspaceId,
      capability,
      resourceScopes,
      parameters,
      argumentsHash,
      issuedAt,
      expiresAt,
      nonce,
      policyVersion,
      serverSignature,
      ...overrides,
    };
  }

  it("successfully verifies signed task authorization and executes capability", async () => {
    // Create a target file to read
    fs.writeFileSync(path.join(testRoot, "hello.txt"), "Hello Messiah Bridge!");

    const frame = createSignedTaskFrame();

    let accepted = false;
    let started = false;
    let completed = false;
    let taskResult: any = null;

    await executor.executeTask(frame, TEST_SERVER_SECRET, {
      onAccepted: () => { accepted = true; },
      onStarted: () => { started = true; },
      onProgress: () => {},
      onLog: () => {},
      onCompleted: (_id, res) => {
        completed = true;
        taskResult = res;
      },
      onFailed: (_id, code, msg) => {
        throw new Error(`Task unexpectedly failed: [${code}] ${msg}`);
      },
    });

    expect(accepted).toBe(true);
    expect(started).toBe(true);
    expect(completed).toBe(true);
    expect(taskResult?.content).toBe("Hello Messiah Bridge!");
  });

  it("rejects task with forged or invalid server signature", async () => {
    const frame = createSignedTaskFrame({
      serverSignature: "forged_base64_signature_here_invalid_data==",
    });

    let failedCode = "";
    await executor.executeTask(frame, TEST_SERVER_SECRET, {
      onAccepted: () => {},
      onStarted: () => {},
      onProgress: () => {},
      onLog: () => {},
      onCompleted: () => {},
      onFailed: (_id, code) => {
        failedCode = code;
      },
    });

    expect(failedCode).toBe("INVALID_SIGNATURE");
  });

  it("rejects task with mismatched parameters hash (tampered arguments)", async () => {
    const frame = createSignedTaskFrame({
      argumentsHash: "0000000000000000000000000000000000000000000000000000000000000000",
    });

    let failedCode = "";
    await executor.executeTask(frame, TEST_SERVER_SECRET, {
      onAccepted: () => {},
      onStarted: () => {},
      onProgress: () => {},
      onLog: () => {},
      onCompleted: () => {},
      onFailed: (_id, code) => {
        failedCode = code;
      },
    });

    expect(failedCode).toBe("ARGUMENTS_HASH_MISMATCH");
  });

  it("rejects replayed nonce", async () => {
    fs.writeFileSync(path.join(testRoot, "hello.txt"), "data");
    const frame = createSignedTaskFrame();

    // First execution succeeds
    await executor.executeTask(frame, TEST_SERVER_SECRET, {
      onAccepted: () => {},
      onStarted: () => {},
      onProgress: () => {},
      onLog: () => {},
      onCompleted: () => {},
      onFailed: () => {},
    });

    // Replay with identical nonce must fail
    let failedCode = "";
    await executor.executeTask(frame, TEST_SERVER_SECRET, {
      onAccepted: () => {},
      onStarted: () => {},
      onProgress: () => {},
      onLog: () => {},
      onCompleted: () => {},
      onFailed: (_id, code) => {
        failedCode = code;
      },
    });

    expect(failedCode).toBe("REPLAY_DETECTED");
  });

  it("rejects expired task authorization", async () => {
    const frame = createSignedTaskFrame({
      expiresAt: Date.now() - 5000, // Expired 5 seconds ago
    });

    let failedCode = "";
    await executor.executeTask(frame, TEST_SERVER_SECRET, {
      onAccepted: () => {},
      onStarted: () => {},
      onProgress: () => {},
      onLog: () => {},
      onCompleted: () => {},
      onFailed: (_id, code) => {
        failedCode = code;
      },
    });

    expect(failedCode).toBe("TASK_EXPIRED");
  });
});
