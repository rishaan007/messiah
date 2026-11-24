import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as jose from "jose";
import { buildApp } from "../app.js";
import { loadAndValidateEnv } from "../config/env.js";
import { prisma } from "@messiah/db";

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

describe("MESSIAH Phase 3A — MCP Server Connections & Tool Registry Test Suite", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let userAToken: string;
  let userBToken: string;
  let userAId: string;
  let userBId: string;
  let userAWorkspaceId: string;
  let userBWorkspaceId: string;
  let createdConnectionId: string;
  let createdToolDefId: string;

  const runId = Math.random().toString(36).substring(2, 9);
  const userAExternalId = `supabase-mcp-a-${runId}`;
  const userBExternalId = `supabase-mcp-b-${runId}`;
  const userAEmail = `mcp.alex.${runId}@example.com`;
  const userBEmail = `mcp.elena.${runId}@example.com`;

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

    userAToken = await createTestJwt({
      sub: userAExternalId,
      email: userAEmail,
      user_metadata: { full_name: "Alex MCP Architect" },
    });

    userBToken = await createTestJwt({
      sub: userBExternalId,
      email: userBEmail,
      user_metadata: { full_name: "Elena MCP Viewer" },
    });

    // 1. Provision User A and their workspace
    const resA = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${userAToken}` },
    });
    const dataA = resA.json();
    userAId = dataA.data.id;
    userAWorkspaceId = dataA.data.memberships[0].workspaceId;

    // 2. Provision User B and their workspace
    const resB = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${userBToken}` },
    });
    const dataB = resB.json();
    userBId = dataB.data.id;
    userBWorkspaceId = dataB.data.memberships[0].workspaceId;

    // 3. Add User B as a MEMBER (not admin) to Workspace A for RBAC testing
    await prisma.workspaceMember.create({
      data: {
        workspaceId: userAWorkspaceId,
        userId: userBId,
        role: "MEMBER",
      },
    });
  });

  afterAll(async () => {
    // Cleanup created test records
    if (userAWorkspaceId && userBWorkspaceId) {
      await prisma.mcpServerConnection.deleteMany({
        where: { workspaceId: { in: [userAWorkspaceId, userBWorkspaceId] } },
      });
      await prisma.workspaceMember.deleteMany({
        where: { workspaceId: { in: [userAWorkspaceId, userBWorkspaceId] } },
      });
      await prisma.workspace.deleteMany({
        where: { id: { in: [userAWorkspaceId, userBWorkspaceId] } },
      });
    }
    if (userAId && userBId) {
      await prisma.user.deleteMany({
        where: { id: { in: [userAId, userBId] } },
      });
    }
    await app.close();
  });

  describe("1. MCP Connection Creation & SSRF Security", () => {
    it("rejects connection creation without authentication (401)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/mcp/connections",
        payload: {
          workspaceId: userAWorkspaceId,
          name: "Unauthenticated Test",
          endpointUrl: "https://mcp.example.com/api",
        },
      });

      expect(res.statusCode).toBe(401);
    });

    it("rejects invalid payloads with validation error (422)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/mcp/connections",
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          workspaceId: "not-a-uuid",
          name: "X", // too short (< 2)
          endpointUrl: "not-a-url",
        },
      });

      expect(res.statusCode).toBe(422);
      const json = res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects loopback and private SSRF endpoints (400)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/mcp/connections",
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          workspaceId: userAWorkspaceId,
          name: "SSRF Attack Attempt",
          endpointUrl: "http://127.0.0.1:8080/mcp",
          transportType: "STREAMABLE_HTTP",
        },
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe("SSRF_VALIDATION_FAILED");
    });

    it("rejects AWS/GCP cloud metadata SSRF endpoints (400)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/mcp/connections",
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          workspaceId: userAWorkspaceId,
          name: "Metadata Attack Attempt",
          endpointUrl: "http://169.254.169.254/latest/meta-data",
        },
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe("SSRF_VALIDATION_FAILED");
    });

    it("rejects evasive octal and dword integer IP endpoints (400)", async () => {
      const res1 = await app.inject({
        method: "POST",
        url: "/api/v1/mcp/connections",
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          workspaceId: userAWorkspaceId,
          name: "Octal Attack Attempt",
          endpointUrl: "https://0177.0.0.1/mcp",
        },
      });

      expect(res1.statusCode).toBe(400);
      expect(res1.json().error.code).toBe("SSRF_VALIDATION_FAILED");

      const res2 = await app.inject({
        method: "POST",
        url: "/api/v1/mcp/connections",
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          workspaceId: userAWorkspaceId,
          name: "Dword Integer Attack Attempt",
          endpointUrl: "https://2130706433/mcp",
        },
      });

      expect(res2.statusCode).toBe(400);
      expect(res2.json().error.code).toBe("SSRF_VALIDATION_FAILED");
    });

    it("successfully creates a connection and encrypts bearer token in Vault v2 (201)", async () => {
      const rawBearerToken = "mcp_secret_token_live_xyz_1234567890";

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/mcp/connections",
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          workspaceId: userAWorkspaceId,
          name: "Production MCP Server",
          endpointUrl: "https://example.com/mcp",
          transportType: "STREAMABLE_HTTP",
          authType: "BEARER",
          bearerToken: rawBearerToken,
        },
      });

      expect(res.statusCode).toBe(201);
      const json = res.json();
      expect(json.success).toBe(true);
      expect(json.data.name).toBe("Production MCP Server");
      expect(json.data.status).toBe("DISCONNECTED");
      expect(json.data.authenticationStatus).toBe("CONFIGURED");
      expect(json.data.toolCount).toBe(0);
      expect(json.data.bearerToken).toBeUndefined(); // Never returned

      createdConnectionId = json.data.id;

      // Verify DB persistence & AES-256-GCM v2 AAD encryption
      const storedCred = await prisma.mcpCredential.findUnique({
        where: { connectionId: createdConnectionId },
      });

      expect(storedCred).toBeDefined();
      expect(storedCred?.authType).toBe("BEARER");
      expect(storedCred?.encryptionKeyVersion).toBe("v2");
      expect(storedCred?.encryptedAccessToken).not.toContain(rawBearerToken);

      // Verify that stored JSON payload contains ciphertext, iv, authTag
      const parsedPayload = JSON.parse(storedCred!.encryptedAccessToken!);
      expect(parsedPayload.ciphertext).toBeDefined();
      expect(parsedPayload.initializationVector).toBeDefined();
      expect(parsedPayload.authenticationTag).toBeDefined();
    });

    it("rejects duplicate connection names in the same workspace (409)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/mcp/connections",
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          workspaceId: userAWorkspaceId,
          name: "Production MCP Server", // Same name as above
          endpointUrl: "https://example.com/mcp2",
        },
      });

      expect(res.statusCode).toBe(409);
      const json = res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe("DUPLICATE_CONNECTION_NAME");
    });
  });

  describe("2. RBAC & Anti-IDOR Protections", () => {
    it("non-member cannot list connections in private workspace (404 anti-IDOR)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/mcp/connections?workspaceId=${userAWorkspaceId}`,
        headers: {
          // Token for a random third user
          authorization: `Bearer ${await createTestJwt({
            sub: "random-third-party",
            email: "intruder@example.com",
          })}`,
        },
      });

      expect(res.statusCode).toBe(404);
      const json = res.json();
      expect(json.error.code).toBe("WORKSPACE_NOT_FOUND");
    });

    it("workspace MEMBER role cannot create new connections (403)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/mcp/connections",
        headers: { authorization: `Bearer ${userBToken}` }, // User B is MEMBER in Workspace A
        payload: {
          workspaceId: userAWorkspaceId,
          name: "Unauthorized Server",
          endpointUrl: "https://unauthorized.acme.com/mcp",
        },
      });

      expect(res.statusCode).toBe(403);
      const json = res.json();
      expect(json.error.code).toBe("FORBIDDEN_ROLE");
    });

    it("workspace MEMBER can list connections in their workspace (200)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/mcp/connections?workspaceId=${userAWorkspaceId}`,
        headers: { authorization: `Bearer ${userBToken}` },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].id).toBe(createdConnectionId);
    });

    it("workspace MEMBER cannot delete a connection (403)", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/mcp/connections/${createdConnectionId}`,
        headers: { authorization: `Bearer ${userBToken}` },
      });

      expect(res.statusCode).toBe(403);
      const json = res.json();
      expect(json.error.code).toBe("FORBIDDEN_ROLE");
    });
  });

  describe("3. Connection Retrieval & Details Inspection", () => {
    it("retrieves connection by ID with discovered tools list (200)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/mcp/connections/${createdConnectionId}`,
        headers: { authorization: `Bearer ${userAToken}` },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.success).toBe(true);
      expect(json.data.connection.id).toBe(createdConnectionId);
      expect(json.data.connection.name).toBe("Production MCP Server");
      expect(json.data.tools).toEqual([]);
    });

    it("returns 404 for nonexistent connection ID", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/mcp/connections/00000000-0000-0000-0000-000000000000",
        headers: { authorization: `Bearer ${userAToken}` },
      });

      expect(res.statusCode).toBe(404);
      const json = res.json();
      expect(json.error.code).toBe("CONNECTION_NOT_FOUND");
    });
  });

  describe("4. Connection Update & Credential Rotation", () => {
    it("rejects updating endpoint to an SSRF restricted address (400)", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/mcp/connections/${createdConnectionId}`,
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          endpointUrl: "http://192.168.1.1/admin",
        },
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.code).toBe("SSRF_VALIDATION_FAILED");
    });

    it("updates connection name and rotates bearer token (200)", async () => {
      const rotatedToken = "mcp_secret_rotated_token_9876543210";

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/mcp/connections/${createdConnectionId}`,
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          name: "Updated MCP Server",
          bearerToken: rotatedToken,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.success).toBe(true);
      expect(json.data.name).toBe("Updated MCP Server");

      // Verify updated encrypted token in DB
      const storedCred = await prisma.mcpCredential.findUnique({
        where: { connectionId: createdConnectionId },
      });
      expect(storedCred).toBeDefined();
      expect(storedCred?.encryptedAccessToken).not.toContain(rotatedToken);
    });
  });

  describe("5. Tool Synchronization & Permission Model", () => {
    it("retrieves discovered tools with namespaced name and permissions", async () => {
      // Simulate discovering a tool in DB for the created connection
      const toolDef = await prisma.mcpToolDefinition.create({
        data: {
          connectionId: createdConnectionId,
          toolName: "execute_sql_query",
          displayName: "Execute SQL Query",
          description: "Runs read-only analytics query",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
          schemaHash: "hash_execute_sql_001",
          isAvailable: true,
          permission: {
            create: {
              workspaceId: userAWorkspaceId,
              permissionMode: "REQUIRE_APPROVAL",
              requiresApproval: true,
              configuredByUserId: userAId,
            },
          },
        },
      });
      createdToolDefId = toolDef.id;

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/mcp/tools?workspaceId=${userAWorkspaceId}`,
        headers: { authorization: `Bearer ${userAToken}` },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(1);

      const tool = json.data[0];
      expect(tool.toolName).toBe("execute_sql_query");
      expect(tool.namespacedName).toBe("updated_mcp_server.execute_sql_query");
      expect(tool.permission.permissionMode).toBe("REQUIRE_APPROVAL");
      expect(tool.permission.requiresApproval).toBe(true);
    });

    it("MEMBER cannot update tool permission mode (403)", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/mcp/tools/${createdToolDefId}/permission`,
        headers: { authorization: `Bearer ${userBToken}` },
        payload: {
          permissionMode: "EXPLICITLY_AUTHORIZED",
        },
      });

      expect(res.statusCode).toBe(403);
      const json = res.json();
      expect(json.error.code).toBe("FORBIDDEN_ROLE");
    });

    it("OWNER can configure tool permission mode (200)", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/mcp/tools/${createdToolDefId}/permission`,
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          permissionMode: "READ_ONLY",
          requiresApproval: false,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.success).toBe(true);
      expect(json.data.permissionMode).toBe("READ_ONLY");
      expect(json.data.requiresApproval).toBe(false);

      // Verify in DB
      const perm = await prisma.mcpToolPermission.findUnique({
        where: { toolDefinitionId: createdToolDefId },
      });
      expect(perm?.permissionMode).toBe("READ_ONLY");
      expect(perm?.requiresApproval).toBe(false);
    });

    it("cross-workspace intruder cannot configure tool permission mode (404 anti-IDOR)", async () => {
      const userCToken = await createTestJwt({
        sub: `supabase-mcp-c-${runId}`,
        email: `intruder.${runId}@example.com`,
      });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/mcp/tools/${createdToolDefId}/permission`,
        headers: { authorization: `Bearer ${userCToken}` },
        payload: {
          permissionMode: "READ_ONLY",
          requiresApproval: false,
        },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("WORKSPACE_NOT_FOUND");
    });
  });

  describe("6. Connection Deletion & Cascading Cleanup", () => {
    it("deletes MCP connection and cascades to delete credentials and tools (200)", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/mcp/connections/${createdConnectionId}`,
        headers: { authorization: `Bearer ${userAToken}` },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.success).toBe(true);
      expect(json.data.deleted).toBe(true);

      // Verify deletion in database
      const conn = await prisma.mcpServerConnection.findUnique({
        where: { id: createdConnectionId },
      });
      expect(conn).toBeNull();

      const cred = await prisma.mcpCredential.findUnique({
        where: { connectionId: createdConnectionId },
      });
      expect(cred).toBeNull();

      const tools = await prisma.mcpToolDefinition.findMany({
        where: { connectionId: createdConnectionId },
      });
      expect(tools).toHaveLength(0);
    });
  });
});
