import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import * as jose from "jose";
import { buildApp } from "../app.js";
import { loadAndValidateEnv } from "../config/env.js";
import { prisma } from "@messiah/db";
import { toolApprovalService } from "../services/tools/toolApprovalService.js";
import { toolExecutionRegistry } from "../services/tools/toolExecutionRegistry.js";
import { toolExecutionService } from "../services/tools/toolExecutionService.js";
import { chatQueueManager } from "../services/chat/index.js";
import { McpTestServer } from "./mcpTestServer.js";
import { computeSchemaHash } from "@messiah/mcp";

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

describe("MESSIAH Phase 3B.1 — Agent Execution Reliability & Approval Verification", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let testMcpServer: McpTestServer;
  let mcpServerUrl: string;

  let ownerToken: string;
  let adminToken: string;

  let ownerId: string;
  let adminId: string;
  let memberId: string;
  let viewerId: string;

  let workspaceId: string;
  let threadId: string;
  let runId: string;
  let assistantMessageId: string;
  let providerConnectionId: string;

  const testRunId = Math.random().toString(36).substring(2, 9);

  beforeAll(async () => {
    process.env.VAULT_ENCRYPTION_KEY = TEST_VAULT_KEY;

    testMcpServer = new McpTestServer();
    mcpServerUrl = await testMcpServer.start();

    const testEnv = loadAndValidateEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "fatal",
      SUPABASE_JWT_SECRET: "messiah_test_jwt_secret_minimum_32_characters_long",
      VAULT_ENCRYPTION_KEY: TEST_VAULT_KEY,
    });

    app = await buildApp({ env: testEnv, logger: false });
    await app.ready();

    // Create 4 users with distinct workspace roles
    const owner = await prisma.user.create({
      data: {
        externalProvider: "supabase",
        externalId: `owner-${testRunId}`,
        email: `owner.${testRunId}@example.com`,
        fullName: "Owner User",
      },
    });
    ownerId = owner.id;

    const admin = await prisma.user.create({
      data: {
        externalProvider: "supabase",
        externalId: `admin-${testRunId}`,
        email: `admin.${testRunId}@example.com`,
        fullName: "Admin User",
      },
    });
    adminId = admin.id;

    const member = await prisma.user.create({
      data: {
        externalProvider: "supabase",
        externalId: `member-${testRunId}`,
        email: `member.${testRunId}@example.com`,
        fullName: "Member User",
      },
    });
    memberId = member.id;

    const viewer = await prisma.user.create({
      data: {
        externalProvider: "supabase",
        externalId: `viewer-${testRunId}`,
        email: `viewer.${testRunId}@example.com`,
        fullName: "Viewer User",
      },
    });
    viewerId = viewer.id;

    ownerToken = await createTestJwt({ sub: owner.externalId, email: owner.email });
    adminToken = await createTestJwt({ sub: admin.externalId, email: admin.email });

    // Seed Workspace
    const workspace = await prisma.workspace.create({
      data: {
        name: `Reliability Workspace ${testRunId}`,
        slug: `reliability-ws-${testRunId}`,
        ownerId,
        members: {
          create: [
            { userId: ownerId, role: "OWNER" },
            { userId: adminId, role: "ADMIN" },
            { userId: memberId, role: "MEMBER" },
            { userId: viewerId, role: "VIEWER" },
          ],
        },
      },
    });
    workspaceId = workspace.id;

    // Seed Provider Connection
    const provConn = await prisma.providerConnection.create({
      data: {
        workspaceId,
        provider: "OPENAI",
        displayName: "OpenAI Reliable",
        status: "ACTIVE",
      },
    });
    providerConnectionId = provConn.id;

    // Seed Thread
    const thread = await prisma.thread.create({
      data: {
        workspaceId,
        createdByUserId: ownerId,
        title: "Reliability Test Thread",
      },
    });
    threadId = thread.id;

    // Seed Assistant Message
    const assistantMsg = await prisma.message.create({
      data: {
        threadId,
        sequence: 1,
        role: "ASSISTANT",
        content: "I will run the tool.",
        status: "STREAMING",
        providerConnectionId,
        modelId: "gpt-4o",
      },
    });
    assistantMessageId = assistantMsg.id;

    // Seed Generation Run
    const run = await prisma.generationRun.create({
      data: {
        threadId,
        assistantMessageId,
        providerConnectionId,
        provider: "OPENAI",
        modelId: "gpt-4o",
        status: "STREAMING",
      },
    });
    runId = run.id;
  });

  afterAll(async () => {
    await testMcpServer.stop();
    await app.close();
  });

  describe("1. Collision-Resistant Tool Aliasing", () => {
    it("generates deterministic collision-resistant aliases for identical server and tool names", async () => {
      // Create two distinct MCP connections with the SAME name 'github' in the same workspace
      const connA = await prisma.mcpServerConnection.create({
        data: {
          workspaceId,
          name: "github",
          endpointUrl: "http://127.0.0.1:9001/mcp",
          transportType: "STREAMABLE_HTTP",
          status: "CONNECTED",
        },
      });

      const connB = await prisma.mcpServerConnection.create({
        data: {
          workspaceId,
          name: "github",
          endpointUrl: "http://127.0.0.1:9002/mcp",
          transportType: "STREAMABLE_HTTP",
          status: "CONNECTED",
        },
      });

      // Add identical toolName 'create_issue' to both connections
      const toolDefA = await prisma.mcpToolDefinition.create({
        data: {
          connectionId: connA.id,
          toolName: "create_issue",
          description: "Create an issue in Repo A",
          inputSchema: { type: "object", properties: { title: { type: "string" } } },
          schemaHash: "hash_tool_a",
          isAvailable: true,
        },
      });

      const toolDefB = await prisma.mcpToolDefinition.create({
        data: {
          connectionId: connB.id,
          toolName: "create_issue",
          description: "Create an issue in Repo B",
          inputSchema: { type: "object", properties: { title: { type: "string" } } },
          schemaHash: "hash_tool_b",
          isAvailable: true,
        },
      });

      // Get available tools for workspace thread
      const { definitions } = await toolExecutionRegistry.getAvailableToolsForThread(
        workspaceId,
        undefined
      );

      // Verify both tools are present in definitions with distinct provider aliases
      const toolAItem = definitions.find((d) => d.name.includes("create_issue") && d.description?.includes("Repo A"));
      const toolBItem = definitions.find((d) => d.name.includes("create_issue") && d.description?.includes("Repo B"));

      expect(toolAItem).toBeDefined();
      expect(toolBItem).toBeDefined();
      expect(toolAItem!.name).not.toBe(toolBItem!.name);

      const expectedSuffixA = connA.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 6).toLowerCase();
      const expectedSuffixB = connB.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 6).toLowerCase();

      expect(toolAItem!.name).toBe(`mcp__github_${expectedSuffixA}__create_issue`);
      expect(toolBItem!.name).toBe(`mcp__github_${expectedSuffixB}__create_issue`);

      // Verify resolution maps each alias strictly to its own connection ID
      const resolvedA = await toolExecutionRegistry.resolveToolAlias(workspaceId, toolAItem!.name);
      const resolvedB = await toolExecutionRegistry.resolveToolAlias(workspaceId, toolBItem!.name);

      expect(resolvedA?.connectionId).toBe(connA.id);
      expect(resolvedA?.toolDefinitionId).toBe(toolDefA.id);

      expect(resolvedB?.connectionId).toBe(connB.id);
      expect(resolvedB?.toolDefinitionId).toBe(toolDefB.id);
    });
  });

  describe("2. Durable Approval Resumption via Transactional Outbox", () => {
    let approvalId: string;
    let toolCallId: string;
    let toolDefId: string;
    let connectionId: string;

    beforeAll(async () => {
      const conn = await prisma.mcpServerConnection.create({
        data: {
          workspaceId,
          name: "test-service",
          endpointUrl: mcpServerUrl,
          transportType: "STREAMABLE_HTTP",
          status: "CONNECTED",
        },
      });
      connectionId = conn.id;

      const toolDef = await prisma.mcpToolDefinition.create({
        data: {
          connectionId: conn.id,
          toolName: "create_record",
          description: "Creates record",
          inputSchema: { type: "object", properties: { id: { type: "string" }, title: { type: "string" } } },
          schemaHash: "hash-def-create",
          isAvailable: true,
        },
      });
      toolDefId = toolDef.id;

      await prisma.mcpToolPermission.create({
        data: {
          workspaceId,
          toolDefinitionId: toolDef.id,
          permissionMode: "REQUIRE_APPROVAL",
          requiresApproval: true,
        },
      });
    });

    it("commits state changes and creates durable generation.resume OutboxEvent atomically", async () => {
      const req = await toolApprovalService.requestApproval({
        generationRunId: runId,
        threadId,
        workspaceId,
        toolDefinitionId: toolDefId,
        connectionId,
        providerCallId: "call_outbox_resume_test",
        providerToolAlias: "mcp__test_service__create_record",
        toolName: "create_record",
        schemaHash: "hash-def-create",
        arguments: { id: "rec_outbox_1", title: "Outbox Title" },
        requestedByUserId: ownerId,
      });

      approvalId = req.toolApproval.id;
      toolCallId = req.toolCall.id;

      // Mock chatQueueManager.enqueueRun to simulate failure during immediate queueing
      const enqueueSpy = vi.spyOn(chatQueueManager, "enqueueRun").mockRejectedValueOnce(
        new Error("Redis connection dropped temporarily")
      );

      // Approve the tool call: immediate enqueue fails, but the transaction MUST commit!
      const approved = await toolApprovalService.approve(approvalId, ownerId, "OWNER");
      expect(approved.status).toBe("APPROVED");

      // Verify database reflects consumed approval, approved tool call, and pending run
      const dbApproval = await prisma.toolApproval.findUnique({ where: { id: approvalId } });
      expect(dbApproval?.status).toBe("APPROVED");

      const dbToolCall = await prisma.toolCall.findUnique({ where: { id: toolCallId } });
      expect(dbToolCall?.status).toBe("APPROVED");

      const dbRun = await prisma.generationRun.findUnique({ where: { id: runId } });
      expect(dbRun?.status).toBe("PENDING");

      // Verify OutboxEvent with eventType 'generation.resume' was created in PENDING state
      const outboxEvent = await prisma.outboxEvent.findFirst({
        where: {
          aggregateId: runId,
          eventType: "generation.resume",
          status: "PENDING",
        },
      });

      expect(outboxEvent).toBeDefined();
      expect(outboxEvent?.aggregateType).toBe("GenerationRun");

      // Outbox sweeper recovery simulation:
      // Delete any leftover pending outbox events from previous test files to isolate this sweep
      await prisma.outboxEvent.deleteMany({
        where: {
          id: { not: outboxEvent!.id },
          status: "PENDING",
        },
      });

      // Restore real enqueueRun implementation so it performs real BullMQ enqueue and updates Outbox status
      enqueueSpy.mockRestore();

      const swept = await chatQueueManager.sweepOutbox();
      expect(swept).toBeGreaterThanOrEqual(1);

      // Verify outbox event is now PROCESSED
      const updatedOutbox = await prisma.outboxEvent.findUnique({ where: { id: outboxEvent!.id } });
      expect(updatedOutbox?.status).toBe("PROCESSED");
      expect(updatedOutbox?.processedAt).toBeDefined();
    });
  });

  describe("3. Approval Binding & Authorization Security", () => {
    let bindingToolDefId: string;
    let bindingConnId: string;
    const testArgs = { id: "rec_sec_1", title: "Secure Record" };
    const validSchemaHash = computeSchemaHash({ type: "object" });

    beforeAll(async () => {
      const conn = await prisma.mcpServerConnection.create({
        data: {
          workspaceId,
          name: "secure-mcp",
          endpointUrl: mcpServerUrl,
          transportType: "STREAMABLE_HTTP",
          status: "CONNECTED",
        },
      });
      bindingConnId = conn.id;

      const toolDef = await prisma.mcpToolDefinition.create({
        data: {
          connectionId: conn.id,
          toolName: "modify_record",
          description: "Modifies record",
          inputSchema: { type: "object" },
          schemaHash: validSchemaHash,
          isAvailable: true,
        },
      });
      bindingToolDefId = toolDef.id;

      await prisma.mcpToolPermission.create({
        data: {
          workspaceId,
          toolDefinitionId: toolDef.id,
          permissionMode: "REQUIRE_APPROVAL",
        },
      });
    });

    it("rejects approval attempts from MEMBER and VIEWER roles", async () => {
      const req = await toolApprovalService.requestApproval({
        generationRunId: runId,
        threadId,
        workspaceId,
        toolDefinitionId: bindingToolDefId,
        connectionId: bindingConnId,
        providerCallId: "call_role_check",
        providerToolAlias: "mcp__secure_mcp__modify_record",
        toolName: "modify_record",
        schemaHash: validSchemaHash,
        arguments: testArgs,
      });

      // Reject VIEWER
      await expect(
        toolApprovalService.approve(req.toolApproval.id, viewerId, "VIEWER")
      ).rejects.toThrow("Only workspace OWNER or ADMIN roles are permitted to approve tool executions.");

      // Reject MEMBER
      await expect(
        toolApprovalService.approve(req.toolApproval.id, memberId, "MEMBER")
      ).rejects.toThrow("Only workspace OWNER or ADMIN roles are permitted to approve tool executions.");

      // ADMIN must be allowed
      vi.spyOn(chatQueueManager, "enqueueRun").mockResolvedValue(true);
      const adminApproved = await toolApprovalService.approve(req.toolApproval.id, adminId, "ADMIN");
      expect(adminApproved.status).toBe("APPROVED");
    });

    it("rejects approval when cryptographic schemaHash or argumentsHash does not match", async () => {
      const req = await toolApprovalService.requestApproval({
        generationRunId: runId,
        threadId,
        workspaceId,
        toolDefinitionId: bindingToolDefId,
        connectionId: bindingConnId,
        providerCallId: "call_tamper_check",
        providerToolAlias: "mcp__secure_mcp__modify_record",
        toolName: "modify_record",
        schemaHash: validSchemaHash,
        arguments: testArgs,
      });

      // Context schemaHash mismatch
      await expect(
        toolApprovalService.approve(req.toolApproval.id, ownerId, "OWNER", {
          schemaHash: "tampered_schema_hash_attacker_modified",
        })
      ).rejects.toThrow("Schema hash binding mismatch.");

      // Context argumentsHash mismatch
      await expect(
        toolApprovalService.approve(req.toolApproval.id, ownerId, "OWNER", {
          argumentsHash: "tampered_args_hash_attacker_modified",
        })
      ).rejects.toThrow("Arguments hash binding mismatch.");
    });
  });

  describe("4. Execution Outcome Correctness & UNKNOWN_OUTCOME Handling", () => {
    let executionConnId: string;
    let timeoutToolDefId: string;
    let severToolDefId: string;
    let errorToolDefId: string;
    let readToolDefId: string;

    beforeAll(async () => {
      const conn = await prisma.mcpServerConnection.create({
        data: {
          workspaceId,
          name: "outcome-mcp",
          endpointUrl: mcpServerUrl,
          transportType: "STREAMABLE_HTTP",
          status: "CONNECTED",
        },
      });
      executionConnId = conn.id;

      const timeoutDef = await prisma.mcpToolDefinition.create({
        data: {
          connectionId: conn.id,
          toolName: "timeout_op",
          inputSchema: { type: "object", properties: { delayMs: { type: "number" } } },
          schemaHash: "hash-timeout",
          isAvailable: true,
        },
      });
      timeoutToolDefId = timeoutDef.id;

      const severDef = await prisma.mcpToolDefinition.create({
        data: {
          connectionId: conn.id,
          toolName: "sever_op",
          inputSchema: { type: "object" },
          schemaHash: "hash-sever",
          isAvailable: true,
        },
      });
      severToolDefId = severDef.id;

      const errorDef = await prisma.mcpToolDefinition.create({
        data: {
          connectionId: conn.id,
          toolName: "error_op",
          inputSchema: { type: "object", properties: { reason: { type: "string" } } },
          schemaHash: "hash-error",
          isAvailable: true,
        },
      });
      errorToolDefId = errorDef.id;

      const readDef = await prisma.mcpToolDefinition.create({
        data: {
          connectionId: conn.id,
          toolName: "read_record",
          inputSchema: { type: "object", properties: { id: { type: "string" } } },
          schemaHash: "hash-read",
          isAvailable: true,
          annotations: { readOnly: true },
        },
      });
      readToolDefId = readDef.id;
    });

    it("marks tool execution as UNKNOWN_OUTCOME on timeout and does not treat as normal failure", async () => {
      const toolCall = await prisma.toolCall.create({
        data: {
          generationRunId: runId,
          threadId,
          workspaceId,
          toolDefinitionId: timeoutToolDefId,
          connectionId: executionConnId,
          providerCallId: "call_timeout_test_1",
          providerToolAlias: "mcp__outcome_mcp__timeout_op",
          toolName: "timeout_op",
          schemaHash: "hash-timeout",
          argumentsHash: "hash-args-timeout",
          argumentsPreview: { delayMs: 2000 },
          status: "APPROVED",
        },
      });

      // Execute with a short 200ms timeout against the test server's 2000ms delay
      const outcome = await toolExecutionService.executeTool({
        toolCallId: toolCall.id,
        generationRunId: runId,
        threadId,
        workspaceId,
        connectionId: executionConnId,
        toolDefinitionId: timeoutToolDefId,
        toolName: "timeout_op",
        providerCallId: "call_timeout_test_1",
        providerToolAlias: "mcp__outcome_mcp__timeout_op",
        arguments: { delayMs: 2000 },
        timeoutMs: 200,
      });

      expect(outcome.status).toBe("UNKNOWN_OUTCOME");
      expect(outcome.isError).toBe(true);
      expect(outcome.errorMessage).toContain("Operation outcome is unknown");
      expect(outcome.errorMessage).toContain("Do not automatically re-execute");

      // Verify persisted database record
      const dbToolCall = await prisma.toolCall.findUnique({ where: { id: toolCall.id } });
      expect(dbToolCall?.status).toBe("UNKNOWN_OUTCOME");
      expect(dbToolCall?.isError).toBe(true);
    });

    it("marks tool execution as UNKNOWN_OUTCOME when socket connection is severed mid-request", async () => {
      const toolCall = await prisma.toolCall.create({
        data: {
          generationRunId: runId,
          threadId,
          workspaceId,
          toolDefinitionId: severToolDefId,
          connectionId: executionConnId,
          providerCallId: "call_sever_test_1",
          providerToolAlias: "mcp__outcome_mcp__sever_op",
          toolName: "sever_op",
          schemaHash: "hash-sever",
          argumentsHash: "hash-args-sever",
          argumentsPreview: {},
          status: "APPROVED",
        },
      });

      const outcome = await toolExecutionService.executeTool({
        toolCallId: toolCall.id,
        generationRunId: runId,
        threadId,
        workspaceId,
        connectionId: executionConnId,
        toolDefinitionId: severToolDefId,
        toolName: "sever_op",
        providerCallId: "call_sever_test_1",
        providerToolAlias: "mcp__outcome_mcp__sever_op",
        arguments: {},
        timeoutMs: 2000,
      });

      expect(outcome.status).toBe("UNKNOWN_OUTCOME");
      expect(outcome.isError).toBe(true);
      expect(outcome.errorMessage).toContain("Operation outcome is unknown");
    });

    it("correctly identifies definitive application tool errors as FAILED", async () => {
      const toolCall = await prisma.toolCall.create({
        data: {
          generationRunId: runId,
          threadId,
          workspaceId,
          toolDefinitionId: errorToolDefId,
          connectionId: executionConnId,
          providerCallId: "call_error_test_1",
          providerToolAlias: "mcp__outcome_mcp__error_op",
          toolName: "error_op",
          schemaHash: "hash-error",
          argumentsHash: "hash-args-error",
          argumentsPreview: { reason: "Foreign key missing" },
          status: "APPROVED",
        },
      });

      const outcome = await toolExecutionService.executeTool({
        toolCallId: toolCall.id,
        generationRunId: runId,
        threadId,
        workspaceId,
        connectionId: executionConnId,
        toolDefinitionId: errorToolDefId,
        toolName: "error_op",
        providerCallId: "call_error_test_1",
        providerToolAlias: "mcp__outcome_mcp__error_op",
        arguments: { reason: "Foreign key missing" },
      });

      expect(outcome.status).toBe("FAILED");
      expect(outcome.isError).toBe(true);
      expect(outcome.sanitizedText).toContain("ApplicationError: Foreign key missing");

      const dbToolCall = await prisma.toolCall.findUnique({ where: { id: toolCall.id } });
      expect(dbToolCall?.status).toBe("FAILED");
    });

    it("executes read_record successfully and returns parsed output", async () => {
      const toolCall = await prisma.toolCall.create({
        data: {
          generationRunId: runId,
          threadId,
          workspaceId,
          toolDefinitionId: readToolDefId,
          connectionId: executionConnId,
          providerCallId: "call_read_test_1",
          providerToolAlias: "mcp__outcome_mcp__read_record",
          toolName: "read_record",
          schemaHash: "hash-read",
          argumentsHash: "hash-args-read",
          argumentsPreview: { id: "rec_1" },
          status: "APPROVED",
        },
      });

      const outcome = await toolExecutionService.executeTool({
        toolCallId: toolCall.id,
        generationRunId: runId,
        threadId,
        workspaceId,
        connectionId: executionConnId,
        toolDefinitionId: readToolDefId,
        toolName: "read_record",
        providerCallId: "call_read_test_1",
        providerToolAlias: "mcp__outcome_mcp__read_record",
        arguments: { id: "rec_1" },
      });

      expect(outcome.status).toBe("SUCCEEDED");
      expect(outcome.isError).toBe(false);
      expect(outcome.sanitizedText).toContain("Existing Record");
    });
  });

  describe("5. Cross-Device Approval Simulation", () => {
    let crossApprovalId: string;

    beforeEach(async () => {
      // Create a fresh pending approval for each test
      const conn = await prisma.mcpServerConnection.findFirst({
        where: { workspaceId, status: "CONNECTED" },
      });
      const toolDef = await prisma.mcpToolDefinition.findFirst({
        where: { connectionId: conn!.id },
      });

      const req = await toolApprovalService.requestApproval({
        generationRunId: runId,
        threadId,
        workspaceId,
        toolDefinitionId: toolDef!.id,
        connectionId: conn!.id,
        providerCallId: `call_cross_${Date.now()}`,
        providerToolAlias: "mcp__test__op",
        toolName: "create_record",
        schemaHash: "hash-cross",
        arguments: { id: "cross_rec", title: "Cross Title" },
      });

      crossApprovalId = req.toolApproval.id;
    });

    it("accepts Device A approval and cleanly rejects simultaneous Device B action with ALREADY_DECIDED", async () => {
      vi.spyOn(chatQueueManager, "enqueueRun").mockResolvedValue(true);

      // Device A and Device B fire simultaneous requests to approve the same pending approval
      const [resA, resB] = await Promise.all([
        app.inject({
          method: "POST",
          url: `/api/v1/tool-approvals/${crossApprovalId}/approve`,
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            "Content-Type": "application/json",
          },
          payload: { workspaceId },
        }),
        app.inject({
          method: "POST",
          url: `/api/v1/tool-approvals/${crossApprovalId}/approve`,
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          payload: { workspaceId },
        }),
      ]);

      // Exactly one must succeed with 200, and the concurrent one must fail with 400 ALREADY_DECIDED
      const statuses = [resA.statusCode, resB.statusCode].sort();
      expect(statuses).toEqual([200, 400]);

      const failedRes = resA.statusCode === 400 ? resA : resB;
      const failedBody = JSON.parse(failedRes.body);
      expect(failedBody.error?.code).toBe("ALREADY_DECIDED");
      expect(failedBody.error?.message).toMatch(/already (decided|approved|denied)/i);

      // Verify single-use guarantee: the database reflects exactly one decision
      const finalApproval = await prisma.toolApproval.findUnique({
        where: { id: crossApprovalId },
      });
      expect(finalApproval?.status).toBe("APPROVED");
    });

    it("rejects Device B denial if Device A has already approved", async () => {
      vi.spyOn(chatQueueManager, "enqueueRun").mockResolvedValue(true);

      // Device A approves first
      const resA = await app.inject({
        method: "POST",
        url: `/api/v1/tool-approvals/${crossApprovalId}/approve`,
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "Content-Type": "application/json",
        },
        payload: { workspaceId },
      });
      expect(resA.statusCode).toBe(200);

      // Device B attempts to deny the already approved request
      const resB = await app.inject({
        method: "POST",
        url: `/api/v1/tool-approvals/${crossApprovalId}/deny`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        payload: { workspaceId, reason: "Too late" },
      });

      expect(resB.statusCode).toBe(400);
      const bodyB = JSON.parse(resB.body);
      expect(bodyB.error?.code).toBe("ALREADY_DECIDED");
    });
  });
});
