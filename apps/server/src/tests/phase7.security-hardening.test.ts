import { PassThrough } from "node:stream";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as jose from "jose";
import WebSocket from "ws";
import { pino } from "pino";
import { prisma } from "@messiah/db";
import { buildApp } from "../app.js";
import { loadAndValidateEnv, validateProductionSecurityConfig } from "../config/env.js";
import { LOG_REDACT_PATHS } from "../utils/logger.js";
import {
  notificationService,
  sanitizeNotificationPreview,
} from "../services/notifications/index.js";
import { logAuditEvent } from "../services/auditService.js";

const TEST_SECRET = new TextEncoder().encode("messiah_test_jwt_secret_minimum_32_characters_long");
const TEST_VAULT_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async function createTestJwt(payload: { sub: string; email: string }): Promise<string> {
  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(TEST_SECRET);
}

describe("MESSIAH Phase 7 — Production Hardening, Security Audit, Notifications & Unified Approvals", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  const seed = Math.random().toString(36).slice(2, 9);
  let ownerId = "";
  let memberId = "";
  let outsiderId = "";
  let ownerToken = "";
  let memberToken = "";
  let outsiderToken = "";
  let workspaceId = "";
  let connId = "";
  let threadId = "";

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

    const [owner, member, outsider] = await Promise.all([
      prisma.user.create({
        data: {
          externalProvider: "supabase",
          externalId: `p7-owner-${seed}`,
          email: `p7.owner.${seed}@example.com`,
          fullName: "Phase 7 Owner",
        },
      }),
      prisma.user.create({
        data: {
          externalProvider: "supabase",
          externalId: `p7-member-${seed}`,
          email: `p7.member.${seed}@example.com`,
          fullName: "Phase 7 Member",
        },
      }),
      prisma.user.create({
        data: {
          externalProvider: "supabase",
          externalId: `p7-out-${seed}`,
          email: `p7.out.${seed}@example.com`,
          fullName: "Phase 7 Outsider",
        },
      }),
    ]);

    ownerId = owner.id;
    memberId = member.id;
    outsiderId = outsider.id;

    [ownerToken, memberToken, outsiderToken] = await Promise.all([
      createTestJwt({ sub: owner.externalId, email: owner.email }),
      createTestJwt({ sub: member.externalId, email: member.email }),
      createTestJwt({ sub: outsider.externalId, email: outsider.email }),
    ]);

    const ws = await prisma.workspace.create({
      data: {
        name: `Phase7 WS ${seed}`,
        slug: `p7-ws-${seed}`,
        ownerId,
        members: {
          create: [
            { userId: ownerId, role: "OWNER" },
            { userId: memberId, role: "MEMBER" },
          ],
        },
      },
    });
    workspaceId = ws.id;

    const conn = await prisma.providerConnection.create({
      data: {
        workspaceId,
        createdByUserId: ownerId,
        provider: "openai",
        displayName: "Phase 7 Test Provider",
        status: "ACTIVE",
        capabilities: { streaming: true },
      },
    });
    connId = conn.id;

    const thread = await prisma.thread.create({
      data: {
        workspaceId,
        createdByUserId: ownerId,
        title: "Phase 7 Security Thread",
        preferredProviderConnectionId: conn.id,
        preferredModelId: "gpt-4o-mini",
      },
    });
    threadId = thread.id;
  });

  afterAll(async () => {
    delete process.env.MESSIAH_METRICS_TOKEN;
    await app.close();
    await prisma.notificationItem.deleteMany({ where: { workspaceId } }).catch(() => {});
    await prisma.notificationDevice.deleteMany({ where: { userId: { in: [ownerId, memberId, outsiderId] } } }).catch(() => {});
    await prisma.notificationPreference.deleteMany({ where: { workspaceId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { workspaceId } }).catch(() => {});
    await prisma.agentRun.deleteMany({ where: { workspaceId } }).catch(() => {});
    await prisma.agentDefinition.deleteMany({ where: { workspaceId } }).catch(() => {});
    await prisma.toolApproval.deleteMany({ where: { workspaceId } }).catch(() => {});
    await prisma.toolCall.deleteMany({ where: { workspaceId } }).catch(() => {});
    await prisma.mcpServerConnection.deleteMany({ where: { workspaceId } }).catch(() => {});
    await prisma.thread.deleteMany({ where: { workspaceId } }).catch(() => {});
    await prisma.providerConnection.deleteMany({ where: { workspaceId } }).catch(() => {});
    await prisma.workspace.deleteMany({ where: { ownerId: { in: [ownerId, memberId, outsiderId] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, memberId, outsiderId] } } }).catch(() => {});
  });

  it("fails closed on insecure production configuration (vault placeholders, wildcard CORS, missing auth)", () => {
    const baseProd = {
      NODE_ENV: "production" as const,
      PORT: 3001,
      HOST: "0.0.0.0",
      DATABASE_URL: "postgresql://u:p@db:5432/messiah",
      DATABASE_POOL_MAX: 20,
      REDIS_URL: "redis://redis:6379",
      SUPABASE_URL: "https://auth.messiah.example",
      SUPABASE_ANON_KEY: "anon-key-value",
      SUPABASE_JWT_SECRET: "production_jwt_secret_minimum_32_characters_long",
      CORS_ORIGIN: "https://app.messiah.example",
      MESSIAH_ALLOWED_ORIGINS: "https://app.messiah.example",
      LOG_LEVEL: "info" as const,
      RATE_LIMIT_MAX_PER_MIN: 120,
      VAULT_ENCRYPTION_KEY: "a".repeat(64),
    };

    expect(() => validateProductionSecurityConfig(baseProd)).not.toThrow();

    expect(() =>
      validateProductionSecurityConfig({
        ...baseProd,
        VAULT_ENCRYPTION_KEY: TEST_VAULT_KEY,
      })
    ).toThrow(/VAULT_ENCRYPTION_KEY/);

    expect(() =>
      validateProductionSecurityConfig({
        ...baseProd,
        CORS_ORIGIN: "*",
        MESSIAH_ALLOWED_ORIGINS: "*",
      })
    ).toThrow(/Wildcard origin/);

    expect(() =>
      validateProductionSecurityConfig({
        ...baseProd,
        CORS_ORIGIN: "",
        MESSIAH_ALLOWED_ORIGINS: "",
      })
    ).toThrow(/MESSIAH_ALLOWED_ORIGINS/);

    expect(() =>
      validateProductionSecurityConfig({
        ...baseProd,
        SUPABASE_JWT_SECRET: undefined,
        SUPABASE_URL: undefined,
      })
    ).toThrow(/Authentication verification/);
  });

  it("redacts sensitive headers, credentials, push secrets, and pairing codes in Pino logs", async () => {
    const chunks: string[] = [];
    const stream = new PassThrough();
    stream.on("data", (chunk) => chunks.push(chunk.toString("utf8")));

    const testLogger = pino(
      {
        level: "info",
        redact: { paths: LOG_REDACT_PATHS, censor: "[REDACTED]" },
      },
      stream
    );

    testLogger.info({
      req: {
        headers: {
          authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.secretpayload.sig",
          cookie: "sb-access-token=supersecret",
        },
      },
      nested: {
        apiKey: "sk-live-secret1234567890",
        pairingCode: "PAIR-SECRET-9999",
        ciphertext: "aes256gcm:abc",
        nativePushToken: "fcm-token-secret",
        pushP256dh: "p256dh-secret",
      },
    });

    const logged = chunks.join("");
    expect(logged).toContain("[REDACTED]");
    expect(logged).not.toContain("secretpayload");
    expect(logged).not.toContain("sk-live-secret1234567890");
    expect(logged).not.toContain("PAIR-SECRET-9999");
    expect(logged).not.toContain("fcm-token-secret");
    expect(logged).not.toContain("p256dh-secret");
  });

  it("protects /metrics with optional bearer token and exports pgvector/db/redis gauges", async () => {
    delete process.env.MESSIAH_METRICS_TOKEN;
    const openRes = await app.inject({ method: "GET", url: "/metrics" });
    expect(openRes.statusCode).toBe(200);
    expect(openRes.headers["content-type"]).toContain("text/plain");
    expect(openRes.body).toContain("messiah_db_up 1");
    expect(openRes.body).toContain("messiah_pgvector_enabled 1");
    expect(openRes.body).toContain("messiah_redis_up 1");

    process.env.MESSIAH_METRICS_TOKEN = "prom_scrape_secret_token_12345";
    const unauthRes = await app.inject({ method: "GET", url: "/metrics" });
    expect(unauthRes.statusCode).toBe(401);

    const authRes = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { Authorization: "Bearer prom_scrape_secret_token_12345" },
    });
    expect(authRes.statusCode).toBe(200);
    expect(authRes.body).toContain("messiah_process_resident_memory_bytes");
    delete process.env.MESSIAH_METRICS_TOKEN;
  });

  it("scrubs secrets in notification previews, enforces deduplication, validates WebPush HTTPS, and prevents IDOR", async () => {
    const scrubbed = sanitizeNotificationPreview(
      "Run failed using sk-proj-verysecretkey1234567890 and postgres://admin:pass123@db.internal:5432/prod and Bearer abc.def.ghi"
    );
    expect(scrubbed).not.toContain("sk-proj-verysecretkey1234567890");
    expect(scrubbed).not.toContain("pass123");
    expect(scrubbed).not.toContain("abc.def.ghi");
    expect(scrubbed).toContain("[REDACTED]");

    // Reject insecure HTTP push endpoints
    const badPushRes = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/devices",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: {
        workspaceId,
        platform: "WEB_PWA",
        deviceLabel: "Insecure Push Browser",
        pushProvider: "webpush",
        pushEndpoint: "http://push.insecure.example/sub",
        pushP256dh: "BOr...testkey",
        pushAuth: "authsecret123",
      },
    });
    expect(badPushRes.statusCode).toBe(422);
    expect(badPushRes.json().error.code).toBe("INSECURE_PUSH_ENDPOINT");

    // Accept native Tauri desktop push registration & HTTPS webpush registration, plus support revocation
    const goodPushRes = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/devices",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: {
        workspaceId,
        platform: "MACOS_DESKTOP",
        deviceLabel: "MacBook Pro Desktop",
        pushProvider: "tauri",
        appVersion: "1.0.0",
      },
    });
    expect(goodPushRes.statusCode).toBe(201);
    const notifDevId = goodPushRes.json().data.id as string;

    const goodWebPushRes = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/devices",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: {
        workspaceId,
        platform: "WEB_PWA",
        deviceLabel: "Chrome PWA",
        pushProvider: "webpush",
        pushEndpoint: "https://fcm.googleapis.com/fcm/send/example-sub-1",
        pushP256dh: "BOr...testkey",
        pushAuth: "authsecret123",
      },
    });
    expect(goodWebPushRes.statusCode).toBe(201);

    // Emit notification with secret leakage attempt & open-redirect URL
    const dedupKey = `p7-dedup-${seed}`;
    const firstEmit = await notificationService.emitWorkspaceNotification({
      workspaceId,
      category: "TOOL_APPROVAL",
      title: "Approval Needed",
      preview: "Execute tool with sk-proj-secret1234567890abc",
      resourceType: "tool_approval",
      resourceId: "res-1",
      deepLink: "https://evil.example/phish",
      dedupKey,
    });
    expect(firstEmit.createdCount).toBe(2); // owner + member

    // Duplicate dedupKey must be suppressed cleanly
    const secondEmit = await notificationService.emitWorkspaceNotification({
      workspaceId,
      category: "TOOL_APPROVAL",
      title: "Approval Needed",
      preview: "Duplicate should be dropped",
      resourceType: "tool_approval",
      resourceId: "res-1",
      deepLink: "/approvals",
      dedupKey,
    });
    expect(secondEmit.createdCount).toBe(0);

    // Owner sees scrubbed preview & normalized "/" deepLink
    const listRes = await app.inject({
      method: "GET",
      url: `/api/v1/notifications?workspaceId=${workspaceId}`,
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    const listBody = listRes.json().data;
    expect(listBody.unreadCount).toBeGreaterThanOrEqual(1);
    const notif = listBody.notifications.find((n: { title: string }) => n.title === "Approval Needed");
    expect(notif).toBeTruthy();
    expect(notif.preview).not.toContain("sk-proj-secret1234567890abc");
    expect(notif.deepLink).toBe("/");

    // Outsider cannot read notifications, preferences, approvals, or audit logs
    const outNotif = await app.inject({
      method: "GET",
      url: `/api/v1/notifications?workspaceId=${workspaceId}`,
      headers: { Authorization: `Bearer ${outsiderToken}` },
    });
    expect(outNotif.statusCode).toBe(404);

    const outApprovals = await app.inject({
      method: "GET",
      url: `/api/v1/approvals?workspaceId=${workspaceId}`,
      headers: { Authorization: `Bearer ${outsiderToken}` },
    });
    expect(outApprovals.statusCode).toBe(404);

    const outAudit = await app.inject({
      method: "GET",
      url: `/api/v1/audit-logs?workspaceId=${workspaceId}`,
      headers: { Authorization: `Bearer ${outsiderToken}` },
    });
    expect(outAudit.statusCode).toBe(404);

    // Owner marks read
    const readRes = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/read",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: { workspaceId, markAll: true },
    });
    expect(readRes.statusCode).toBe(200);
    expect(readRes.json().data.updated).toBeGreaterThanOrEqual(1);

    // Outsider cannot revoke owner's device
    const stealDev = await app.inject({
      method: "DELETE",
      url: `/api/v1/notifications/devices/${notifDevId}`,
      headers: { Authorization: `Bearer ${outsiderToken}` },
    });
    expect(stealDev.statusCode).toBe(404);

    const revokeDev = await app.inject({
      method: "DELETE",
      url: `/api/v1/notifications/devices/${notifDevId}`,
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(revokeDev.statusCode).toBe(200);
  });

  it("streams workspace snapshots & live notifications over WebSocket, populates unified /approvals, and records /audit-logs", async () => {
    // Seed a pending MCP ToolApproval & Swarm AgentRun awaiting plan approval
    const mcpConn = await prisma.mcpServerConnection.create({
      data: {
        workspaceId,
        createdByUserId: ownerId,
        name: "Phase7 Mock MCP",
        transportType: "STREAMABLE_HTTP",
        endpointUrl: "https://mcp.example.local/rpc",
        status: "CONNECTED",
        authenticationStatus: "NONE",
      },
    });
    const mcpToolDef = await prisma.mcpToolDefinition.create({
      data: {
        connectionId: mcpConn.id,
        toolName: "deploy_service",
        inputSchema: { type: "object", properties: { service: { type: "string" } } },
        schemaHash: "hash-schema-1",
      },
    });
    const mcpCall = await prisma.toolCall.create({
      data: {
        workspaceId,
        threadId,
        connectionId: mcpConn.id,
        toolDefinitionId: mcpToolDef.id,
        providerCallId: `call_${seed}`,
        providerToolAlias: "mcp__phase7__deploy_service",
        toolName: "deploy_service",
        schemaHash: "hash-schema-1",
        argumentsHash: "hash-args-1",
        status: "AWAITING_APPROVAL",
        argumentsPreview: { service: "web" },
      },
    });
    await prisma.toolApproval.create({
      data: {
        toolCallId: mcpCall.id,
        workspaceId,
        requestedByUserId: ownerId,
        status: "PENDING",
        argumentsHash: "hash-args-1",
        schemaHash: "hash-schema-1",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    const supervisor = await prisma.agentDefinition.create({
      data: {
        workspaceId,
        createdByUserId: ownerId,
        name: "Phase 7 Lead",
        slug: `p7-lead-${seed}`,
        roleTitle: "Lead",
        category: "supervisor",
        canSupervise: true,
        providerConnectionId: connId,
        modelId: "gpt-4o-mini",
        systemPrompt: "Coordinate deployment.",
      },
    });

    await prisma.agentRun.create({
      data: {
        workspaceId,
        threadId,
        createdByUserId: ownerId,
        supervisorAgentId: supervisor.id,
        objective: "Prepare staging release checklist",
        status: "AWAITING_PLAN_APPROVAL",
      },
    });

    await logAuditEvent({
      workspaceId,
      actorId: ownerId,
      action: "phase7.security_check",
      resourceType: "workspace",
      resourceId: workspaceId,
      details: { verified: true },
    });

    // Verify unified /api/v1/approvals & /api/v1/audit-logs
    const [approvalsRes, auditRes] = await Promise.all([
      app.inject({
        method: "GET",
        url: `/api/v1/approvals?workspaceId=${workspaceId}`,
        headers: { Authorization: `Bearer ${ownerToken}` },
      }),
      app.inject({
        method: "GET",
        url: `/api/v1/audit-logs?workspaceId=${workspaceId}&action=phase7.security_check`,
        headers: { Authorization: `Bearer ${memberToken}` },
      }),
    ]);

    expect(approvalsRes.statusCode).toBe(200);
    const approvals = approvalsRes.json().data as Array<{ kind: string; toolName?: string }>;
    expect(approvals.some((a) => a.kind === "MCP_TOOL" && a.toolName === "deploy_service")).toBe(true);
    expect(approvals.some((a) => a.kind === "SWARM_PLAN")).toBe(true);

    expect(auditRes.statusCode).toBe(200);
    const logs = auditRes.json().data as Array<{ action: string }>;
    expect(logs.some((l) => l.action === "phase7.security_check")).toBe(true);

    // WebSocket workspace.subscribe test + cross-tenant isolation
    const ticketRes = await app.inject({
      method: "POST",
      url: "/api/v1/realtime/ticket",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: { workspaceId },
    });
    expect(ticketRes.statusCode).toBe(201);
    const ticket = ticketRes.json().data.ticket as string;

    const outTicketRes = await app.inject({
      method: "POST",
      url: "/api/v1/realtime/ticket",
      headers: { Authorization: `Bearer ${outsiderToken}` },
      payload: {},
    });
    const outTicket = outTicketRes.json().data.ticket as string;

    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 3001;

    // 1) Outsider WS workspace.subscribe must receive FORBIDDEN
    const outFrame = await new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/realtime`);
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString("utf8"));
        if (msg.event === "auth.success") {
          ws.send(JSON.stringify({ action: "workspace.subscribe", workspaceId }));
        } else if (msg.event === "error") {
          ws.close();
          resolve(msg);
        }
      });
      ws.on("open", () => {
        ws.send(JSON.stringify({ action: "auth", ticket: outTicket }));
      });
      ws.on("error", reject);
    });
    expect(outFrame.error.code).toBe("FORBIDDEN");

    // 2) Owner WS workspace.subscribe receives snapshot & live notification event
    const events = await new Promise<any[]>((resolve, reject) => {
      const received: any[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/realtime`);
      ws.on("message", async (raw) => {
        const msg = JSON.parse(raw.toString("utf8"));
        received.push(msg);
        if (msg.event === "auth.success") {
          ws.send(JSON.stringify({ action: "workspace.subscribe", workspaceId }));
        } else if (msg.event === "workspace.snapshot") {
          await notificationService.emitWorkspaceNotification({
            workspaceId,
            category: "WORKFLOW_COMPLETED",
            title: "Live Deployment Completed",
            preview: "Workflow ran cleanly.",
            resourceType: "workflow_run",
            resourceId: "wf-live-1",
            deepLink: "/workflows",
            dedupKey: `live-ws-${seed}`,
            specificUserId: ownerId,
          });
        } else if (msg.event === "notification.created") {
          ws.close();
          resolve(received);
        }
      });
      ws.on("open", () => {
        ws.send(JSON.stringify({ action: "auth", ticket }));
      });
      ws.on("error", reject);
    });

    const snapshot = events.find((e) => e.event === "workspace.snapshot");
    expect(snapshot).toBeTruthy();
    expect(snapshot.data.pendingApprovals.length).toBeGreaterThanOrEqual(2);
    const liveNotif = events.find((e) => e.event === "notification.created");
    expect(liveNotif.data.notification.title).toBe("Live Deployment Completed");
  });
});
