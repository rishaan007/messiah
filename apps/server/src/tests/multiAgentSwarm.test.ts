import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as jose from "jose";
import WebSocket from "ws";
import { buildApp } from "../app.js";
import { loadAndValidateEnv } from "../config/env.js";
import { prisma } from "@messiah/db";
import {
  defaultProviderRegistry,
  type IProviderAdapter,
  type ProviderStreamEvent,
  type ProviderStreamRequest,
} from "@messiah/providers";
import { VaultService } from "../services/vaultService.js";
import { McpTestServer } from "./mcpTestServer.js";

const TEST_SECRET = new TextEncoder().encode("messiah_test_jwt_secret_minimum_32_characters_long");
const TEST_VAULT_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async function createTestJwt(payload: { sub: string; email: string }): Promise<string> {
  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(TEST_SECRET);
}

describe("MESSIAH Phase 5 — Multi-Agent Orchestration & Swarm Topology Integration", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let originalOpenAIAdapter: IProviderAdapter;
  let testMcpServer: McpTestServer;
  let mcpServerUrl: string;

  let ownerToken: string;
  let viewerToken: string;
  let outsiderToken: string;
  let ownerId: string;
  let viewerId: string;
  let outsiderId: string;
  let workspaceId: string;
  let outsiderWorkspaceId: string;
  let providerConnectionId: string;

  let supervisorId: string;
  let workerResearchId: string;
  let workerDevId: string;
  let workerReviewerId: string;

  let approvalToolDefId: string;
  let approvalToolAlias = "";

  const runSeed = Math.random().toString(36).slice(2, 9);
  const workerPromptsObserved: string[] = [];
  let scenarioMode: "standard_dag" | "require_tool_approval" | "budget_exceeded" | "slow_cancel" = "standard_dag";

  beforeAll(async () => {
    process.env.VAULT_ENCRYPTION_KEY = TEST_VAULT_KEY;
    originalOpenAIAdapter = defaultProviderRegistry.getAdapter("openai");

    testMcpServer = new McpTestServer();
    mcpServerUrl = await testMcpServer.start();

    // Register deterministic test provider adapter simulating Supervisor Planning, Concurrent Workers, Tool Call, & Synthesis
    const testAdapter: IProviderAdapter = {
      ...originalOpenAIAdapter,
      async *streamResponse(request: ProviderStreamRequest, abortSignal?: AbortSignal): AsyncIterable<ProviderStreamEvent> {
        const systemContent = request.messages.find((m) => m.role === "system")?.content || "";
        const userContent = request.messages.filter((m) => m.role === "user").map((m) => m.content || "").join("\n");

        if (abortSignal?.aborted) {
          throw new Error("Aborted");
        }

        // 1. Supervisor Planning pass
        if (systemContent.includes("strict JSON execution plan object")) {
          const plan =
            scenarioMode === "require_tool_approval"
              ? {
                  goalSummary: "Invoke gated MCP deployment tool",
                  tasks: [
                    {
                      taskKey: "deploy_step",
                      title: "Trigger Deploy Tool",
                      instructions: "Call deploy_preview MCP tool cleanly.",
                      assignedAgentId: workerDevId,
                      dependsOnKeys: [],
                      inputTaskKeys: [],
                      priority: 1,
                      maxIterations: 3,
                    },
                  ],
                }
              : {
                  goalSummary: "Parallel research & build followed by code review",
                  tasks: [
                    {
                      taskKey: "research_backend",
                      title: "Audit Backend Modules",
                      instructions: "Inspect API routes and auth",
                      assignedAgentId: workerResearchId,
                      dependsOnKeys: [],
                      inputTaskKeys: [],
                      priority: 2,
                      maxIterations: 2,
                    },
                    {
                      taskKey: "build_patch",
                      title: "Draft Remediation Patch",
                      instructions: "Prepare clean service remediation",
                      assignedAgentId: workerDevId,
                      dependsOnKeys: [],
                      inputTaskKeys: [],
                      priority: 2,
                      maxIterations: 2,
                    },
                    {
                      taskKey: "review_changes",
                      title: "Security Review",
                      instructions: "Verify backend audit and patch integrity",
                      assignedAgentId: workerReviewerId,
                      dependsOnKeys: ["research_backend", "build_patch"],
                      inputTaskKeys: ["research_backend", "build_patch"],
                      priority: 1,
                      maxIterations: 2,
                    },
                  ],
                };

          yield { type: "text_delta", text: JSON.stringify(plan) };
          yield {
            type: "usage",
            inputTokens: scenarioMode === "budget_exceeded" ? 5000 : 120,
            outputTokens: scenarioMode === "budget_exceeded" ? 5000 : 90,
          };
          yield { type: "completed", finishReason: "stop" };
          return;
        }

        // 2. Supervisor Final Synthesis pass
        if (systemContent.includes("final swarm synthesis")) {
          yield {
            type: "text_delta",
            text: `Synthesized Swarm Deliverable:\nVerified upstream reports cleanly.\nContext seen length=${userContent.length}`,
          };
          yield { type: "usage", inputTokens: 150, outputTokens: 60 };
          yield { type: "completed", finishReason: "stop" };
          return;
        }

        // 3. Worker Execution pass
        workerPromptsObserved.push(userContent);

        if (scenarioMode === "slow_cancel") {
          await new Promise((r) => setTimeout(r, 800));
        }

        // Tool calling test inside Swarm
        const hasToolMsg = request.messages.some((m) => m.role === "tool") || userContent.includes("Resuming after human approval");
        if (scenarioMode === "require_tool_approval" && request.tools && request.tools.length > 0 && !hasToolMsg) {
          const targetTool = request.tools[0]!;
          approvalToolAlias = targetTool.name;
          yield {
            type: "tool_call",
            callId: "call_swarm_mcp_1",
            toolName: targetTool.name,
            arguments: { id: "canary-1", title: "Deploy canary build" },
          };
          yield { type: "usage", inputTokens: 100, outputTokens: 30 };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }

        yield {
          type: "text_delta",
          text: `Worker result completed with token_safe_summary for: ${userContent.slice(0, 80)}`,
        };
        yield {
          type: "usage",
          inputTokens: scenarioMode === "budget_exceeded" ? 10000 : 80,
          outputTokens: scenarioMode === "budget_exceeded" ? 10000 : 40,
        };
        yield { type: "completed", finishReason: "stop" };
      },
    };
    defaultProviderRegistry.registerAdapter(testAdapter);

    const testEnv = loadAndValidateEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "fatal",
      SUPABASE_JWT_SECRET: "messiah_test_jwt_secret_minimum_32_characters_long",
      VAULT_ENCRYPTION_KEY: TEST_VAULT_KEY,
    });

    app = await buildApp({ env: testEnv, logger: false });
    await app.listen({ port: 0, host: "127.0.0.1" });

    // Users & Workspaces
    const owner = await prisma.user.create({
      data: {
        externalProvider: "supabase",
        externalId: `swarm-owner-${runSeed}`,
        email: `swarm.owner.${runSeed}@example.com`,
        fullName: "Swarm Owner",
      },
    });
    ownerId = owner.id;
    ownerToken = await createTestJwt({ sub: owner.externalId, email: owner.email });

    const viewer = await prisma.user.create({
      data: {
        externalProvider: "supabase",
        externalId: `swarm-viewer-${runSeed}`,
        email: `swarm.viewer.${runSeed}@example.com`,
        fullName: "Swarm Viewer",
      },
    });
    viewerId = viewer.id;
    viewerToken = await createTestJwt({ sub: viewer.externalId, email: viewer.email });

    const outsider = await prisma.user.create({
      data: {
        externalProvider: "supabase",
        externalId: `swarm-out-${runSeed}`,
        email: `swarm.out.${runSeed}@example.com`,
        fullName: "Outsider User",
      },
    });
    outsiderId = outsider.id;
    outsiderToken = await createTestJwt({ sub: outsider.externalId, email: outsider.email });

    const ws = await prisma.workspace.create({
      data: {
        name: `Swarm Workspace ${runSeed}`,
        slug: `swarm-ws-${runSeed}`,
        ownerId,
        members: {
          create: [
            { userId: ownerId, role: "OWNER" },
            { userId: viewerId, role: "VIEWER" },
          ],
        },
      },
    });
    workspaceId = ws.id;

    const extWs = await prisma.workspace.create({
      data: {
        name: `Outsider WS ${runSeed}`,
        slug: `out-ws-${runSeed}`,
        ownerId: outsiderId,
        members: { create: [{ userId: outsiderId, role: "OWNER" }] },
      },
    });
    outsiderWorkspaceId = extWs.id;

    // Encrypt active provider connection key cleanly with VaultService
    const vault = new VaultService();
    const conn = await prisma.providerConnection.create({
      data: {
        workspaceId,
        provider: "openai",
        displayName: "OpenAI Test Provider",
        status: "ACTIVE",
        createdByUserId: ownerId,
      },
    });
    providerConnectionId = conn.id;

    const enc = vault.encrypt("sk-test-fake-openai-key-for-swarm-tests", {
      workspaceId,
      providerConnectionId: conn.id,
      provider: "openai",
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

    // Register McpTestServer in Prisma with REQUIRE_APPROVAL permission
    const mcpConn = await prisma.mcpServerConnection.create({
      data: {
        workspaceId,
        name: "Swarm Test MCP",
        endpointUrl: mcpServerUrl,
        transportType: "STREAMABLE_HTTP",
        status: "CONNECTED",
        authenticationStatus: "NONE",
      },
    });
    const { computeSchemaHash } = await import("@messiah/mcp");
    const createSchema = {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
      },
      required: ["id", "title"],
    };
    const createTool = await prisma.mcpToolDefinition.create({
      data: {
        connectionId: mcpConn.id,
        toolName: "create_record",
        description: "Creates a record",
        inputSchema: createSchema as any,
        schemaHash: computeSchemaHash(createSchema),
        isAvailable: true,
      },
    });
    await prisma.mcpToolPermission.create({
      data: {
        workspaceId,
        toolDefinitionId: createTool.id,
        permissionMode: "REQUIRE_APPROVAL",
        requiresApproval: true,
      },
    });
    approvalToolDefId = createTool.id;
  });

  afterAll(async () => {
    defaultProviderRegistry.registerAdapter(originalOpenAIAdapter);
    await testMcpServer.stop().catch(() => {});
    await app.close();
  });

  it("manages Agent Registry CRUD, versioning, template seeding, prompt testing, and enforces RBAC & IDOR", async () => {
    // 1. Seed default agent templates
    const seedRes = await app.inject({
      method: "POST",
      url: "/api/v1/agents/templates/seed",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: { workspaceId },
    });
    expect(seedRes.statusCode).toBe(201);
    const seeded = seedRes.json().data;
    expect(seeded.length).toBe(6);

    const sup = seeded.find((a: any) => a.canSupervise);
    const res = seeded.find((a: any) => a.category === "research");
    const rev = seeded.find((a: any) => a.category === "reviewer");
    supervisorId = sup.id;
    workerResearchId = res.id;
    workerReviewerId = rev.id;

    // 2. Create custom Developer Agent bound to approvalToolDefId
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: {
        workspaceId,
        name: "Swarm Dev Builder",
        roleTitle: "MCP Tool Developer",
        category: "developer",
        canSupervise: false,
        providerConnectionId,
        modelId: "gpt-4o-mini",
        systemPrompt: "You execute development tasks accurately.",
        allowedMcpToolIds: [approvalToolDefId],
      },
    });
    expect(createRes.statusCode).toBe(201);
    workerDevId = createRes.json().data.id;

    // 3. Update agent creates version 2
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${workerDevId}?workspaceId=${workspaceId}`,
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: { description: "Updated builder description" },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().data.activeVersion).toBe(2);
    expect(patchRes.json().data.versions.length).toBe(2);

    // 4. Test prompt works without leaking secrets
    const testPromptRes = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${workerDevId}/test`,
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: { workspaceId, prompt: "Ping agent persona test" },
    });
    expect(testPromptRes.statusCode).toBe(200);
    expect(testPromptRes.json().data.output).toContain("Worker result completed");

    // 5. Viewer cannot create/update agents; outsider blocked from reading (IDOR)
    const viewerCreate = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: { Authorization: `Bearer ${viewerToken}` },
      payload: {
        workspaceId,
        name: "Viewer Forbidden",
        roleTitle: "Unauthorized",
        systemPrompt: "Should fail",
      },
    });
    expect(viewerCreate.statusCode).toBe(403);

    const outsiderRead = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${workerDevId}?workspaceId=${workspaceId}`,
      headers: { Authorization: `Bearer ${outsiderToken}` },
    });
    expect(outsiderRead.statusCode).toBe(404);

    // Cross-workspace reference injection check
    const crossToolCreate = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: { Authorization: `Bearer ${outsiderToken}` },
      payload: {
        workspaceId: outsiderWorkspaceId,
        name: "Cross Tenant Tool Steal",
        roleTitle: "Attacker",
        systemPrompt: "Steal tool",
        allowedMcpToolIds: [approvalToolDefId],
      },
    });
    expect(crossToolCreate.statusCode).toBe(400);
  });

  it("orchestrates parallel + dependent DAG swarm run end-to-end with WebSocket streaming and Thread sync", async () => {
    scenarioMode = "standard_dag";
    workerPromptsObserved.length = 0;

    // Create chat thread first so swarm updates thread too
    const threadRes = await app.inject({
      method: "POST",
      url: "/api/v1/threads",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: { workspaceId, title: "Swarm Chat Test" },
    });
    const threadId = threadRes.json().data.id;

    // Start Swarm Run with requirePlanApproval: false
    const startRes = await app.inject({
      method: "POST",
      url: "/api/v1/swarms",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: {
        workspaceId,
        supervisorAgentId: supervisorId,
        workerAgentIds: [workerResearchId, workerDevId, workerReviewerId],
        objective: "Audit auth service, prepare fix, and run security review.",
        threadId,
        maxConcurrency: 3,
      },
    });
    expect(startRes.statusCode).toBe(201);
    const runId = startRes.json().data.id;

    // Subscribe over WebSocket /api/v1/realtime
    const ticketRes = await app.inject({
      method: "POST",
      url: "/api/v1/realtime/ticket",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: { workspaceId },
    });
    const ticket = ticketRes.json().data.ticket;

    const wsFrames: string[] = [];
    const addr = app.server.address() as { port: number };
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/api/v1/realtime`);
    await new Promise<void>((resolve) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({ action: "auth", ticket }));
      });
      ws.on("message", (raw) => {
        const parsed = JSON.parse(raw.toString());
        wsFrames.push(parsed.event);
        if (parsed.event === "auth.success") {
          ws.send(JSON.stringify({ action: "swarm.subscribe", runId }));
          resolve();
        }
      });
    });

    // Wait for completion in DB
    let detail: any = null;
    for (let i = 0; i < 60; i++) {
      const poll = await app.inject({
        method: "GET",
        url: `/api/v1/swarms/${runId}?workspaceId=${workspaceId}`,
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      detail = poll.json().data;
      if (detail.status === "COMPLETED" || detail.status === "FAILED") break;
      await new Promise((r) => setTimeout(r, 100));
    }

    ws.close();

    expect(detail.status).toBe("COMPLETED");
    expect(detail.tasks.length).toBe(3);
    expect(detail.finalSummary).toContain("Synthesized Swarm Deliverable");
    expect(detail.artifacts.length).toBeGreaterThanOrEqual(1);
    expect(detail.communications.length).toBeGreaterThanOrEqual(6); // 3 delegations + 3 results
    expect(detail.events.some((e: any) => e.eventType === "swarm.run.planned")).toBe(true);
    expect(wsFrames).toContain("swarm.snapshot");

    // Verify reviewer received scoped <UNTRUSTED_AGENT_OUTPUT> from both upstream tasks
    const reviewerPrompt = workerPromptsObserved.find((p) => p.includes("Assigned Task [review_changes]"))!;
    expect(reviewerPrompt).toContain('<UNTRUSTED_AGENT_OUTPUT task_key="research_backend"');
    expect(reviewerPrompt).toContain('<UNTRUSTED_AGENT_OUTPUT task_key="build_patch"');
    expect(reviewerPrompt).toContain('trusted="false"');

    // Verify linked chat thread message received final synthesis
    const msgsRes = await app.inject({
      method: "GET",
      url: `/api/v1/threads/${threadId}/messages`,
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const assistantMsg = msgsRes.json().data.find((m: any) => m.role === "ASSISTANT");
    expect(assistantMsg.status).toBe("COMPLETED");
    expect(assistantMsg.content).toContain("Synthesized Swarm Deliverable");
  });

  it("pauses for HITL tool approval during Swarm execution and resumes cleanly via Outbox", async () => {
    scenarioMode = "require_tool_approval";

    const startRes = await app.inject({
      method: "POST",
      url: "/api/v1/swarms",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: {
        workspaceId,
        supervisorAgentId: supervisorId,
        workerAgentIds: [workerDevId],
        objective: "Execute echo_data MCP tool via worker.",
        maxConcurrency: 2,
      },
    });
    const runId = startRes.json().data.id;

    // Wait until AWAITING_APPROVAL
    let detail: any = null;
    for (let i = 0; i < 60; i++) {
      const poll = await app.inject({
        method: "GET",
        url: `/api/v1/swarms/${runId}?workspaceId=${workspaceId}`,
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      detail = poll.json().data;
      if (detail.status === "AWAITING_APPROVAL") break;
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(detail.status).toBe("AWAITING_APPROVAL");
    expect(detail.pendingToolApprovals.length).toBe(1);
    const approvalId = detail.pendingToolApprovals[0].id;
    expect(approvalToolAlias).toBeTruthy();

    // Human OWNER approves single-use approval token
    const approveRes = await app.inject({
      method: "POST",
      url: `/api/v1/tool-approvals/${approvalId}/approve`,
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: { workspaceId },
    });
    expect(approveRes.statusCode).toBe(200);

    // Wait for Swarm to execute real MCP tool and reach COMPLETED
    for (let i = 0; i < 60; i++) {
      const poll = await app.inject({
        method: "GET",
        url: `/api/v1/swarms/${runId}?workspaceId=${workspaceId}`,
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      detail = poll.json().data;
      if (detail.status === "COMPLETED" || detail.status === "FAILED") break;
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(detail.status).toBe("COMPLETED");
  });

  it("enforces token budget ceilings and supports pre-run plan approval & cancellation", async () => {
    scenarioMode = "budget_exceeded";
    const startBudget = await app.inject({
      method: "POST",
      url: "/api/v1/swarms",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: {
        workspaceId,
        supervisorAgentId: supervisorId,
        workerAgentIds: [workerResearchId, workerDevId, workerReviewerId],
        objective: "Exceed tight token budget",
        maxTotalTokens: 2500,
      },
    });
    const budgetRunId = startBudget.json().data.id;

    let budgetDetail: any = null;
    for (let i = 0; i < 50; i++) {
      const poll = await app.inject({
        method: "GET",
        url: `/api/v1/swarms/${budgetRunId}?workspaceId=${workspaceId}`,
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      budgetDetail = poll.json().data;
      if (budgetDetail.status === "FAILED") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(budgetDetail.status).toBe("FAILED");
    expect(budgetDetail.safeErrorCode).toBe("BUDGET_EXCEEDED");

    // Pre-run plan approval pause + cancel
    scenarioMode = "standard_dag";
    const pauseStart = await app.inject({
      method: "POST",
      url: "/api/v1/swarms",
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: {
        workspaceId,
        supervisorAgentId: supervisorId,
        workerAgentIds: [workerResearchId, workerDevId, workerReviewerId],
        objective: "Require plan review first",
        requirePlanApproval: true,
      },
    });
    const pausedId = pauseStart.json().data.id;

    let pausedDetail: any = null;
    for (let i = 0; i < 50; i++) {
      const poll = await app.inject({
        method: "GET",
        url: `/api/v1/swarms/${pausedId}?workspaceId=${workspaceId}`,
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      pausedDetail = poll.json().data;
      if (pausedDetail.status === "AWAITING_PLAN_APPROVAL") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(pausedDetail.status).toBe("AWAITING_PLAN_APPROVAL");

    const cancelRes = await app.inject({
      method: "POST",
      url: `/api/v1/swarms/${pausedId}/cancel`,
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: { workspaceId },
    });
    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.json().data.status).toBe("CANCELLED");
  });
});
