import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as jose from "jose";
import { buildApp } from "../app.js";
import { loadAndValidateEnv } from "../config/env.js";
import { defaultProviderRegistry } from "@messiah/providers";
import { prisma } from "@messiah/db";
import { ticketService } from "../services/chat/ticketService.js";
import { ReconciliationService } from "../services/chat/reconciliationService.js";
import { streamPublisher } from "../services/chat/streamPublisher.js";
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

describe("MESSIAH Phase 2B — Universal AI Chat & Realtime Streaming Engine Test Suite", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let userAToken: string;
  let userBToken: string;
  let userAId: string;
  let userAWorkspaceId: string;
  let providerConnectionId: string;
  let serverPort: number;

  const runSuffix = Math.random().toString(36).substring(2, 9);
  const userAExternalId = `supabase-chat-a-${runSuffix}`;
  const userBExternalId = `supabase-chat-b-${runSuffix}`;
  const userAEmail = `chat.alex.${runSuffix}@example.com`;
  const userBEmail = `chat.elena.${runSuffix}@example.com`;

  beforeAll(async () => {
    process.env.VAULT_ENCRYPTION_KEY = TEST_VAULT_KEY;

    const testEnv = loadAndValidateEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "fatal",
      SUPABASE_JWT_SECRET: "messiah_test_jwt_secret_minimum_32_characters_long",
      VAULT_ENCRYPTION_KEY: TEST_VAULT_KEY,
    });

    app = await buildApp({ env: testEnv, logger: false });

    // Start listening on an ephemeral port so native WebSockets can connect
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address && typeof address === "object") {
      serverPort = address.port;
    }

    userAToken = await createTestJwt({
      sub: userAExternalId,
      email: userAEmail,
      user_metadata: { full_name: "Alex Chat Architect" },
    });

    userBToken = await createTestJwt({
      sub: userBExternalId,
      email: userBEmail,
      user_metadata: { full_name: "Elena Chat Member" },
    });

    // 1. Resolve User A and their personal workspace
    const resA = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${userAToken}` },
    });
    const dataA = resA.json();
    userAId = dataA.data.id;
    userAWorkspaceId = dataA.data.memberships[0].workspaceId;

    // 2. Resolve User B
    await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${userBToken}` },
    });

    // 3. Create an active provider connection for User A
    const openaiAdapter = defaultProviderRegistry.getAdapter("openai");
    vi.spyOn(openaiAdapter, "validateCredentials").mockResolvedValue({
      valid: true,
      message: "Credentials verified",
      testedAt: new Date().toISOString(),
    });

    const connRes = await app.inject({
      method: "POST",
      url: "/api/v1/provider-connections",
      headers: { authorization: `Bearer ${userAToken}` },
      payload: {
        workspaceId: userAWorkspaceId,
        provider: "openai",
        displayName: "OpenAI Main Chat",
        apiKey: "sk-proj-test-streaming-key-1234567890",
      },
    });

    expect(connRes.statusCode).toBe(201);
    providerConnectionId = connRes.json().data.id;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  // ---------------------------------------------------------------------------
  // 1. THREAD CRUD & WORKSPACE ISOLATION (ANTI-IDOR)
  // ---------------------------------------------------------------------------
  describe("1. Thread Management & Workspace Isolation (Anti-IDOR)", () => {
    let createdThreadId: string;

    it("POST /api/v1/threads should create a new conversation thread in workspace", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/threads",
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          workspaceId: userAWorkspaceId,
          title: "Neural Engine Architecture",
          preferredProviderConnectionId: providerConnectionId,
          preferredModelId: "gpt-4o",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.id).toBeDefined();
      expect(body.data.title).toBe("Neural Engine Architecture");
      expect(body.data.workspaceId).toBe(userAWorkspaceId);
      expect(body.data.archivedAt).toBeNull();

      createdThreadId = body.data.id;
    });

    it("GET /api/v1/threads/:threadId should retrieve the thread for authorized user", async () => {
      expect(createdThreadId).toBeDefined();
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/threads/${createdThreadId}`,
        headers: { authorization: `Bearer ${userAToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.id).toBe(createdThreadId);
      expect(body.data.title).toBe("Neural Engine Architecture");
    });

    it("GET /api/v1/threads should list threads filtered by workspace", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/threads?workspaceId=${userAWorkspaceId}&limit=10`,
        headers: { authorization: `Bearer ${userAToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      expect(body.data.some((t: any) => t.id === createdThreadId)).toBe(true);
    });

    it("PATCH /api/v1/threads/:threadId should update thread title and archived status", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/threads/${createdThreadId}`,
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          title: "Archived Neural Engine Architecture",
          archived: true,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.title).toBe("Archived Neural Engine Architecture");
      expect(body.data.archivedAt).not.toBeNull();
    });

    it("ANTI-IDOR: User B from different workspace accessing User A thread must receive 404", async () => {
      // 1. GET attempt
      const getRes = await app.inject({
        method: "GET",
        url: `/api/v1/threads/${createdThreadId}`,
        headers: { authorization: `Bearer ${userBToken}` },
      });
      expect(getRes.statusCode).toBe(404);
      expect(getRes.json().error.code).toBe("THREAD_NOT_FOUND");

      // 2. PATCH attempt
      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/v1/threads/${createdThreadId}`,
        headers: { authorization: `Bearer ${userBToken}` },
        payload: { title: "Malicious Tampering" },
      });
      expect(patchRes.statusCode).toBe(404);

      // 3. DELETE attempt
      const delRes = await app.inject({
        method: "DELETE",
        url: `/api/v1/threads/${createdThreadId}`,
        headers: { authorization: `Bearer ${userBToken}` },
      });
      expect(delRes.statusCode).toBe(404);
    });

    it("DELETE /api/v1/threads/:threadId should delete the thread for authorized user", async () => {
      const delRes = await app.inject({
        method: "DELETE",
        url: `/api/v1/threads/${createdThreadId}`,
        headers: { authorization: `Bearer ${userAToken}` },
      });

      expect(delRes.statusCode).toBe(200);
      expect(delRes.json().data.deleted).toBe(true);

      // Verify it no longer exists
      const verifyRes = await app.inject({
        method: "GET",
        url: `/api/v1/threads/${createdThreadId}`,
        headers: { authorization: `Bearer ${userAToken}` },
      });
      expect(verifyRes.statusCode).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. CONVERSATION MESSAGES & CONCURRENCY & IDEMPOTENCY
  // ---------------------------------------------------------------------------
  describe("2. Messages, Concurrency Locks & Idempotency", () => {
    let testThreadId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/threads",
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          workspaceId: userAWorkspaceId,
          title: "Message Streaming Flow",
          preferredProviderConnectionId: providerConnectionId,
          preferredModelId: "gpt-4o",
        },
      });
      testThreadId = res.json().data.id;
    });

    it("POST /api/v1/threads/:threadId/messages creates user msg, assistant placeholder, and run", async () => {
      const openaiAdapter = defaultProviderRegistry.getAdapter("openai");

      // Mock streaming chunks
      async function* mockStream(): AsyncGenerator<ProviderStreamEvent, void, unknown> {
        yield { type: "text_delta", text: "Messiah is " };
        yield { type: "text_delta", text: "the universal workspace." };
        yield { type: "usage", inputTokens: 15, outputTokens: 8, cachedInputTokens: 0 };
        yield { type: "completed", finishReason: "stop" };
      }
      vi.spyOn(openaiAdapter, "streamResponse").mockImplementation(() => mockStream());

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/threads/${testThreadId}/messages`,
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          content: "What is Messiah?",
          providerConnectionId,
          modelId: "gpt-4o",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.userMessage.role).toBe("USER");
      expect(body.data.userMessage.content).toBe("What is Messiah?");
      expect(body.data.userMessage.status).toBe("COMPLETED");

      expect(body.data.assistantMessage.role).toBe("ASSISTANT");
      expect(body.data.assistantMessage.status).toBe("PENDING");

      expect(body.data.run.status).toBe("PENDING");
      expect(body.data.run.modelId).toBe("gpt-4o");

      // Wait a moment for background stream worker to finish
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify the assistant message was updated in database
      const assistantInDb = await prisma.message.findUnique({
        where: { id: body.data.assistantMessage.id },
      });
      expect(assistantInDb?.status).toBe("COMPLETED");
      expect(assistantInDb?.content).toBe("Messiah is the universal workspace.");

      // Verify run status was updated
      const runInDb = await prisma.generationRun.findUnique({
        where: { id: body.data.run.id },
      });
      expect(runInDb?.status).toBe("COMPLETED");
      expect(runInDb?.inputTokens).toBe(15);
      expect(runInDb?.outputTokens).toBe(8);
    });

    it("CONCURRENCY GUARD: Should reject concurrent run on same thread with 409", async () => {
      // Simulate an active run in database
      const activeRun = await prisma.generationRun.create({
        data: {
          threadId: testThreadId,
          assistantMessageId: (await prisma.message.findFirst({ where: { threadId: testThreadId } }))!.id,
          providerConnectionId,
          provider: "openai",
          modelId: "gpt-4o",
          status: "STREAMING",
        },
      });

      try {
        const res = await app.inject({
          method: "POST",
          url: `/api/v1/threads/${testThreadId}/messages`,
          headers: { authorization: `Bearer ${userAToken}` },
          payload: {
            content: "Another concurrent question",
            providerConnectionId,
            modelId: "gpt-4o",
          },
        });

        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe("CONCURRENT_RUN_ACTIVE");
      } finally {
        // Clean up simulated active run
        await prisma.generationRun.delete({ where: { id: activeRun.id } });
      }
    });

    it("IDEMPOTENCY: Re-sending message with same idempotencyKey returns existing records without duplicate", async () => {
      const idempotencyKey = `idem-${Date.now()}-${Math.random()}`;

      // First call
      const firstRes = await app.inject({
        method: "POST",
        url: `/api/v1/threads/${testThreadId}/messages`,
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          content: "Idempotent question",
          providerConnectionId,
          modelId: "gpt-4o",
          idempotencyKey,
        },
      });
      expect(firstRes.statusCode).toBe(201);
      const firstData = firstRes.json().data;

      // Wait for stream worker
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Second call with identical idempotencyKey
      const secondRes = await app.inject({
        method: "POST",
        url: `/api/v1/threads/${testThreadId}/messages`,
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          content: "Idempotent question",
          providerConnectionId,
          modelId: "gpt-4o",
          idempotencyKey,
        },
      });
      expect(secondRes.statusCode).toBe(201);
      const secondData = secondRes.json().data;

      // Must point to the exact same run and assistant message
      expect(secondData.run.id).toBe(firstData.run.id);
      expect(secondData.assistantMessage.id).toBe(firstData.assistantMessage.id);
    });

    it("GET /api/v1/threads/:threadId/messages returns messages with sequence ordering and pagination", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/threads/${testThreadId}/messages?limit=10`,
        headers: { authorization: `Bearer ${userAToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThanOrEqual(2);

      // Verify monotonic sequence numbering
      for (let i = 1; i < body.data.length; i++) {
        expect(body.data[i].sequence).toBeGreaterThan(body.data[i - 1].sequence);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 3. RUN CANCELLATION & ABORT SIGNAL PROPAGATION
  // ---------------------------------------------------------------------------
  describe("3. Run Cancellation Propagation", () => {
    let cancelThreadId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/threads",
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          workspaceId: userAWorkspaceId,
          title: "Cancellation Test Thread",
          preferredProviderConnectionId: providerConnectionId,
          preferredModelId: "gpt-4o",
        },
      });
      cancelThreadId = res.json().data.id;
    });

    it("POST /api/v1/generation-runs/:runId/cancel should abort active stream and mark CANCELLED", async () => {
      const openaiAdapter = defaultProviderRegistry.getAdapter("openai");

      // Slow generator that yields and waits
      async function* slowStream(signal?: AbortSignal): AsyncGenerator<ProviderStreamEvent, void, unknown> {
        yield { type: "text_delta", text: "Starting long process..." };
        for (let i = 0; i < 30; i++) {
          if (signal?.aborted) return;
          await new Promise((r) => setTimeout(r, 100));
          yield { type: "text_delta", text: ` Step ${i}` };
        }
      }

      vi.spyOn(openaiAdapter, "streamResponse").mockImplementation((_req, signal) => slowStream(signal));

      const sendRes = await app.inject({
        method: "POST",
        url: `/api/v1/threads/${cancelThreadId}/messages`,
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          content: "Execute a long task",
          providerConnectionId,
          modelId: "gpt-4o",
        },
      });
      const runId = sendRes.json().data.run.id;

      // Small delay so stream starts
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Call cancel endpoint
      const cancelRes = await app.inject({
        method: "POST",
        url: `/api/v1/generation-runs/${runId}/cancel`,
        headers: { authorization: `Bearer ${userAToken}` },
        payload: { reason: "User pressed stop button" },
      });

      expect(cancelRes.statusCode).toBe(200);
      expect(cancelRes.json().data.status).toBe("CANCELLED");

      // Wait a moment for abort to propagate to database
      await new Promise((resolve) => setTimeout(resolve, 100));

      const runInDb = await prisma.generationRun.findUnique({ where: { id: runId } });
      expect(runInDb?.status).toBe("CANCELLED");

      const msgInDb = await prisma.message.findUnique({ where: { id: sendRes.json().data.assistantMessage.id } });
      expect(msgInDb?.status).toBe("CANCELLED");
    });
  });

  // ---------------------------------------------------------------------------
  // 4. REALTIME TICKET SERVICE & STARTUP RECONCILIATION
  // ---------------------------------------------------------------------------
  describe("4. Realtime Ticket Service & Startup Reconciliation", () => {
    it("POST /api/v1/realtime/ticket issues a single-use 30s ticket and second use fails", async () => {
      const ticketRes = await app.inject({
        method: "POST",
        url: "/api/v1/realtime/ticket",
        headers: { authorization: `Bearer ${userAToken}` },
        payload: { workspaceId: userAWorkspaceId },
      });

      expect(ticketRes.statusCode).toBe(201);
      const { ticket, expiresInSeconds } = ticketRes.json().data;
      expect(ticket).toBeDefined();
      expect(expiresInSeconds).toBe(30);

      // Consume once: should succeed
      const payload1 = await ticketService.consumeTicket(ticket);
      expect(payload1).not.toBeNull();
      expect(payload1?.userId).toBe(userAId);
      expect(payload1?.workspaceId).toBe(userAWorkspaceId);

      // Consume second time: should fail atomically (single-use)
      const payload2 = await ticketService.consumeTicket(ticket);
      expect(payload2).toBeNull();
    });

    it("ReconciliationService heals orphaned STREAMING runs to FAILED", async () => {
      // Create orphaned records in DB
      const orphanThread = await prisma.thread.create({
        data: {
          workspaceId: userAWorkspaceId,
          createdByUserId: userAId,
          title: "Orphaned Run Thread",
        },
      });

      const orphanMsg = await prisma.message.create({
        data: {
          threadId: orphanThread.id,
          sequence: 1,
          role: "ASSISTANT",
          content: "Partial content before crash...",
          status: "STREAMING",
        },
      });

      const orphanRun = await prisma.generationRun.create({
        data: {
          threadId: orphanThread.id,
          assistantMessageId: orphanMsg.id,
          providerConnectionId,
          provider: "openai",
          modelId: "gpt-4o",
          status: "STREAMING",
        },
      });

      // Execute reconciliation
      const result = await ReconciliationService.reconcileOrphanedRuns();
      expect(result.reconciledRuns).toBeGreaterThanOrEqual(1);

      // Verify healed state
      const healedRun = await prisma.generationRun.findUnique({ where: { id: orphanRun.id } });
      expect(healedRun?.status).toBe("FAILED");
      expect(healedRun?.safeErrorCode).toBe("SERVER_RESTARTED_DURING_EXECUTION");

      const healedMsg = await prisma.message.findUnique({ where: { id: orphanMsg.id } });
      expect(healedMsg?.status).toBe("FAILED");
    });
  });

  // ---------------------------------------------------------------------------
  // 5. WEBSOCKET REALTIME GATEWAY & STREAMING EVENTS
  // ---------------------------------------------------------------------------
  describe("5. WebSocket Realtime Gateway & Multiplexing", () => {
    it("WebSocket rejects connection with invalid/expired ticket", async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/api/v1/realtime`);

      const receivedFrames: any[] = [];
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          // Send invalid ticket auth frame
          ws.send(JSON.stringify({ action: "auth", ticket: "invalid-bogus-ticket-token" }));
        };
        ws.onmessage = (event) => {
          receivedFrames.push(JSON.parse(event.data.toString()));
        };
        ws.onclose = () => {
          resolve();
        };
        ws.onerror = (err) => {
          reject(err);
        };
      });

      expect(receivedFrames.some((f) => f.event === "auth.failed")).toBe(true);
    });

    it("WebSocket connects with valid ticket, subscribes to thread, and receives published stream events", async () => {
      // 1. Get ticket
      const ticketRes = await app.inject({
        method: "POST",
        url: "/api/v1/realtime/ticket",
        headers: { authorization: `Bearer ${userAToken}` },
        payload: { workspaceId: userAWorkspaceId },
      });
      const validTicket = ticketRes.json().data.ticket;

      // 2. Create a test thread to subscribe to
      const threadRes = await app.inject({
        method: "POST",
        url: "/api/v1/threads",
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          workspaceId: userAWorkspaceId,
          title: "Realtime WebSocket Test Thread",
        },
      });
      const wsThreadId = threadRes.json().data.id;

      // 3. Connect via WebSocket
      const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/api/v1/realtime`);
      const receivedEvents: any[] = [];

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          // Send auth frame
          ws.send(JSON.stringify({ action: "auth", ticket: validTicket }));
        };

        ws.onmessage = async (event) => {
          const frame = JSON.parse(event.data.toString());
          receivedEvents.push(frame);

          if (frame.event === "auth.success") {
            // Subscribe to thread
            ws.send(JSON.stringify({ action: "thread.subscribe", threadId: wsThreadId }));
          }

          if (frame.event === "thread.snapshot") {
            // Once subscribed, publish an event via streamPublisher
            await streamPublisher.publish({
              type: "message.delta",
              threadId: wsThreadId,
              runId: "run-mock-test-123",
              messageId: "msg-mock-test-123",
              sequence: 1,
              timestamp: new Date().toISOString(),
              payload: { delta: "Realtime token delivery test" },
            });
          }

          if (frame.event === "message.delta") {
            // Event received over WebSocket!
            ws.close();
            resolve();
          }
        };

        ws.onerror = (err) => reject(err);
      });

      expect(receivedEvents.some((e) => e.event === "auth.success")).toBe(true);
      expect(receivedEvents.some((e) => e.event === "thread.snapshot")).toBe(true);
      expect(receivedEvents.some((e) => e.event === "message.delta" && e.data.delta === "Realtime token delivery test")).toBe(true);
    });
  });
});
