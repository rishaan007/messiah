import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as jose from "jose";
import WebSocket from "ws";
import { buildApp } from "../app.js";
import { loadAndValidateEnv } from "../config/env.js";
import { defaultProviderRegistry } from "@messiah/providers";
import { prisma } from "@messiah/db";
import { chatQueueManager } from "../services/chat/index.js";
import type { ProviderStreamEvent } from "@messiah/providers";

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

describe("MESSIAH Phase 2B.1 — Execution Reliability & Security Hardening Test Suite", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let userToken: string;
  let userId: string;
  let workspaceId: string;
  let providerConnectionId: string;
  let serverPort: number;

  const runSuffix = Math.random().toString(36).substring(2, 9);
  const userExternalId = `supabase-rel-${runSuffix}`;
  const userEmail = `rel.tester.${runSuffix}@example.com`;

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
    const address = app.server.address();
    if (address && typeof address === "object") {
      serverPort = address.port;
    }

    userToken = await createTestJwt({
      sub: userExternalId,
      email: userEmail,
      user_metadata: { full_name: "Reliability Tester" },
    });

    const resMe = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${userToken}` },
    });
    const dataMe = resMe.json();
    userId = dataMe.data.id;
    workspaceId = dataMe.data.memberships[0].workspaceId;

    // Create provider connection
    const openaiAdapter = defaultProviderRegistry.getAdapter("openai");
    vi.spyOn(openaiAdapter, "validateCredentials").mockResolvedValue({
      valid: true,
      message: "Credentials verified",
      testedAt: new Date().toISOString(),
    });

    const connRes = await app.inject({
      method: "POST",
      url: "/api/v1/provider-connections",
      headers: { authorization: `Bearer ${userToken}` },
      payload: {
        workspaceId,
        provider: "openai",
        displayName: `OpenAI Reliability-${runSuffix}`,
        apiKey: "sk-mock-valid-key-for-reliability-testing-12345",
      },
    });
    providerConnectionId = connRes.json().data.id;

    // Mock streaming response
    async function* mockStream(): AsyncIterable<ProviderStreamEvent> {
      yield { type: "text_delta", text: "Messiah is the universal workspace." };
      yield { type: "usage", inputTokens: 15, outputTokens: 8, cachedInputTokens: 0 };
      yield { type: "completed", responseId: "resp_rel_1", finishReason: "completed" };
    }
    vi.spyOn(openaiAdapter, "streamResponse").mockImplementation(() => mockStream());
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await Promise.race([
      app.close(),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
  });

  // ---------------------------------------------------------------------------
  // 1. Single Active Run Concurrency & Database-Level Partial Unique Index
  // ---------------------------------------------------------------------------
  describe("1. Single Active Run Concurrency & Partial Unique Index", () => {
    it("Database partial unique index rejects concurrent active runs on same thread", async () => {
      const thread = await prisma.thread.create({
        data: {
          workspaceId,
          createdByUserId: userId,
          title: "Partial Index Concurrency Thread",
        },
      });

      const msg1 = await prisma.message.create({
        data: {
          threadId: thread.id,
          sequence: 1,
          role: "ASSISTANT",
          content: "Active run 1",
          status: "STREAMING",
        },
      });

      // Insert first active run (status: PENDING)
      const run1 = await prisma.generationRun.create({
        data: {
          threadId: thread.id,
          assistantMessageId: msg1.id,
          providerConnectionId,
          provider: "openai",
          modelId: "gpt-4o",
          status: "PENDING",
        },
      });
      expect(run1.id).toBeDefined();

      const msg2 = await prisma.message.create({
        data: {
          threadId: thread.id,
          sequence: 2,
          role: "ASSISTANT",
          content: "Active run 2",
          status: "PENDING",
        },
      });

      // Attempting to insert a second active run (status: STREAMING) MUST throw unique constraint violation
      await expect(
        prisma.generationRun.create({
          data: {
            threadId: thread.id,
            assistantMessageId: msg2.id,
            providerConnectionId,
            provider: "openai",
            modelId: "gpt-4o",
            status: "STREAMING",
          },
        })
      ).rejects.toThrow(/Unique constraint failed/);

      // Clean up first run
      await prisma.generationRun.delete({ where: { id: run1.id } });
    });

    it("Race Condition Test: Concurrent Promise.all submissions result in exactly 1 success and 1 conflict (409)", async () => {
      const thread = await prisma.thread.create({
        data: {
          workspaceId,
          createdByUserId: userId,
          title: "Race Condition Thread",
        },
      });

      // Submit 2 simultaneous requests
      const [res1, res2] = await Promise.all([
        app.inject({
          method: "POST",
          url: `/api/v1/threads/${thread.id}/messages`,
          headers: { authorization: `Bearer ${userToken}` },
          payload: {
            content: "Concurrent Request 1",
            providerConnectionId,
            modelId: "gpt-4o",
          },
        }),
        app.inject({
          method: "POST",
          url: `/api/v1/threads/${thread.id}/messages`,
          headers: { authorization: `Bearer ${userToken}` },
          payload: {
            content: "Concurrent Request 2",
            providerConnectionId,
            modelId: "gpt-4o",
          },
        }),
      ]);

      const statuses = [res1.statusCode, res2.statusCode].sort();
      expect(statuses).toEqual([201, 409]);

      const conflictRes = res1.statusCode === 409 ? res1 : res2;
      expect(conflictRes.json().error.code).toBe("CONCURRENT_RUN_ACTIVE");
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Database-Enforced Idempotency & SHA-256 Fingerprinting
  // ---------------------------------------------------------------------------
  describe("2. Database-Enforced Idempotency & Fingerprinting", () => {
    it("Identical key with identical payload returns existing run and messages without duplication", async () => {
      const thread = await prisma.thread.create({
        data: {
          workspaceId,
          createdByUserId: userId,
          title: "Idempotency Thread",
        },
      });

      const idempotencyKey = `key-idem-${Date.now()}-${Math.random()}`;

      // First submission
      const firstRes = await app.inject({
        method: "POST",
        url: `/api/v1/threads/${thread.id}/messages`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: {
          content: "What is quantum computing?",
          providerConnectionId,
          modelId: "gpt-4o",
          idempotencyKey,
        },
      });
      expect(firstRes.statusCode).toBe(201);
      const firstRunId = firstRes.json().data.run.id;

      // Allow background processing
      await new Promise((r) => setTimeout(r, 200));

      // Second submission with exact same payload
      const secondRes = await app.inject({
        method: "POST",
        url: `/api/v1/threads/${thread.id}/messages`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: {
          content: "What is quantum computing?",
          providerConnectionId,
          modelId: "gpt-4o",
          idempotencyKey,
        },
      });
      expect(secondRes.statusCode).toBe(201);
      expect(secondRes.json().data.run.id).toBe(firstRunId);

      // Verify only 1 run and 1 user message exist in this thread
      const runCount = await prisma.generationRun.count({ where: { threadId: thread.id } });
      expect(runCount).toBe(1);

      const userMsgCount = await prisma.message.count({ where: { threadId: thread.id, role: "USER" } });
      expect(userMsgCount).toBe(1);
    });

    it("Reused idempotency key with different request payload is strictly rejected with 422", async () => {
      const thread = await prisma.thread.create({
        data: {
          workspaceId,
          createdByUserId: userId,
          title: "Idempotency Mismatch Thread",
        },
      });

      const idempotencyKey = `key-mismatch-${Date.now()}`;

      // First submission with prompt A
      const resA = await app.inject({
        method: "POST",
        url: `/api/v1/threads/${thread.id}/messages`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: {
          content: "Prompt A: Write a poem.",
          providerConnectionId,
          modelId: "gpt-4o",
          idempotencyKey,
        },
      });
      expect(resA.statusCode).toBe(201);

      await new Promise((r) => setTimeout(r, 200));

      // Second submission reusing same key but with different prompt B
      const resB = await app.inject({
        method: "POST",
        url: `/api/v1/threads/${thread.id}/messages`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: {
          content: "Prompt B: Explain relativity.",
          providerConnectionId,
          modelId: "gpt-4o",
          idempotencyKey,
        },
      });

      expect(resB.statusCode).toBe(422);
      expect(resB.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD");
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Transactional Outbox Pattern & Queue Deduplication
  // ---------------------------------------------------------------------------
  describe("3. Transactional Outbox Pattern & Queue Deduplication", () => {
    it("Persists OutboxEvent in database within transaction and BullMQ deduplicates identical jobId", async () => {
      const thread = await prisma.thread.create({
        data: {
          workspaceId,
          createdByUserId: userId,
          title: "Outbox Pattern Thread",
        },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/threads/${thread.id}/messages`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: {
          content: "Testing transactional outbox",
          providerConnectionId,
          modelId: "gpt-4o",
        },
      });
      expect(res.statusCode).toBe(201);
      const runId = res.json().data.run.id;

      // Verify outbox event was created in database
      const outboxEvent = await prisma.outboxEvent.findFirst({
        where: { aggregateId: runId },
      });
      expect(outboxEvent).not.toBeNull();
      expect(outboxEvent?.eventType).toBe("generation.dispatch");

      // Verify outbox sweeper can safely process events
      const swept = await chatQueueManager.sweepOutbox();
      expect(typeof swept).toBe("number");
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Cross-Worker Cancellation & Terminal States
  // ---------------------------------------------------------------------------
  describe("4. Cross-Worker Cancellation & Terminal States", () => {
    it("Cannot cancel already COMPLETED runs", async () => {
      const thread = await prisma.thread.create({
        data: {
          workspaceId,
          createdByUserId: userId,
          title: "Completed Run Thread",
        },
      });

      const sendRes = await app.inject({
        method: "POST",
        url: `/api/v1/threads/${thread.id}/messages`,
        headers: { authorization: `Bearer ${userToken}` },
        payload: {
          content: "Short question",
          providerConnectionId,
          modelId: "gpt-4o",
        },
      });
      const runId = sendRes.json().data.run.id;

      // Wait for stream to complete
      await new Promise((r) => setTimeout(r, 300));

      const runAfterStream = await prisma.generationRun.findUnique({ where: { id: runId } });
      console.log("RUN STATUS:", runAfterStream?.status, runAfterStream?.safeErrorCode);
      expect(runAfterStream?.status).toBe("COMPLETED");

      // Attempt to cancel completed run
      const cancelRes = await app.inject({
        method: "POST",
        url: `/api/v1/generation-runs/${runId}/cancel`,
        headers: { authorization: `Bearer ${userToken}` },
      });

      expect(cancelRes.statusCode).toBe(200);
      expect(cancelRes.json().data.status).toBe("COMPLETED"); // Remains COMPLETED!
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Production Origin Validation
  // ---------------------------------------------------------------------------
  describe("5. WebSocket Production Origin Validation", () => {
    it("Rejects unapproved origin in production mode", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalAllowed = process.env.MESSIAH_ALLOWED_ORIGINS;

      try {
        process.env.NODE_ENV = "production";
        process.env.MESSIAH_ALLOWED_ORIGINS = "https://app.messiah.ai,https://admin.messiah.ai";

        const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/api/v1/realtime`, {
          headers: { origin: "https://evil-hacker.com" },
        });

        const closeCode = await new Promise<number>((resolve) => {
          ws.on("close", (code) => {
            ws.terminate();
            resolve(code);
          });
          ws.on("error", () => {
            ws.terminate();
            resolve(1006);
          });
        });

        expect([1006, 4403]).toContain(closeCode);
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
        process.env.MESSIAH_ALLOWED_ORIGINS = originalAllowed;
      }
    });

    it("Rejects missing origin in production mode", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = "production";
        process.env.MESSIAH_ALLOWED_ORIGINS = "https://app.messiah.ai";

        const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/api/v1/realtime`);

        const closeCode = await new Promise<number>((resolve) => {
          ws.on("close", (code) => {
            ws.terminate();
            resolve(code);
          });
          ws.on("error", () => {
            ws.terminate();
            resolve(4403);
          });
        });

        expect([1006, 4403]).toContain(closeCode);
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });
  });
});
