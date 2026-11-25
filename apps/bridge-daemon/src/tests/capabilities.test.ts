import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { CapabilityRegistry } from "../capabilities/capabilityRegistry.js";
import { LocalDevicePolicyService } from "../security/localDevicePolicy.js";
import { ProcessSandbox } from "../sandbox/processSandbox.js";

describe("Phase 4B: Capability Registry & Local Governance", () => {
  const testRoot = path.join(os.tmpdir(), `messiah-cap-test-${Date.now()}`);
  const configDir = path.join(os.tmpdir(), `messiah-config-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(testRoot, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testRoot)) fs.rmSync(testRoot, { recursive: true, force: true });
    if (fs.existsSync(configDir)) fs.rmSync(configDir, { recursive: true, force: true });
  });

  it("registers all 13 required capabilities", () => {
    const registry = new CapabilityRegistry();
    const names = registry.getNames();

    const expected = [
      "filesystem.list",
      "filesystem.read",
      "filesystem.search",
      "filesystem.create",
      "filesystem.modify",
      "filesystem.delete",
      "mcp.discover",
      "mcp.invoke",
      "process.run",
      "process.inspect",
      "agent.start",
      "agent.status",
      "agent.cancel",
    ];

    for (const exp of expected) {
      expect(names).toContain(exp);
      const cap = registry.get(exp);
      expect(cap).toBeDefined();
      expect(cap?.supportedPlatforms).toContain(os.platform());
    }
  });

  it("enforces local device policy: denies writing to read-only project roots", async () => {
    const registry = new CapabilityRegistry();
    const policy = new LocalDevicePolicyService(configDir);
    const sandbox = new ProcessSandbox();

    // Configure testRoot as read-only
    policy.addProjectRoot(testRoot, false);

    const createCap = registry.get("filesystem.create")!;
    const ctx = {
      taskId: "test-task",
      deviceId: "test-device",
      workspaceId: "test-ws",
      policyService: policy,
      sandbox,
      allowedRoots: [testRoot],
    };

    await expect(
      createCap.execute(ctx, { rootPath: testRoot, relativePath: "test.txt", content: "data" })
    ).rejects.toThrowError(/read-only/i);
  });

  it("enforces local device policy: denies terminal execution when disabled by user policy", async () => {
    const registry = new CapabilityRegistry();
    const policy = new LocalDevicePolicyService(configDir);
    const sandbox = new ProcessSandbox();

    policy.addProjectRoot(testRoot, true);
    // Explicitly ensure terminalExecutionEnabled is false
    const pol = policy.getPolicy();
    pol.terminalExecutionEnabled = false;
    policy.savePolicy(pol);

    const processCap = registry.get("process.run")!;
    const ctx = {
      taskId: "test-task-2",
      deviceId: "test-device",
      workspaceId: "test-ws",
      policyService: policy,
      sandbox,
      allowedRoots: [testRoot],
    };

    await expect(
      processCap.execute(ctx, { executable: "whoami", args: [] })
    ).rejects.toThrowError(/disabled on this device by local policy/i);
  });
});
