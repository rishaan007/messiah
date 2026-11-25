import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import type { AddressInfo } from "node:net";
import * as jose from "jose";
import { buildApp } from "../app.js";
import { loadAndValidateEnv } from "../config/env.js";
import { prisma } from "@messiah/db";
import { DeviceIdentityManager } from "@messiah/bridge-daemon";
import {
  type ServerChallengeFrame,
  type BridgeAuthProofFrame,
  type DeviceTaskDispatchFrame,
  type DeviceTaskCancelFrame,
} from "@messiah/shared";
import {
  taskAuthorizationService,
  deviceConnectionGateway,
} from "../services/devices/index.js";

const TEST_SECRET = new TextEncoder().encode("messiah_test_jwt_secret_minimum_32_characters_long");
const TEST_VAULT_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async function createTestJwt(payload: {
  sub: string;
  email: string;
  user_metadata?: { full_name?: string };
}): Promise<string> {
  return await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(TEST_SECRET);
}

describe("MESSIAH Phase 4B — Workstation Sandboxing, Bridge Task Execution & Capability Management", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let serverPort: number;

  let ownerToken: string;
  let memberToken: string;
  let userBToken: string;

  let ownerId: string;
  let memberId: string;
  let userBId: string;

  let workspaceId: string;
  let workspaceBId: string;
  let deviceId: string;

  let deviceIdentity: ReturnType<typeof DeviceIdentityManager.generateIdentity>;
  let activeWs: WebSocket | null = null;

  const runId = Math.random().toString(36).substring(2, 9);
  const ownerExternalId = `supabase-tasks-owner-${runId}`;
  const memberExternalId = `supabase-tasks-member-${runId}`;
  const userBExternalId = `supabase-tasks-userb-${runId}`;

  const ownerEmail = `tasks.owner.${runId}@example.com`;
  const memberEmail = `tasks.member.${runId}@example.com`;
  const userBEmail = `tasks.userb.${runId}@example.com`;

  beforeAll(async () => {
    process.env.VAULT_ENCRYPTION_KEY = TEST_VAULT_KEY;

    const testEnv = loadAndValidateEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "fatal",
      SUPABASE_JWT_SECRET: "messiah_test_jwt_secret_minimum_32_characters_long",
      VAULT_ENCRYPTION_KEY: TEST_VAULT_KEY,
    });

    app = await buildApp({ env: testEnv, logger: false });
    await app.listen({ port: 0, host: "127.0.0.1" });
    serverPort = (app.server.address() as AddressInfo).port;

    ownerToken = await createTestJwt({
      sub: ownerExternalId,
      email: ownerEmail,
      user_metadata: { full_name: "Tasks Workspace Owner" },
    });

    memberToken = await createTestJwt({
      sub: memberExternalId,
      email: memberEmail,
      user_metadata: { full_name: "Tasks Workspace Member" },
    });

    userBToken = await createTestJwt({
      sub: userBExternalId,
      email: userBEmail,
      user_metadata: { full_name: "Other Workspace User" },
    });

    // 1. Seed Owner and Workspace A
    const owner = await prisma.user.create({
      data: {
        email: ownerEmail,
        externalId: ownerExternalId,
        externalProvider: "supabase",
        fullName: "Tasks Workspace Owner",
      },
    });
    ownerId = owner.id;

    const workspace = await prisma.workspace.create({
      data: {
        name: `Tasks Test Workspace ${runId}`,
        slug: `tasks-workspace-${runId}`,
        ownerId,
        members: {
          create: {
            userId: owner.id,
            role: "OWNER",
          },
        },
      },
    });
    workspaceId = workspace.id;

    // 2. Seed Member in Workspace A
    const member = await prisma.user.create({
      data: {
        email: memberEmail,
        externalId: memberExternalId,
        externalProvider: "supabase",
        fullName: "Tasks Workspace Member",
      },
    });
    memberId = member.id;

    await prisma.workspaceMember.create({
      data: {
        workspaceId,
        userId: memberId,
        role: "MEMBER",
      },
    });

    // 3. Seed User B in Workspace B
    const userB = await prisma.user.create({
      data: {
        email: userBEmail,
        externalId: userBExternalId,
        externalProvider: "supabase",
        fullName: "Other Workspace User",
      },
    });
    userBId = userB.id;

    const workspaceB = await prisma.workspace.create({
      data: {
        name: `Workspace B ${runId}`,
        slug: `workspace-b-${runId}`,
        ownerId: userB.id,
        members: {
          create: {
            userId: userB.id,
            role: "OWNER",
          },
        },
      },
    });
    workspaceBId = workspaceB.id;

    // 4. Generate device identity and register active device
    deviceIdentity = DeviceIdentityManager.generateIdentity("MacBook Pro M3 (Phase 4B)");

    const device = await prisma.bridgeDevice.create({
      data: {
        workspaceId,
        ownerUserId: ownerId,
        displayName: "MacBook Pro M3 (Phase 4B)",
        platform: "darwin",
        architecture: "arm64",
        bridgeVersion: "1.0.0",
        publicKey: deviceIdentity.publicKey,
        publicKeyFingerprint: deviceIdentity.publicKeyFingerprint,
        status: "ACTIVE",
        capabilities: [
          "filesystem.list",
          "filesystem.read",
          "filesystem.create",
          "filesystem.modify",
          "process.run",
          "mcp.discover",
        ],
        allowedRoots: ["/Users/dev/messiah-project"],
        devicePolicy: {
          terminalExecutionEnabled: true,
          writableRoots: ["/Users/dev/messiah-project"],
        },
      },
    });
    deviceId = device.id;
  });

  afterAll(async () => {
    if (activeWs) {
      activeWs.close();
    }
    await prisma.bridgeTaskLog.deleteMany({ where: { task: { workspaceId } } });
    await prisma.bridgeTaskApproval.deleteMany({ where: { workspaceId } });
    await prisma.bridgeTask.deleteMany({ where: { workspaceId } });
    await prisma.bridgeLocalMcpServer.deleteMany({ where: { workspaceId } });
    await prisma.bridgeDevice.deleteMany({ where: { workspaceId } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: [workspaceId, workspaceBId] } } });
    await prisma.workspace.deleteMany({ where: { id: { in: [workspaceId, workspaceBId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, memberId, userBId] } } });
    await app.close();
  });

  describe("1. Task Authorization & Cryptographic Envelope Signing", () => {
    it("signs canonical task authorization payload with HMAC-SHA256", () => {
      const envelope = taskAuthorizationService.createSignedTaskEnvelope({
        taskId: "11111111-1111-1111-1111-111111111111",
        deviceId,
        workspaceId,
        capability: "filesystem.read",
        resourceScopes: ["/Users/dev/messiah-project/README.md"],
        parameters: { path: "README.md" },
      });

      expect(envelope.type).toBe("device.task.dispatch");
      expect(envelope.taskId).toBe("11111111-1111-1111-1111-111111111111");
      expect(envelope.deviceId).toBe(deviceId);
      expect(envelope.workspaceId).toBe(workspaceId);
      expect(envelope.capability).toBe("filesystem.read");
      expect(envelope.serverSignature).toBeDefined();
      expect(envelope.nonce).toHaveLength(32);
      expect(envelope.argumentsHash).toBeDefined();
    });

    it("payload format contains canonical prefix and sorted resource scopes", () => {
      const payload = taskAuthorizationService.formatTaskAuthPayload(
        "task-123",
        "req-456",
        "device-789",
        "workspace-abc",
        "process.run",
        ["/b", "/a"],
        "argshash",
        1000,
        2000,
        "nonce123",
        "2026-08-01",
        "approval-xyz"
      );

      expect(payload).toBe(
        "MESSIAH_TASK_AUTH:task-123:req-456:device-789:workspace-abc:process.run:/a,/b:argshash:1000:2000:nonce123:2026-08-01:approval-xyz"
      );
    });
  });

  describe("2. Device Policy & Local MCP Server Management", () => {
    it("OWNER can update device execution policy and roots", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/devices/${deviceId}/policy`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          workspaceId,
          allowedRoots: ["/Users/dev/messiah-project", "/Users/dev/docs"],
          capabilities: ["filesystem.read", "filesystem.modify", "process.run"],
          devicePolicy: {
            terminalExecutionEnabled: true,
            maxProcesses: 3,
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.success).toBe(true);
      expect(json.data.allowedRoots).toHaveLength(2);
      expect(json.data.capabilities).toContain("process.run");
    });

    it("MEMBER cannot update device policy (requires OWNER or ADMIN)", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/devices/${deviceId}/policy`,
        headers: { authorization: `Bearer ${memberToken}` },
        payload: {
          workspaceId,
          allowedRoots: ["/arbitrary/path"],
        },
      });

      expect(res.statusCode).toBe(403);
      const json = JSON.parse(res.payload);
      expect(json.error.code).toBe("FORBIDDEN_ROLE");
    });

    it("retrieves device capabilities and online status", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/devices/${deviceId}/capabilities?workspaceId=${workspaceId}`,
        headers: { authorization: `Bearer ${memberToken}` },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.success).toBe(true);
      expect(json.data.deviceId).toBe(deviceId);
      expect(json.data.capabilities).toBeDefined();
      expect(json.data.allowedRoots).toBeDefined();
    });

    it("OWNER can register a local stdio MCP server", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/devices/${deviceId}/mcp`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          workspaceId,
          serverName: "git-mcp",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-git"],
          cwd: "/Users/dev/messiah-project",
        },
      });

      expect(res.statusCode).toBe(201);
      const json = JSON.parse(res.payload);
      expect(json.success).toBe(true);
      expect(json.data.serverName).toBe("git-mcp");
      expect(json.data.command).toBe("npx");
    });

    it("retrieves list of local MCP servers for device", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/devices/${deviceId}/mcp?workspaceId=${workspaceId}`,
        headers: { authorization: `Bearer ${ownerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].serverName).toBe("git-mcp");
    });
  });

  describe("3. Task Dispatch & Execution Flow over WebSocket", () => {
    it("rejects task dispatch if device is offline", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/devices/${deviceId}/tasks`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          workspaceId,
          deviceId,
          capability: "filesystem.read",
          resourceScopes: ["/Users/dev/messiah-project"],
          parameters: { path: "README.md" },
        },
      });

      expect(res.statusCode).toBe(400);
      const json = JSON.parse(res.payload);
      expect(json.error.code).toBe("DEVICE_OFFLINE");
    });

    it("connects device via WebSocket gateway and completes challenge handshake", async () => {
      activeWs = new WebSocket(`ws://127.0.0.1:${serverPort}/api/v1/devices/connect`);

      const authenticated = await new Promise<boolean>((resolve, reject) => {
        activeWs!.on("open", () => {});
        activeWs!.on("message", async (data: Buffer) => {
          const frame = JSON.parse(data.toString());
          if (frame.type === "device.challenge") {
            const challengeFrame = frame as ServerChallengeFrame;
            const payload = deviceConnectionGateway.buildCanonicalPayload(
              deviceId,
              challengeFrame.challengeId,
              challengeFrame.nonce,
              challengeFrame.serverAudience,
              challengeFrame.protocolVersion,
              challengeFrame.expiresAt
            );
            const signature = DeviceIdentityManager.signPayload(payload, deviceIdentity.privateKey);

            const proof: BridgeAuthProofFrame = {
              type: "device.auth.proof",
              deviceId,
              challengeId: challengeFrame.challengeId,
              signature,
              timestamp: Date.now(),
              metadata: {
                platform: "darwin",
                architecture: "arm64",
                bridgeVersion: "1.0.0",
              },
            };
            activeWs!.send(JSON.stringify(proof));
          } else if (frame.type === "device.auth.success") {
            resolve(true);
          } else if (frame.type === "device.auth.failed") {
            reject(new Error(`Auth failed: ${frame.message}`));
          }
        });
        activeWs!.on("error", reject);
      });

      expect(authenticated).toBe(true);
    });

    it("dispatches task to connected workstation and receives signed dispatch frame", async () => {
      const receivedFramePromise = new Promise<DeviceTaskDispatchFrame>((resolve) => {
        const handler = (data: Buffer) => {
          const frame = JSON.parse(data.toString());
          if (frame.type === "device.task.dispatch") {
            activeWs!.off("message", handler);
            resolve(frame as DeviceTaskDispatchFrame);
          }
        };
        activeWs!.on("message", handler);
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/devices/${deviceId}/tasks`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          workspaceId,
          deviceId,
          capability: "filesystem.read",
          resourceScopes: ["/Users/dev/messiah-project/README.md"],
          parameters: { path: "README.md" },
        },
      });

      expect(res.statusCode).toBe(201);
      const json = JSON.parse(res.payload);
      expect(json.success).toBe(true);
      const taskId = json.data.id;

      const dispatchedFrame = await receivedFramePromise;
      expect(dispatchedFrame.taskId).toBe(taskId);
      expect(dispatchedFrame.capability).toBe("filesystem.read");
      expect(dispatchedFrame.serverSignature).toBeDefined();

      // Client accepts and logs progress
      activeWs!.send(
        JSON.stringify({
          type: "device.task.accepted",
          taskId,
          timestamp: Date.now(),
        })
      );

      activeWs!.send(
        JSON.stringify({
          type: "device.task.started",
          taskId,
          sandboxProfile: "native",
          timestamp: Date.now(),
        })
      );

      activeWs!.send(
        JSON.stringify({
          type: "device.task.log",
          taskId,
          sequence: 1,
          stream: "stdout",
          chunk: "# Messiah Project Readme\nWelcome to Messiah.\n",
          timestamp: Date.now(),
        })
      );

      activeWs!.send(
        JSON.stringify({
          type: "device.task.completed",
          taskId,
          result: { content: "# Messiah Project Readme\nWelcome to Messiah.\n", bytes: 42 },
          durationMs: 15,
          timestamp: Date.now(),
        })
      );

      // Verify task status in database with short polling
      let finalStatus = "";
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const checkRes = await app.inject({
          method: "GET",
          url: `/api/v1/devices/tasks/${taskId}?workspaceId=${workspaceId}`,
          headers: { authorization: `Bearer ${ownerToken}` },
        });
        const checkJson = JSON.parse(checkRes.payload);
        finalStatus = checkJson.data?.status;
        if (finalStatus === "SUCCEEDED") break;
      }

      expect(finalStatus).toBe("SUCCEEDED");

      // Verify logs
      const logsRes = await app.inject({
        method: "GET",
        url: `/api/v1/devices/tasks/${taskId}/logs?workspaceId=${workspaceId}`,
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      expect(logsRes.statusCode).toBe(200);
      const logsJson = JSON.parse(logsRes.payload);
      expect(logsJson.data.length).toBeGreaterThanOrEqual(1);
      expect(logsJson.data[0].chunk).toContain("Messiah Project Readme");
    });
  });

  describe("4. Human Approval Flow for Sensitive Operations", () => {
    let pendingTaskId: string;

    it("creates pending approval when bridge reports sensitive operation required", async () => {
      // 1. Dispatch a process run task
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/devices/${deviceId}/tasks`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          workspaceId,
          deviceId,
          capability: "process.run",
          resourceScopes: ["/Users/dev/messiah-project"],
          parameters: { command: "rm", args: ["-rf", "build"] },
        },
      });

      expect(res.statusCode).toBe(201);
      const json = JSON.parse(res.payload);
      pendingTaskId = json.data.id;

      // 2. Bridge reports approval required
      activeWs!.send(
        JSON.stringify({
          type: "device.approval.required",
          taskId: pendingTaskId,
          operation: "process.run",
          summary: "Remove build output directory",
          details: { command: "rm", args: ["-rf", "build"] },
          argumentsHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          nonce: "nonce_1234567890",
          expiresAt: Date.now() + 300000,
        })
      );

      await new Promise((r) => setTimeout(r, 100));

      // 3. Inspect task state
      const taskRes = await app.inject({
        method: "GET",
        url: `/api/v1/devices/tasks/${pendingTaskId}?workspaceId=${workspaceId}`,
        headers: { authorization: `Bearer ${ownerToken}` },
      });

      const taskJson = JSON.parse(taskRes.payload);
      expect(taskJson.data.status).toBe("AWAITING_APPROVAL");
      expect(taskJson.data.approval).toBeDefined();
      expect(taskJson.data.approval.status).toBe("PENDING");
    });

    it("OWNER approves task and receives resumed dispatch frame with approvalReference", async () => {
      const resumedFramePromise = new Promise<DeviceTaskDispatchFrame>((resolve) => {
        const handler = (data: Buffer) => {
          const frame = JSON.parse(data.toString());
          if (frame.type === "device.task.dispatch" && frame.taskId === pendingTaskId) {
            activeWs!.off("message", handler);
            resolve(frame as DeviceTaskDispatchFrame);
          }
        };
        activeWs!.on("message", handler);
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/devices/tasks/${pendingTaskId}/approve`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          workspaceId,
          action: "approve",
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.success).toBe(true);
      expect(json.data.status).toBe("DISPATCHED");

      const resumedFrame = await resumedFramePromise;
      expect(resumedFrame.approvalReference).toBeDefined();
      expect(resumedFrame.serverSignature).toBeDefined();
    });

    it("rejecting an approval marks task REJECTED and sends cancel frame", async () => {
      // 1. Create second task
      const createRes = await app.inject({
        method: "POST",
        url: `/api/v1/devices/${deviceId}/tasks`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          workspaceId,
          deviceId,
          capability: "process.run",
          resourceScopes: ["/Users/dev/messiah-project"],
          parameters: { command: "dropdb" },
        },
      });

      const secondTaskId = JSON.parse(createRes.payload).data.id;

      // 2. Report approval required
      activeWs!.send(
        JSON.stringify({
          type: "device.approval.required",
          taskId: secondTaskId,
          operation: "process.run",
          summary: "Drop database",
          details: { command: "dropdb" },
          argumentsHash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          nonce: "nonce_abcdef_123456",
          expiresAt: Date.now() + 300000,
        })
      );

      // Wait until approval is created
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const check = await prisma.bridgeTaskApproval.findFirst({
          where: { taskId: secondTaskId, status: "PENDING" },
        });
        if (check) break;
      }

      const cancelPromise = new Promise<DeviceTaskCancelFrame>((resolve) => {
        const handler = (data: Buffer) => {
          const frame = JSON.parse(data.toString());
          if (frame.type === "device.task.cancel" && frame.taskId === secondTaskId) {
            activeWs!.off("message", handler);
            resolve(frame as DeviceTaskCancelFrame);
          }
        };
        activeWs!.on("message", handler);
      });

      // 3. Reject
      const rejectRes = await app.inject({
        method: "POST",
        url: `/api/v1/devices/tasks/${secondTaskId}/reject`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          workspaceId,
          action: "reject",
          rejectionReason: "Dropping database is strictly prohibited.",
        },
      });

      expect(rejectRes.statusCode).toBe(200);
      const rejectJson = JSON.parse(rejectRes.payload);
      expect(rejectJson.data.status).toBe("FAILED");
      expect(rejectJson.data.errorMessage).toContain("Dropping database");

      const cancelFrame = await cancelPromise;
      expect(cancelFrame.taskId).toBe(secondTaskId);
      expect(cancelFrame.reason).toContain("Dropping database");
    });
  });

  describe("5. Task Cancellation & Workspace Isolation", () => {
    it("cancels an active task and dispatches cancel frame to workstation", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: `/api/v1/devices/${deviceId}/tasks`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          workspaceId,
          deviceId,
          capability: "process.run",
          resourceScopes: ["/Users/dev/messiah-project"],
          parameters: { command: "sleep", args: ["60"] },
        },
      });

      const cancelTaskId = JSON.parse(createRes.payload).data.id;

      const cancelPromise = new Promise<DeviceTaskCancelFrame>((resolve) => {
        const handler = (data: Buffer) => {
          const frame = JSON.parse(data.toString());
          if (frame.type === "device.task.cancel" && frame.taskId === cancelTaskId) {
            activeWs!.off("message", handler);
            resolve(frame as DeviceTaskCancelFrame);
          }
        };
        activeWs!.on("message", handler);
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/devices/tasks/${cancelTaskId}/cancel`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: {
          workspaceId,
          reason: "User cancelled long-running task",
        },
      });

      expect(res.statusCode).toBe(200);
      const cancelFrame = await cancelPromise;
      expect(cancelFrame.taskId).toBe(cancelTaskId);
    });

    it("User from Workspace B cannot access or dispatch tasks on Workspace A device", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/devices/${deviceId}/tasks`,
        headers: { authorization: `Bearer ${userBToken}` },
        payload: {
          workspaceId: workspaceBId,
          deviceId,
          capability: "filesystem.read",
          resourceScopes: ["/Users/dev/messiah-project"],
          parameters: { path: "README.md" },
        },
      });

      expect(res.statusCode).toBe(404);
      const json = JSON.parse(res.payload);
      expect(json.error.code).toBe("DEVICE_NOT_FOUND");
    });
  });
});
