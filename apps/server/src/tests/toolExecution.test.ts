import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as jose from "jose";
import { buildApp } from "../app.js";
import { loadAndValidateEnv } from "../config/env.js";
import { prisma } from "@messiah/db";
import { toolApprovalService } from "../services/tools/toolApprovalService.js";
import { chatQueueManager } from "../services/chat/index.js";

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

describe("MESSIAH Phase 3B — MCP Tool Execution & Approval System Test Suite", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let userAToken: string;
  let userBToken: string;
  let userAId: string;
  let userBId: string;
  let workspaceId: string;
  let connectionId: string;
  let toolDefId: string;
  let threadId: string;
  let assistantMessageId: string;
  let runId: string;

  const testSuffix = Math.random().toString(36).substring(2, 9);
  const userAExternalId = `sub-exec-a-${testSuffix}`;
  const userBExternalId = `sub-exec-b-${testSuffix}`;
  const userAEmail = `alex.exec.${testSuffix}@example.com`;
  const userBEmail = `elena.exec.${testSuffix}@example.com`;

  beforeAll(async () => {
    process.env.VAULT_ENCRYPTION_KEY = TEST_VAULT_KEY;

    const testEnv = loadAndValidateEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "fatal",
      SUPABASE_JWT_SECRET: "messiah_test_jwt_secret_minimum_32_characters_long",
      VAULT_ENCRYPTION_KEY: TEST_VAULT_KEY,
    });

    app = await buildApp({ env: testEnv, logger: false });
    await app.ready();

    vi.spyOn(chatQueueManager, "enqueueRun").mockResolvedValue({ id: "mock-resumed-job" } as any);

    userAToken = await createTestJwt({ sub: userAExternalId, email: userAEmail });
    userBToken = await createTestJwt({ sub: userBExternalId, email: userBEmail });

    // Seed User A (Owner)
    const userA = await prisma.user.create({
      data: {
        externalProvider: "supabase",
        externalId: userAExternalId,
        email: userAEmail,
        fullName: "Alex Executive",
      },
    });
    userAId = userA.id;

    // Seed User B (Viewer)
    const userB = await prisma.user.create({
      data: {
        externalProvider: "supabase",
        externalId: userBExternalId,
        email: userBEmail,
        fullName: "Elena Observer",
      },
    });
    userBId = userB.id;

    // Seed Workspace
    const workspace = await prisma.workspace.create({
      data: {
        name: `Exec Workspace ${testSuffix}`,
        slug: `exec-ws-${testSuffix}`,
        ownerId: userAId,
        members: {
          create: [
            { userId: userAId, role: "OWNER" },
            { userId: userBId, role: "VIEWER" },
          ],
        },
      },
    });
    workspaceId = workspace.id;

    // Seed Provider Connection
    const provConn = await prisma.providerConnection.create({
      data: {
        workspaceId,
        provider: "openai",
        displayName: "OpenAI GPT-4o Connection",
        status: "ACTIVE",
      },
    });

    // Seed MCP Server Connection
    const mcpConn = await prisma.mcpServerConnection.create({
      data: {
        workspaceId,
        name: `github-${testSuffix}`,
        endpointUrl: "https://api.github.com/mcp",
        transportType: "STREAMABLE_HTTP",
        status: "CONNECTED",
        tools: {
          create: {
            toolName: "create_pull_request",
            displayName: "Create Pull Request",
            description: "Creates a GitHub PR",
            inputSchema: {
              type: "object",
              properties: {
                title: { type: "string" },
                head: { type: "string" },
                base: { type: "string" },
              },
              required: ["title", "head", "base"],
            },
            schemaHash: "hash-cpr-12345",
            isAvailable: true,
            permission: {
              create: {
                workspaceId,
                permissionMode: "REQUIRE_APPROVAL",
                requiresApproval: true,
              },
            },
          },
        },
      },
      include: { tools: true },
    });
    connectionId = mcpConn.id;
    toolDefId = mcpConn.tools[0]!.id;

    // Seed Thread
    const thread = await prisma.thread.create({
      data: {
        workspaceId,
        createdByUserId: userAId,
        title: "Test Tool Execution Thread",
      },
    });
    threadId = thread.id;

    // Seed Assistant Message
    const assistantMsg = await prisma.message.create({
      data: {
        threadId,
        sequence: 2,
        role: "ASSISTANT",
        content: "I will create that pull request for you.",
        status: "STREAMING",
      },
    });
    assistantMessageId = assistantMsg.id;

    // Seed Generation Run
    const run = await prisma.generationRun.create({
      data: {
        threadId,
        assistantMessageId,
        providerConnectionId: provConn.id,
        provider: "openai",
        modelId: "gpt-4o",
        status: "STREAMING",
      },
    });
    runId = run.id;
  });

  afterAll(async () => {
    if (workspaceId) {
      await prisma.toolApproval.deleteMany({ where: { workspaceId } }).catch(() => {});
      await prisma.toolCall.deleteMany({ where: { workspaceId } }).catch(() => {});
      await prisma.generationRun.deleteMany({ where: { thread: { workspaceId } } }).catch(() => {});
      await prisma.message.deleteMany({ where: { thread: { workspaceId } } }).catch(() => {});
      await prisma.thread.deleteMany({ where: { workspaceId } }).catch(() => {});
      await prisma.mcpToolDefinition.deleteMany({ where: { connection: { workspaceId } } }).catch(() => {});
      await prisma.mcpServerConnection.deleteMany({ where: { workspaceId } }).catch(() => {});
      await prisma.providerConnection.deleteMany({ where: { workspaceId } }).catch(() => {});
      await prisma.workspaceMember.deleteMany({ where: { workspaceId } }).catch(() => {});
      await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {});
    }
    if (userAId) {
      await prisma.user.delete({ where: { id: userAId } }).catch(() => {});
    }
    if (userBId) {
      await prisma.user.delete({ where: { id: userBId } }).catch(() => {});
    }
    await app.close();
  });

  describe("1. Tool Approval Service Logic", () => {
    let createdApprovalId: string;
    let createdToolCallId: string;

    it("creates a ToolCall and ToolApproval in PENDING/AWAITING_APPROVAL state with 5-minute TTL", async () => {
      const args = {
        title: "Feature: Autonomous Agent Engine",
        head: "feature/agents",
        base: "main",
      };

      const result = await toolApprovalService.requestApproval({
        generationRunId: runId,
        threadId,
        workspaceId,
        toolDefinitionId: toolDefId,
        connectionId,
        providerCallId: "call_pr_001",
        providerToolAlias: "mcp__github__create_pull_request",
        toolName: "create_pull_request",
        schemaHash: "hash-cpr-12345",
        arguments: args,
        requestedByUserId: userAId,
      });

      expect(result.toolCall).toBeDefined();
      expect(result.toolCall.status).toBe("AWAITING_APPROVAL");
      expect(result.toolApproval.status).toBe("PENDING");
      expect(result.toolApproval.expiresAt.getTime()).toBeGreaterThan(Date.now());

      createdApprovalId = result.toolApproval.id;
      createdToolCallId = result.toolCall.id;

      // Verify GenerationRun transitioned to AWAITING_APPROVAL
      const run = await prisma.generationRun.findUnique({ where: { id: runId } });
      expect(run?.status).toBe("AWAITING_APPROVAL");
    });

    it("forbids VIEWER and MEMBER roles from approving tool executions", async () => {
      await expect(
        toolApprovalService.approve(createdApprovalId, userBId, "VIEWER")
      ).rejects.toThrow("Only workspace OWNER or ADMIN roles are permitted to approve tool executions");

      await expect(
        toolApprovalService.approve(createdApprovalId, userBId, "MEMBER")
      ).rejects.toThrow("Only workspace OWNER or ADMIN roles are permitted to approve tool executions");
    });

    it("allows OWNER to approve tool execution and transitions state to APPROVED", async () => {
      const approved = await toolApprovalService.approve(createdApprovalId, userAId, "OWNER");
      expect(approved.status).toBe("APPROVED");
      expect(approved.decidedByUserId).toBe(userAId);
      expect(approved.decidedAt).toBeDefined();

      const toolCall = await prisma.toolCall.findUnique({ where: { id: createdToolCallId } });
      expect(toolCall?.status).toBe("APPROVED");

      const run = await prisma.generationRun.findUnique({ where: { id: runId } });
      expect(run?.status).toBe("PENDING"); // Ready to resume in worker
    });

    it("rejects duplicate approval on an already approved request (single-use enforcement)", async () => {
      await expect(
        toolApprovalService.approve(createdApprovalId, userAId, "OWNER")
      ).rejects.toThrow("already APPROVED");
    });

    it("handles tool denial and marks ToolCall and ToolApproval as DENIED", async () => {
      const req = await toolApprovalService.requestApproval({
        generationRunId: runId,
        threadId,
        workspaceId,
        toolDefinitionId: toolDefId,
        connectionId,
        providerCallId: "call_pr_deny_002",
        providerToolAlias: "mcp__github__create_pull_request",
        toolName: "create_pull_request",
        schemaHash: "hash-cpr-12345",
        arguments: { title: "Spam PR", head: "spam", base: "main" },
        requestedByUserId: userAId,
      });

      const denied = await toolApprovalService.deny(
        req.toolApproval.id,
        userAId,
        "OWNER",
        "Disallowed branch name"
      );

      expect(denied.status).toBe("DENIED");
      expect(denied.rejectionReason).toBe("Disallowed branch name");

      const toolCall = await prisma.toolCall.findUnique({ where: { id: req.toolCall.id } });
      expect(toolCall?.status).toBe("DENIED");
      expect(toolCall?.isError).toBe(true);
      expect(toolCall?.errorMessage).toBe("Disallowed branch name");
    });

    it("automatically identifies and marks expired approvals past the 5-minute TTL", async () => {
      // Create an already-expired approval in the past
      const pastDate = new Date(Date.now() - 60 * 1000); // 1 minute in the past
      const toolCall = await prisma.toolCall.create({
        data: {
          generationRunId: runId,
          threadId,
          workspaceId,
          toolDefinitionId: toolDefId,
          connectionId,
          providerCallId: "call_expired_003",
          providerToolAlias: "mcp__github__create_pull_request",
          toolName: "create_pull_request",
          schemaHash: "hash-cpr-12345",
          argumentsHash: "hash-args-expired",
          status: "AWAITING_APPROVAL",
        },
      });

      const approval = await prisma.toolApproval.create({
        data: {
          toolCallId: toolCall.id,
          workspaceId,
          requestedByUserId: userAId,
          status: "PENDING",
          argumentsHash: "hash-args-expired",
          schemaHash: "hash-cpr-12345",
          expiresAt: pastDate,
        },
      });

      // Calling approve on expired approval throws APPROVAL_EXPIRED
      await expect(
        toolApprovalService.approve(approval.id, userAId, "OWNER")
      ).rejects.toThrow("Tool approval request has expired");

      // Verify status updated to EXPIRED
      const updated = await prisma.toolApproval.findUnique({ where: { id: approval.id } });
      expect(updated?.status).toBe("EXPIRED");
    });
  });

  describe("2. Tool Approval REST API Endpoints", () => {
    let apiApprovalId: string;

    beforeAll(async () => {
      const res = await toolApprovalService.requestApproval({
        generationRunId: runId,
        threadId,
        workspaceId,
        toolDefinitionId: toolDefId,
        connectionId,
        providerCallId: "call_api_test_001",
        providerToolAlias: "mcp__github__create_pull_request",
        toolName: "create_pull_request",
        schemaHash: "hash-cpr-12345",
        arguments: { title: "API PR", head: "api", base: "main" },
        requestedByUserId: userAId,
      });
      apiApprovalId = res.toolApproval.id;
    });

    it("GET /api/v1/tool-approvals lists pending approvals for the workspace", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/tool-approvals?workspaceId=${workspaceId}`,
        headers: { authorization: `Bearer ${userAToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.some((a: any) => a.id === apiApprovalId)).toBe(true);
    });

    it("GET /api/v1/tool-approvals/:id returns specific tool approval details", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/tool-approvals/${apiApprovalId}?workspaceId=${workspaceId}`,
        headers: { authorization: `Bearer ${userAToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.id).toBe(apiApprovalId);
      expect(body.data.toolCall).toBeDefined();
    });

    it("POST /api/v1/tool-approvals/:id/approve allows workspace owner to approve", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/tool-approvals/${apiApprovalId}/approve`,
        headers: { authorization: `Bearer ${userAToken}` },
        payload: { workspaceId },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.status).toBe("APPROVED");
    });

    it("POST /api/v1/tool-approvals/:id/approve rejects VIEWER role with 403 Forbidden", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/tool-approvals/${apiApprovalId}/approve`,
        headers: { authorization: `Bearer ${userBToken}` },
        payload: { workspaceId },
      });

      expect(res.statusCode).toBe(403);
    });

    it("POST /api/v1/tool-approvals/:id/deny allows rejecting a pending tool call", async () => {
      const pendingReq = await toolApprovalService.requestApproval({
        generationRunId: runId,
        threadId,
        workspaceId,
        toolDefinitionId: toolDefId,
        connectionId,
        providerCallId: "call_deny_api_002",
        providerToolAlias: "mcp__github__create_pull_request",
        toolName: "create_pull_request",
        schemaHash: "hash-cpr-12345",
        arguments: { title: "Bad PR", head: "bad", base: "main" },
        requestedByUserId: userAId,
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/tool-approvals/${pendingReq.toolApproval.id}/deny`,
        headers: { authorization: `Bearer ${userAToken}` },
        payload: { workspaceId, reason: "Security violation" },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.status).toBe("DENIED");
      expect(body.data.rejectionReason).toBe("Security violation");
    });

    it("GET /api/v1/threads/:threadId/tool-calls lists all tool calls for the thread", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/threads/${threadId}/tool-calls`,
        headers: { authorization: `Bearer ${userAToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      expect(body.data[0].threadId).toBe(threadId);
    });
  });
});
