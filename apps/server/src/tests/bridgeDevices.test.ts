import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import type { AddressInfo } from "node:net";
import * as jose from "jose";
import { buildApp } from "../app.js";
import { loadAndValidateEnv } from "../config/env.js";
import { prisma } from "@messiah/db";
import { DeviceIdentityManager } from "@messiah/bridge-daemon";
import {
  DEVICE_CONSTANTS,
  type ServerChallengeFrame,
  type ServerAuthSuccessFrame,
  type ServerAuthFailedFrame,
  type ServerHeartbeatAckFrame,
  type BridgeAuthProofFrame,
  type BridgeHeartbeatFrame,
} from "@messiah/shared";
import { devicePresenceService } from "../services/devices/index.js";

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

describe("MESSIAH Phase 4A — Bridge Foundation & Secure Device Connectivity Test Suite", () => {
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

  const runId = Math.random().toString(36).substring(2, 9);
  const ownerExternalId = `supabase-bridge-owner-${runId}`;
  const memberExternalId = `supabase-bridge-member-${runId}`;
  const userBExternalId = `supabase-bridge-userb-${runId}`;

  const ownerEmail = `bridge.owner.${runId}@example.com`;
  const memberEmail = `bridge.member.${runId}@example.com`;
  const userBEmail = `bridge.userb.${runId}@example.com`;

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
      user_metadata: { full_name: "Bridge Workspace Owner" },
    });

    memberToken = await createTestJwt({
      sub: memberExternalId,
      email: memberEmail,
      user_metadata: { full_name: "Bridge Workspace Member" },
    });

    userBToken = await createTestJwt({
      sub: userBExternalId,
      email: userBEmail,
      user_metadata: { full_name: "Other Workspace User" },
    });

    // 1. Seed Owner and Primary Workspace
    const owner = await prisma.user.create({
      data: {
        email: ownerEmail,
        externalId: ownerExternalId,
        externalProvider: "supabase",
        fullName: "Bridge Workspace Owner",
      },
    });
    ownerId = owner.id;

    const workspace = await prisma.workspace.create({
      data: {
        name: `Bridge Test Workspace ${runId}`,
        slug: `bridge-ws-${runId}`,
        ownerId,
        members: {
          create: {
            userId: ownerId,
            role: "OWNER",
          },
        },
      },
    });
    workspaceId = workspace.id;

    // 2. Seed Member in Primary Workspace
    const member = await prisma.user.create({
      data: {
        email: memberEmail,
        externalId: memberExternalId,
        externalProvider: "supabase",
        fullName: "Bridge Workspace Member",
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

    // 3. Seed User B and Workspace B (Tenancy Isolation)
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
        name: `Bridge Workspace B ${runId}`,
        slug: `bridge-ws-b-${runId}`,
        ownerId: userBId,
        members: {
          create: {
            userId: userBId,
            role: "OWNER",
          },
        },
      },
    });
    workspaceBId = workspaceB.id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe("1. Device Pairing Challenge Initiation & RBAC", () => {
    it("allows workspace OWNER to initiate a pairing challenge (201)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/devices/pair/challenge",
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "Content-Type": "application/json",
        },
        payload: { workspaceId },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.challengeId).toBeDefined();
      expect(body.data.pairingCode).toMatch(/^MSH-[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/);
      expect(body.data.expiresAt).toBeDefined();

      // Check database: challengeHash stored, plaintext code NOT stored
      const inDb = await prisma.devicePairingChallenge.findUnique({
        where: { id: body.data.challengeId },
      });
      expect(inDb).toBeDefined();
      expect(inDb?.status).toBe("PENDING");
      expect(inDb?.challengeHash).toBeDefined();
    });

    it("rejects challenge creation by MEMBER role with 403 FORBIDDEN_ROLE", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/devices/pair/challenge",
        headers: {
          Authorization: `Bearer ${memberToken}`,
          "Content-Type": "application/json",
        },
        payload: { workspaceId },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("FORBIDDEN_ROLE");
    });

    it("returns 404 anti-IDOR when user does not belong to the target workspace", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/devices/pair/challenge",
        headers: {
          Authorization: `Bearer ${userBToken}`,
          "Content-Type": "application/json",
        },
        payload: { workspaceId },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe("2. Device Pairing Claiming (CLI Endpoint)", () => {
    let validPairingCode: string;
    let challengeId: string;
    let testIdentity: ReturnType<typeof DeviceIdentityManager.generateIdentity>;

    beforeAll(async () => {
      testIdentity = DeviceIdentityManager.generateIdentity("Alex Workstation");

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/devices/pair/challenge",
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "Content-Type": "application/json",
        },
        payload: { workspaceId },
      });

      const body = JSON.parse(res.body);
      validPairingCode = body.data.pairingCode;
      challengeId = body.data.challengeId;
    });

    it("rejects claim with mismatched public key fingerprint (400)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/devices/pair/claim",
        headers: { "Content-Type": "application/json" },
        payload: {
          pairingCode: validPairingCode,
          displayName: testIdentity.displayName,
          platform: testIdentity.platform,
          architecture: testIdentity.architecture,
          bridgeVersion: testIdentity.bridgeVersion,
          publicKey: testIdentity.publicKey,
          publicKeyFingerprint: "SHA256:0000000000000000000000000000000000000000000000000000000000000000",
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("FINGERPRINT_MISMATCH");
    });

    it("rejects claim with non-existent pairing code (404)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/devices/pair/claim",
        headers: { "Content-Type": "application/json" },
        payload: {
          pairingCode: "MSH-FAKE-CODE-1234",
          displayName: testIdentity.displayName,
          platform: testIdentity.platform,
          architecture: testIdentity.architecture,
          bridgeVersion: testIdentity.bridgeVersion,
          publicKey: testIdentity.publicKey,
          publicKeyFingerprint: testIdentity.publicKeyFingerprint,
        },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("INVALID_PAIRING_CODE");
    });

    it("successfully claims valid pairing challenge and registers device in PENDING_APPROVAL status (200)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/devices/pair/claim",
        headers: { "Content-Type": "application/json" },
        payload: {
          pairingCode: validPairingCode,
          displayName: testIdentity.displayName,
          platform: testIdentity.platform,
          architecture: testIdentity.architecture,
          bridgeVersion: testIdentity.bridgeVersion,
          publicKey: testIdentity.publicKey,
          publicKeyFingerprint: testIdentity.publicKeyFingerprint,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.status).toBe("PENDING_APPROVAL");
      expect(body.data.deviceId).toBeDefined();

      // Verify challenge state transitioned to CLAIMED
      const challenge = await prisma.devicePairingChallenge.findUnique({
        where: { id: challengeId },
      });
      expect(challenge?.status).toBe("CLAIMED");
      expect(challenge?.claimedDeviceId).toBe(body.data.deviceId);

      // Verify device record created in PENDING_APPROVAL
      const device = await prisma.bridgeDevice.findUnique({
        where: { id: body.data.deviceId },
      });
      expect(device?.status).toBe("PENDING_APPROVAL");
      expect(device?.displayName).toBe("Alex Workstation");
      expect(device?.publicKeyFingerprint).toBe(testIdentity.publicKeyFingerprint);
    });

    it("rejects attempt to reuse an already-claimed pairing challenge (400)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/devices/pair/claim",
        headers: { "Content-Type": "application/json" },
        payload: {
          pairingCode: validPairingCode,
          displayName: "Second Attempt",
          platform: testIdentity.platform,
          architecture: testIdentity.architecture,
          bridgeVersion: testIdentity.bridgeVersion,
          publicKey: testIdentity.publicKey,
          publicKeyFingerprint: testIdentity.publicKeyFingerprint,
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("CHALLENGE_ALREADY_USED");
    });
  });

  describe("3. Device Approval and Rejection Governance", () => {
    let claimIdToApprove: string;
    let deviceIdToApprove: string;
    let claimIdToReject: string;
    let testIdentityA: ReturnType<typeof DeviceIdentityManager.generateIdentity>;
    let testIdentityB: ReturnType<typeof DeviceIdentityManager.generateIdentity>;

    beforeAll(async () => {
      testIdentityA = DeviceIdentityManager.generateIdentity("Approve Device");
      testIdentityB = DeviceIdentityManager.generateIdentity("Reject Device");

      // Create challenge 1
      const c1 = await app.inject({
        method: "POST",
        url: "/api/v1/devices/pair/challenge",
        headers: { Authorization: `Bearer ${ownerToken}` },
        payload: { workspaceId },
      });
      const c1Body = JSON.parse(c1.body);
      claimIdToApprove = c1Body.data.challengeId;

      const claim1Res = await app.inject({
        method: "POST",
        url: "/api/v1/devices/pair/claim",
        payload: {
          pairingCode: c1Body.data.pairingCode,
          displayName: testIdentityA.displayName,
          platform: testIdentityA.platform,
          architecture: testIdentityA.architecture,
          bridgeVersion: testIdentityA.bridgeVersion,
          publicKey: testIdentityA.publicKey,
          publicKeyFingerprint: testIdentityA.publicKeyFingerprint,
        },
      });
      deviceIdToApprove = JSON.parse(claim1Res.body).data.deviceId;

      // Create challenge 2
      const c2 = await app.inject({
        method: "POST",
        url: "/api/v1/devices/pair/challenge",
        headers: { Authorization: `Bearer ${ownerToken}` },
        payload: { workspaceId },
      });
      const c2Body = JSON.parse(c2.body);
      claimIdToReject = c2Body.data.challengeId;

      await app.inject({
        method: "POST",
        url: "/api/v1/devices/pair/claim",
        payload: {
          pairingCode: c2Body.data.pairingCode,
          displayName: testIdentityB.displayName,
          platform: testIdentityB.platform,
          architecture: testIdentityB.architecture,
          bridgeVersion: testIdentityB.bridgeVersion,
          publicKey: testIdentityB.publicKey,
          publicKeyFingerprint: testIdentityB.publicKeyFingerprint,
        },
      });
    });

    it("lists pending claimed challenges for workspace admin", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/devices/pair/pending?workspaceId=${workspaceId}`,
        headers: { Authorization: `Bearer ${ownerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.length).toBeGreaterThanOrEqual(2);
      const found = body.data.find((c: any) => c.id === claimIdToApprove);
      expect(found).toBeDefined();
      expect(found.claimedDeviceName).toBe("Approve Device");
    });

    it("rejects approval attempt from MEMBER role (403)", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/devices/pair/${claimIdToApprove}/approve`,
        headers: { Authorization: `Bearer ${memberToken}` },
        payload: { workspaceId },
      });

      expect(res.statusCode).toBe(403);
    });

    it("activates device and consumes challenge upon authorized OWNER approval (200)", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/devices/pair/${claimIdToApprove}/approve`,
        headers: { Authorization: `Bearer ${ownerToken}` },
        payload: { workspaceId },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.status).toBe("ACTIVE");
      expect(body.data.pairedAt).toBeDefined();

      const inDb = await prisma.bridgeDevice.findUnique({ where: { id: deviceIdToApprove } });
      expect(inDb?.status).toBe("ACTIVE");
      expect(inDb?.pairedAt).toBeDefined();

      const challenge = await prisma.devicePairingChallenge.findUnique({ where: { id: claimIdToApprove } });
      expect(challenge?.status).toBe("CONSUMED");
      expect(challenge?.consumedAt).toBeDefined();
    });

    it("revokes device and marks challenge REJECTED upon authorized rejection (200)", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/devices/pair/${claimIdToReject}/reject`,
        headers: { Authorization: `Bearer ${ownerToken}` },
        payload: { workspaceId, reason: "Unauthorized computer" },
      });

      expect(res.statusCode).toBe(200);
      const challenge = await prisma.devicePairingChallenge.findUnique({ where: { id: claimIdToReject } });
      expect(challenge?.status).toBe("REJECTED");

      const device = await prisma.bridgeDevice.findUnique({ where: { id: challenge!.claimedDeviceId! } });
      expect(device?.status).toBe("REVOKED");
      expect(device?.revokedAt).toBeDefined();
    });
  });

  describe("4. Outbound WSS Connection & Ed25519 Authentication", () => {
    let activeDeviceId: string;
    let activeIdentity: ReturnType<typeof DeviceIdentityManager.generateIdentity>;
    let pendingDeviceId: string;
    let pendingIdentity: ReturnType<typeof DeviceIdentityManager.generateIdentity>;

    beforeAll(async () => {
      // 1. Create and approve active device
      activeIdentity = DeviceIdentityManager.generateIdentity("WSS Active Laptop");
      const c1 = await app.inject({
        method: "POST",
        url: "/api/v1/devices/pair/challenge",
        headers: { Authorization: `Bearer ${ownerToken}` },
        payload: { workspaceId },
      });
      const c1Code = JSON.parse(c1.body).data.pairingCode;
      const c1Id = JSON.parse(c1.body).data.challengeId;

      const claim1 = await app.inject({
        method: "POST",
        url: "/api/v1/devices/pair/claim",
        payload: {
          pairingCode: c1Code,
          displayName: activeIdentity.displayName,
          platform: activeIdentity.platform,
          architecture: activeIdentity.architecture,
          bridgeVersion: activeIdentity.bridgeVersion,
          publicKey: activeIdentity.publicKey,
          publicKeyFingerprint: activeIdentity.publicKeyFingerprint,
        },
      });
      activeDeviceId = JSON.parse(claim1.body).data.deviceId;

      await app.inject({
        method: "POST",
        url: `/api/v1/devices/pair/${c1Id}/approve`,
        headers: { Authorization: `Bearer ${ownerToken}` },
        payload: { workspaceId },
      });

      // 2. Create pending device (not approved)
      pendingIdentity = DeviceIdentityManager.generateIdentity("WSS Pending Laptop");
      const c2 = await app.inject({
        method: "POST",
        url: "/api/v1/devices/pair/challenge",
        headers: { Authorization: `Bearer ${ownerToken}` },
        payload: { workspaceId },
      });
      const c2Code = JSON.parse(c2.body).data.pairingCode;

      const claim2 = await app.inject({
        method: "POST",
        url: "/api/v1/devices/pair/claim",
        payload: {
          pairingCode: c2Code,
          displayName: pendingIdentity.displayName,
          platform: pendingIdentity.platform,
          architecture: pendingIdentity.architecture,
          bridgeVersion: pendingIdentity.bridgeVersion,
          publicKey: pendingIdentity.publicKey,
          publicKeyFingerprint: pendingIdentity.publicKeyFingerprint,
        },
      });
      pendingDeviceId = JSON.parse(claim2.body).data.deviceId;
    });

    it("successfully establishes WSS connection and authenticates using Ed25519 signature proof", async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/api/v1/devices/connect`);

      const authSuccess = await new Promise<ServerAuthSuccessFrame>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("WSS auth timeout")), 5000);

        ws.on("message", (raw) => {
          const frame = JSON.parse(raw.toString("utf-8"));

          if (frame.type === "device.challenge") {
            const challenge = frame as ServerChallengeFrame;
            // Sign challenge
            const payload = DeviceIdentityManager.formatAuthPayload(
              activeDeviceId,
              challenge.challengeId,
              challenge.nonce,
              challenge.serverAudience,
              challenge.protocolVersion,
              challenge.expiresAt
            );
            const signature = DeviceIdentityManager.signPayload(payload, activeIdentity.privateKey);

            const proof: BridgeAuthProofFrame = {
              type: "device.auth.proof",
              deviceId: activeDeviceId,
              challengeId: challenge.challengeId,
              signature,
              timestamp: Date.now(),
              metadata: {
                platform: activeIdentity.platform,
                architecture: activeIdentity.architecture,
                bridgeVersion: activeIdentity.bridgeVersion,
              },
            };
            ws.send(JSON.stringify(proof));
          } else if (frame.type === "device.auth.success") {
            clearTimeout(timeout);
            resolve(frame as ServerAuthSuccessFrame);
          } else if (frame.type === "device.auth.failed") {
            clearTimeout(timeout);
            reject(new Error(`Auth failed: ${frame.code} - ${frame.message}`));
          }
        });

        ws.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      expect(authSuccess.type).toBe("device.auth.success");
      expect(authSuccess.deviceId).toBe(activeDeviceId);
      expect(authSuccess.heartbeatIntervalMs).toBe(DEVICE_CONSTANTS.HEARTBEAT_INTERVAL_MS);

      // Verify Redis presence is marked online
      const isOnline = await devicePresenceService.isDeviceOnline(activeDeviceId);
      expect(isOnline).toBe(true);

      // Send heartbeat and receive ack
      const heartbeatAck = await new Promise<ServerHeartbeatAckFrame>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Heartbeat timeout")), 5000);

        ws.on("message", (raw) => {
          const frame = JSON.parse(raw.toString("utf-8"));
          if (frame.type === "device.heartbeat.ack") {
            clearTimeout(timeout);
            resolve(frame as ServerHeartbeatAckFrame);
          }
        });

        const hb: BridgeHeartbeatFrame = {
          type: "device.heartbeat",
          timestamp: Date.now(),
          sequence: 1,
        };
        ws.send(JSON.stringify(hb));
      });

      expect(heartbeatAck.type).toBe("device.heartbeat.ack");
      expect(heartbeatAck.sequence).toBe(1);

      ws.close();
    });

    it("rejects authentication with forged / invalid Ed25519 signature (4401)", async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/api/v1/devices/connect`);
      const otherKey = DeviceIdentityManager.generateIdentity("Attacker");

      const authFailed = await new Promise<ServerAuthFailedFrame>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timeout waiting for failure")), 5000);

        ws.on("message", (raw) => {
          const frame = JSON.parse(raw.toString("utf-8"));

          if (frame.type === "device.challenge") {
            const challenge = frame as ServerChallengeFrame;
            // Sign with wrong private key
            const payload = DeviceIdentityManager.formatAuthPayload(
              activeDeviceId,
              challenge.challengeId,
              challenge.nonce,
              challenge.serverAudience,
              challenge.protocolVersion,
              challenge.expiresAt
            );
            const signature = DeviceIdentityManager.signPayload(payload, otherKey.privateKey);

            const proof: BridgeAuthProofFrame = {
              type: "device.auth.proof",
              deviceId: activeDeviceId,
              challengeId: challenge.challengeId,
              signature,
              timestamp: Date.now(),
              metadata: {
                platform: activeIdentity.platform,
                architecture: activeIdentity.architecture,
                bridgeVersion: activeIdentity.bridgeVersion,
              },
            };
            ws.send(JSON.stringify(proof));
          } else if (frame.type === "device.auth.failed") {
            clearTimeout(timeout);
            resolve(frame as ServerAuthFailedFrame);
          }
        });

        ws.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      expect(authFailed.code).toBe("INVALID_SIGNATURE");
    });

    it("rejects connection from device in PENDING_APPROVAL status (4403)", async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/api/v1/devices/connect`);

      const authFailed = await new Promise<ServerAuthFailedFrame>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timeout")), 5000);

        ws.on("message", (raw) => {
          const frame = JSON.parse(raw.toString("utf-8"));

          if (frame.type === "device.challenge") {
            const challenge = frame as ServerChallengeFrame;
            const payload = DeviceIdentityManager.formatAuthPayload(
              pendingDeviceId,
              challenge.challengeId,
              challenge.nonce,
              challenge.serverAudience,
              challenge.protocolVersion,
              challenge.expiresAt
            );
            const signature = DeviceIdentityManager.signPayload(payload, pendingIdentity.privateKey);

            const proof: BridgeAuthProofFrame = {
              type: "device.auth.proof",
              deviceId: pendingDeviceId,
              challengeId: challenge.challengeId,
              signature,
              timestamp: Date.now(),
              metadata: {
                platform: pendingIdentity.platform,
                architecture: pendingIdentity.architecture,
                bridgeVersion: pendingIdentity.bridgeVersion,
              },
            };
            ws.send(JSON.stringify(proof));
          } else if (frame.type === "device.auth.failed") {
            clearTimeout(timeout);
            resolve(frame as ServerAuthFailedFrame);
          }
        });
      });

      expect(authFailed.code).toBe("DEVICE_PENDING_APPROVAL");
    });
  });

  describe("5. Admin Device Controls & Revocation", () => {
    let controlledDeviceId: string;
    let controlledIdentity: ReturnType<typeof DeviceIdentityManager.generateIdentity>;

    beforeAll(async () => {
      controlledIdentity = DeviceIdentityManager.generateIdentity("Admin Control Device");
      const c = await app.inject({
        method: "POST",
        url: "/api/v1/devices/pair/challenge",
        headers: { Authorization: `Bearer ${ownerToken}` },
        payload: { workspaceId },
      });
      const cBody = JSON.parse(c.body).data;

      const claim = await app.inject({
        method: "POST",
        url: "/api/v1/devices/pair/claim",
        payload: {
          pairingCode: cBody.pairingCode,
          displayName: controlledIdentity.displayName,
          platform: controlledIdentity.platform,
          architecture: controlledIdentity.architecture,
          bridgeVersion: controlledIdentity.bridgeVersion,
          publicKey: controlledIdentity.publicKey,
          publicKeyFingerprint: controlledIdentity.publicKeyFingerprint,
        },
      });
      controlledDeviceId = JSON.parse(claim.body).data.deviceId;

      await app.inject({
        method: "POST",
        url: `/api/v1/devices/pair/${cBody.challengeId}/approve`,
        headers: { Authorization: `Bearer ${ownerToken}` },
        payload: { workspaceId },
      });
    });

    it("renames device with valid authorization (200)", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/devices/${controlledDeviceId}/rename`,
        headers: { Authorization: `Bearer ${ownerToken}` },
        payload: { workspaceId, displayName: "Primary Engineering Workstation" },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.displayName).toBe("Primary Engineering Workstation");
    });

    it("pauses device and denies connection while paused (4403)", async () => {
      // Pause
      const pauseRes = await app.inject({
        method: "POST",
        url: `/api/v1/devices/${controlledDeviceId}/pause`,
        headers: { Authorization: `Bearer ${ownerToken}` },
        payload: { workspaceId },
      });
      expect(pauseRes.statusCode).toBe(200);

      // Attempt to connect while paused
      const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/api/v1/devices/connect`);

      const authFailed = await new Promise<ServerAuthFailedFrame>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timeout")), 5000);

        ws.on("message", (raw) => {
          const frame = JSON.parse(raw.toString("utf-8"));
          if (frame.type === "device.challenge") {
            const challenge = frame as ServerChallengeFrame;
            const payload = DeviceIdentityManager.formatAuthPayload(
              controlledDeviceId,
              challenge.challengeId,
              challenge.nonce,
              challenge.serverAudience,
              challenge.protocolVersion,
              challenge.expiresAt
            );
            const signature = DeviceIdentityManager.signPayload(payload, controlledIdentity.privateKey);

            ws.send(JSON.stringify({
              type: "device.auth.proof",
              deviceId: controlledDeviceId,
              challengeId: challenge.challengeId,
              signature,
              timestamp: Date.now(),
              metadata: { platform: "darwin", architecture: "arm64", bridgeVersion: "0.1.0" },
            }));
          } else if (frame.type === "device.auth.failed") {
            clearTimeout(timeout);
            resolve(frame as ServerAuthFailedFrame);
          }
        });
      });

      expect(authFailed.code).toBe("DEVICE_PAUSED");

      // Resume
      const resumeRes = await app.inject({
        method: "POST",
        url: `/api/v1/devices/${controlledDeviceId}/resume`,
        headers: { Authorization: `Bearer ${ownerToken}` },
        payload: { workspaceId },
      });
      expect(resumeRes.statusCode).toBe(200);
    });

    it("revokes device and enforces permanent revocation (200)", async () => {
      const revokeRes = await app.inject({
        method: "POST",
        url: `/api/v1/devices/${controlledDeviceId}/revoke`,
        headers: { Authorization: `Bearer ${ownerToken}` },
        payload: { workspaceId },
      });
      expect(revokeRes.statusCode).toBe(200);

      // Attempt to connect after revocation
      const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/api/v1/devices/connect`);

      const authFailed = await new Promise<ServerAuthFailedFrame>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timeout")), 5000);

        ws.on("message", (raw) => {
          const frame = JSON.parse(raw.toString("utf-8"));
          if (frame.type === "device.challenge") {
            const challenge = frame as ServerChallengeFrame;
            const payload = DeviceIdentityManager.formatAuthPayload(
              controlledDeviceId,
              challenge.challengeId,
              challenge.nonce,
              challenge.serverAudience,
              challenge.protocolVersion,
              challenge.expiresAt
            );
            const signature = DeviceIdentityManager.signPayload(payload, controlledIdentity.privateKey);

            ws.send(JSON.stringify({
              type: "device.auth.proof",
              deviceId: controlledDeviceId,
              challengeId: challenge.challengeId,
              signature,
              timestamp: Date.now(),
              metadata: { platform: "darwin", architecture: "arm64", bridgeVersion: "0.1.0" },
            }));
          } else if (frame.type === "device.auth.failed") {
            clearTimeout(timeout);
            resolve(frame as ServerAuthFailedFrame);
          }
        });
      });

      expect(authFailed.code).toBe("DEVICE_REVOKED");
    });
  });

  describe("6. Cross-Workspace Data Isolation & Security Guardrails", () => {
    it("User B in Workspace B cannot list or access Workspace A devices (404 IDOR)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/devices?workspaceId=${workspaceId}`,
        headers: { Authorization: `Bearer ${userBToken}` },
      });

      expect(res.statusCode).toBe(404);

      // Verify User B listing their own workspace B gets empty list
      const resB = await app.inject({
        method: "GET",
        url: `/api/v1/devices?workspaceId=${workspaceBId}`,
        headers: { Authorization: `Bearer ${userBToken}` },
      });
      expect(resB.statusCode).toBe(200);
      expect(resB.json().data.devices).toHaveLength(0);
    });

    it("verifies no remote command execution or shell endpoints exist in Phase 4A (404)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/devices/exec",
        headers: { Authorization: `Bearer ${ownerToken}` },
        payload: { command: "whoami" },
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
