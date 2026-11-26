import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as jose from "jose";
import WebSocket from "ws";
import { buildApp } from "../app.js";
import { loadAndValidateEnv } from "../config/env.js";
import { prisma } from "@messiah/db";
import {
  defaultProviderRegistry,
  type IProviderAdapter,
  type ProviderEmbedRequest,
  type ProviderStreamEvent,
  type ProviderStreamRequest,
} from "@messiah/providers";
import { VaultService } from "../services/vaultService.js";
import { workflowEventRouter } from "../services/workflows/index.js";

const TEST_SECRET = new TextEncoder().encode("messiah_test_jwt_secret_minimum_32_characters_long");
const TEST_VAULT_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async function createTestJwt(payload: { sub: string; email: string }): Promise<string> {
  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(TEST_SECRET);
}

describe("MESSIAH Phase 6 — Vector Memory & Visual Workflow Automation Integration", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let originalOpenAIAdapter: IProviderAdapter;

  const seed = Math.random().toString(36).slice(2, 9);
  let ownerId = "";
  let memberId = "";
  let outsiderId = "";
  let ownerToken = "";
  let memberToken = "";
  let outsiderToken = "";
  let workspaceId = "";
  let connId = "";
  let agentId = "";

  const observedChatSystemPrompts: string[] = [];

  beforeAll(async () => {
    process.env.VAULT_ENCRYPTION_KEY = TEST_VAULT_KEY;
    originalOpenAIAdapter = defaultProviderRegistry.getAdapter("openai");

    const fakeAdapter: IProviderAdapter = {
      id: originalOpenAIAdapter.id,
      metadata: originalOpenAIAdapter.metadata,
      getCapabilities: () => originalOpenAIAdapter.getCapabilities(),
      getProviderMetadata: () => originalOpenAIAdapter.getProviderMetadata(),
      validateCredentials: (creds) => originalOpenAIAdapter.validateCredentials(creds),
      listModels: (creds) => originalOpenAIAdapter.listModels(creds),
      async *streamResponse(request: ProviderStreamRequest): AsyncIterable<ProviderStreamEvent> {
        const sys =
          request.systemPrompt ||
          request.messages.find((m) => m.role === "system")?.content ||
          "";
        observedChatSystemPrompts.push(sys);

        yield {
          type: "text_delta",
          text: `Automated verification report generated cleanly. Severity: high finding noted for review.`,
        };
        yield { type: "usage", inputTokens: 60, outputTokens: 30 };
        yield { type: "completed", finishReason: "stop" };
      },
      async embedTexts(request: ProviderEmbedRequest) {
        const dims = request.dimensions || 1536;
        return {
          provider: "openai",
          model: request.model || "text-embedding-3-small",
          dimensions: dims,
          embeddings: request.texts.map((text) => {
            const vec = new Array<number>(dims).fill(0);
            const lower = text.toLowerCase();
            vec[0] = lower.includes("deployment") || lower.includes("postgres") ? 0.92 : 0.2;
            vec[1] = lower.includes("secret") ? 0.85 : 0.3;
            vec[2] = 0.25;
            const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
            return vec.map((v) => v / norm);
          }),
          totalTokens: request.texts.length * 8,
        };
      },
    };
    defaultProviderRegistry.registerAdapter(fakeAdapter);

    const testEnv = loadAndValidateEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "fatal",
      SUPABASE_JWT_SECRET: "messiah_test_jwt_secret_minimum_32_characters_long",
      VAULT_ENCRYPTION_KEY: TEST_VAULT_KEY,
    });

    app = await buildApp({ env: testEnv, logger: false });
    await app.listen({ port: 0, host: "127.0.0.1" });

    const owner = await prisma.user.create({
      data: {
        externalProvider: "supabase",
        externalId: `p6-owner-${seed}`,
        email: `p6.owner.${seed}@example.com`,
        fullName: "Phase 6 Owner",
      },
    });
    const member = await prisma.user.create({
      data: {
        externalProvider: "supabase",
        externalId: `p6-member-${seed}`,
        email: `p6.member.${seed}@example.com`,
        fullName: "Phase 6 Member",
      },
    });
    const outsider = await prisma.user.create({
      data: {
        externalProvider: "supabase",
        externalId: `p6-out-${seed}`,
        email: `p6.out.${seed}@example.com`,
        fullName: "Phase 6 Outsider",
      },
    });

    ownerId = owner.id;
    memberId = member.id;
    outsiderId = outsider.id;

    ownerToken = await createTestJwt({ sub: owner.externalId, email: owner.email });
    memberToken = await createTestJwt({ sub: member.externalId, email: member.email });
    outsiderToken = await createTestJwt({ sub: outsider.externalId, email: outsider.email });

    const ws = await prisma.workspace.create({
      data: {
        name: `Phase6 WS ${seed}`,
        slug: `p6-ws-${seed}`,
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
        displayName: "Test OpenAI Vector & Chat",
        status: "ACTIVE",
        capabilities: { streaming: true, embeddings: true },
      },
    });
    connId = conn.id;

    const vault = new VaultService();
    const enc = vault.encrypt("sk-fake-test-credential-value-not-real", {
      workspaceId,
      providerConnectionId: conn.id,
      provider: "openai",
      keyVersion: "v1",
    });

    await prisma.encryptedCredential.create({
      data: {
        providerConnectionId: conn.id,
        ciphertext: enc.ciphertext,
        initializationVector: enc.initializationVector,
        authenticationTag: enc.authenticationTag,
        keyVersion: enc.keyVersion,
      },
    });

    const agent = await prisma.agentDefinition.create({
      data: {
        workspaceId,
        createdByUserId: ownerId,
        name: "Phase6 Analyst",
        slug: `p6-analyst-${seed}`,
        roleTitle: "Reviewer & Analyst",
        category: "reviewer",
        canSupervise: true,
        providerConnectionId: conn.id,
        modelId: "gpt-4o-mini",
        systemPrompt: "You analyze technical workflows concisely.",
      },
    });
    agentId = agent.id;
  });

  afterAll(async () => {
    defaultProviderRegistry.registerAdapter(originalOpenAIAdapter);
    await app.close();
    await prisma.workflowRun.deleteMany({ where: { workspaceId } }).catch(() => {});
    await prisma.workflowDefinition.deleteMany({ where: { workspaceId } }).catch(() => {});
    await prisma.agentRun.deleteMany({ where: { workspaceId } }).catch(() => {});
    await prisma.agentDefinition.deleteMany({ where: { workspaceId } }).catch(() => {});
    await prisma.thread.deleteMany({ where: { workspaceId } }).catch(() => {});
    await prisma.providerConnection.deleteMany({ where: { workspaceId } }).catch(() => {});
    await prisma.workspace.deleteMany({ where: { ownerId: { in: [ownerId, memberId, outsiderId] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, memberId, outsiderId] } } }).catch(() => {});
  });

  it("enforces secret rejection, scoped Personal/Workspace RBAC, pgvector retrieval, and revision history via HTTP API", async () => {
    // 1. Secret rejection on POST /api/v1/memories
    const secretRes = await app.inject({
      method: "POST",
      url: "/api/v1/memories",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: {
        workspaceId,
        scope: "WORKSPACE",
        title: "Bad secret note",
        content: "api_key is sk-proj-secret1234567890abcdef12345",
      },
    });
    expect(secretRes.statusCode).toBe(422);
    expect(secretRes.json().error.code).toBe("MEMORY_SECRET_REJECTED");

    // 2. Owner creates private PERSONAL memory + shared WORKSPACE memory
    const privRes = await app.inject({
      method: "POST",
      url: "/api/v1/memories",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: {
        workspaceId,
        scope: "PERSONAL",
        sourceType: "PREFERENCE",
        title: "Owner Personal Deployment Note",
        content: "Always run canary postgres deployment migrations first.",
        tags: ["deployment"],
      },
    });
    if (privRes.statusCode !== 201) {
      throw new Error(`privRes unexpected ${privRes.statusCode}: ${privRes.body}`);
    }
    expect(privRes.statusCode).toBe(201);
    const privId = privRes.json().data.id;

    const sharedRes = await app.inject({
      method: "POST",
      url: "/api/v1/memories",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: {
        workspaceId,
        scope: "WORKSPACE",
        sourceType: "WORKSPACE_DECISION",
        title: "Workspace Deployment Standard",
        content: "Zero-downtime blue/green rollout required for postgres changes.",
        tags: ["deployment"],
      },
    });
    expect(sharedRes.statusCode).toBe(201);
    const sharedId = sharedRes.json().data.id;

    // 3. Member searches PERSONAL + WORKSPACE -> receives WORKSPACE only, NEVER owner's PERSONAL!
    const memberSearchRes = await app.inject({
      method: "POST",
      url: "/api/v1/memories/search",
      headers: { Authorization: `Bearer ${memberToken}` },
      payload: {
        workspaceId,
        query: "postgres deployment",
        scopes: ["PERSONAL", "WORKSPACE"],
        topK: 10,
      },
    });
    expect(memberSearchRes.statusCode).toBe(200);
    const foundIds = memberSearchRes.json().data.matches.map((m: any) => m.memory.id);
    expect(foundIds).toContain(sharedId);
    expect(foundIds).not.toContain(privId);

    // 4. Member direct GET on Owner's personal memory returns 404 (no IDOR)
    const idorGet = await app.inject({
      method: "GET",
      url: `/api/v1/memories/${privId}?workspaceId=${workspaceId}`,
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    expect(idorGet.statusCode).toBe(404);

    // 5. Outsider denied completely
    const outsiderRes = await app.inject({
      method: "GET",
      url: `/api/v1/memories?workspaceId=${workspaceId}`,
      headers: { Authorization: `Bearer ${outsiderToken}` },
    });
    expect(outsiderRes.statusCode).toBe(404);

    // 6. Edit creates MemoryVersion v2
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/memories/${sharedId}`,
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: {
        workspaceId,
        content: "Zero-downtime blue/green rollout + automatic backup required for postgres changes.",
        changeReason: "Added backup rule",
      },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().data.currentVersion).toBe(2);
    expect(patchRes.json().data.versions.length).toBeGreaterThanOrEqual(2);
  });

  it("injects authorized Workspace & Personal memory safely into Universal Chat execution", async () => {
    const threadRes = await app.inject({
      method: "POST",
      url: "/api/v1/threads",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: {
        workspaceId,
        title: "Chat Memory Injection Thread",
        preferredProviderConnectionId: connId,
        preferredModelId: "gpt-4o-mini",
      },
    });
    expect(threadRes.statusCode).toBe(201);
    const threadId = threadRes.json().data.id;

    observedChatSystemPrompts.length = 0;

    const msgRes = await app.inject({
      method: "POST",
      url: `/api/v1/threads/${threadId}/messages`,
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: {
        content: "Summarize our postgres deployment checklist.",
        providerConnectionId: connId,
        modelId: "gpt-4o-mini",
      },
    });
    expect(msgRes.statusCode).toBe(201);

    // Wait briefly for embedded BullMQ worker to complete generation
    const deadline = Date.now() + 8000;
    while (observedChatSystemPrompts.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
    }

    expect(observedChatSystemPrompts.length).toBeGreaterThanOrEqual(1);
    expect(observedChatSystemPrompts[0]).toContain("<UNTRUSTED_MEMORY_CONTEXT");
    expect(observedChatSystemPrompts[0]).toContain("Workspace Deployment Standard");
  });

  it(
    "publishes workflow versions, validates cycles, pauses on human approval gate with RBAC, and streams WebSocket snapshots",
    async () => {
    // Seed starter templates first
    const seedRes = await app.inject({
      method: "POST",
      url: "/api/v1/workflows/templates/seed",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: { workspaceId },
    });
    expect(seedRes.statusCode).toBe(201);
    expect(seedRes.json().data.created.length).toBeGreaterThanOrEqual(3);

    // Reject invalid cyclic graph on validation endpoint
    const valRes = await app.inject({
      method: "POST",
      url: "/api/v1/workflows/validate",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: {
        workspaceId,
        graph: {
          nodes: [
            { id: "t", type: "manual_trigger", title: "Start", position: { x: 0, y: 0 }, config: {} },
            { id: "a", type: "transform", title: "A", position: { x: 100, y: 0 }, config: { template: "a" } },
            { id: "b", type: "transform", title: "B", position: { x: 200, y: 0 }, config: { template: "b" } },
          ],
          edges: [
            { id: "e1", source: "t", target: "a" },
            { id: "e2", source: "a", target: "b" },
            { id: "e3", source: "b", target: "a" },
          ],
        },
      },
    });
    expect(valRes.statusCode).toBe(200);
    expect(valRes.json().data.valid).toBe(false);

    // Create custom multi-step Agent + Condition + Approval Gate + Store Result workflow
    const createWfRes = await app.inject({
      method: "POST",
      url: "/api/v1/workflows",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: {
        workspaceId,
        name: "Agent Review Approval Pipeline",
        description: "E2E test pipeline",
        draftGraph: {
          nodes: [
            { id: "t1", type: "manual_trigger", title: "Trigger", position: { x: 0, y: 100 }, config: {} },
            {
              id: "ag1",
              type: "run_agent",
              title: "Analyst Agent",
              position: { x: 200, y: 100 },
              config: {
                agentId,
                promptTemplate: "Review release notes cleanly.",
                useMemoryRetrieval: true,
              },
            },
            {
              id: "cond1",
              type: "condition",
              title: "Flagged High Risk?",
              position: { x: 400, y: 100 },
              config: { expression: 'steps.ag1.output.summary contains "high"' },
            },
            {
              id: "gate1",
              type: "approval_gate",
              title: "Owner Signoff",
              position: { x: 600, y: 50 },
              config: { title: "Approve Flagged Output", summaryTemplate: "High severity found." },
            },
            {
              id: "store1",
              type: "store_result",
              title: "Store Verified Result",
              position: { x: 800, y: 50 },
              config: {
                saveToMemory: true,
                memoryScope: "WORKSPACE",
                memoryTitleTemplate: "Approved Workflow Deliverable",
                outputTemplate: "{{steps.ag1.output.summary}}",
              },
            },
            {
              id: "end1",
              type: "completion",
              title: "Complete",
              position: { x: 1000, y: 50 },
              config: { summaryTemplate: "Verified: {{steps.store1.output.summary}}" },
            },
          ],
          edges: [
            { id: "e1", source: "t1", target: "ag1" },
            { id: "e2", source: "ag1", target: "cond1" },
            { id: "e3", source: "cond1", target: "gate1", sourceHandle: "true" },
            { id: "e4", source: "gate1", target: "store1" },
            { id: "e5", source: "store1", target: "end1" },
          ],
        },
      },
    });
    expect(createWfRes.statusCode).toBe(201);
    const wfId = createWfRes.json().data.id;

    // Publish version 1
    const pubRes = await app.inject({
      method: "POST",
      url: `/api/v1/workflows/${wfId}/publish`,
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: { workspaceId, activate: true },
    });
    expect(pubRes.statusCode).toBe(200);
    expect(pubRes.json().data.activeVersionNumber).toBe(1);

    // Run workflow
    const runRes = await app.inject({
      method: "POST",
      url: `/api/v1/workflows/${wfId}/run`,
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: { workspaceId, triggerPayload: { target: "release-candidate" } },
    });
    expect(runRes.statusCode).toBe(201);
    const runId = runRes.json().data.id;

    // Poll until AWAITING_APPROVAL
    let detail: any = null;
    const waitStart = Date.now();
    while (Date.now() - waitStart < 10_000) {
      const detRes = await app.inject({
        method: "GET",
        url: `/api/v1/workflows/runs/${runId}?workspaceId=${workspaceId}`,
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      detail = detRes.json().data;
      if (detail.status === "AWAITING_APPROVAL") break;
      await new Promise((r) => setTimeout(r, 150));
    }

    expect(detail?.status).toBe("AWAITING_APPROVAL");
    expect(detail?.approvals?.length).toBe(1);
    const approvalId = detail.approvals[0].id;

    // Verify WebSocket workflow.subscribe delivers snapshot cleanly
    const ticketRes = await app.inject({
      method: "POST",
      url: "/api/v1/realtime/ticket",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: { workspaceId },
    });
    const ticket = ticketRes.json().data.ticket;
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 3001;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/realtime`);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("Timed out waiting for workflow.snapshot over WS"));
      }, 4000);

      ws.on("open", () => {
        ws.send(JSON.stringify({ action: "auth", ticket }));
      });
      ws.on("message", (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.event === "auth.success") {
          ws.send(JSON.stringify({ action: "workflow.subscribe", runId }));
        } else if (frame.event === "workflow.snapshot") {
          expect(frame.data.id).toBe(runId);
          clearTimeout(timer);
          ws.close();
          resolve();
        }
      });
    });

    // Member role MUST be rejected (403) when trying to approve workflow gate
    const memberApprove = await app.inject({
      method: "POST",
      url: `/api/v1/workflows/approvals/${approvalId}/approve`,
      headers: { Authorization: `Bearer ${memberToken}` },
      payload: { workspaceId },
    });
    expect(memberApprove.statusCode).toBe(403);

    // Owner approves gate -> workflow resumes & completes cleanly!
    const ownerApprove = await app.inject({
      method: "POST",
      url: `/api/v1/workflows/approvals/${approvalId}/approve`,
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: { workspaceId },
    });
    expect(ownerApprove.statusCode).toBe(200);

    const endWait = Date.now();
    while (Date.now() - endWait < 10_000) {
      const detRes = await app.inject({
        method: "GET",
        url: `/api/v1/workflows/runs/${runId}?workspaceId=${workspaceId}`,
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      detail = detRes.json().data;
      if (detail.status === "COMPLETED") break;
      await new Promise((r) => setTimeout(r, 150));
    }

    expect(detail.status).toBe("COMPLETED");
    expect(detail.finalSummary).toContain("Severity: high");

    // Verify self-trigger loop prevention in WorkflowEventRouter
    const evWfRes = await app.inject({
      method: "POST",
      url: "/api/v1/workflows",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: {
        workspaceId,
        name: "Event Loop Guard Flow",
        draftGraph: {
          nodes: [
            {
              id: "ev",
              type: "event_trigger",
              title: "On Workflow Complete",
              position: { x: 0, y: 0 },
              config: { eventType: "workflow.completed", cooldownSeconds: 5 },
            },
            {
              id: "done",
              type: "completion",
              title: "Done",
              position: { x: 250, y: 0 },
              config: { summaryTemplate: "Event processed" },
            },
          ],
          edges: [{ id: "e1", source: "ev", target: "done" }],
        },
      },
    });
    const evWfId = evWfRes.json().data.id;
    await app.inject({
      method: "POST",
      url: `/api/v1/workflows/${evWfId}/publish`,
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: { workspaceId, activate: true },
    });

    const selfTrig = await workflowEventRouter.emitDomainEvent({
      workspaceId,
      eventType: "workflow.completed",
      sourceWorkflowId: evWfId,
      payload: { summary: "loop test" },
    });
    expect(selfTrig.triggeredRunIds).toHaveLength(0);
    expect(selfTrig.skippedReasons.some((s) => s.includes("BLOCKED_SELF_TRIGGER"))).toBe(true);
  }, 25000);
});
