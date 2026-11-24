import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as jose from "jose";
import { buildApp } from "../app.js";
import { loadAndValidateEnv } from "../config/env.js";
import { VaultService, LocalKmsService, CredentialDecryptionError, VaultConfigurationError } from "../services/vaultService.js";
import { defaultProviderRegistry } from "@messiah/providers";
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

describe("MESSIAH Phase 2A — AI Providers & Encrypted Credential Vault Test Suite", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let userAToken: string;
  let userBToken: string;
  let userBId: string;
  let userAWorkspaceId: string;
  let userBWorkspaceId: string;
  let createdConnectionId: string;

  const runId = Math.random().toString(36).substring(2, 9);
  const userAExternalId = `supabase-prov-a-${runId}`;
  const userBExternalId = `supabase-prov-b-${runId}`;
  const userAEmail = `prov.alex.${runId}@example.com`;
  const userBEmail = `prov.elena.${runId}@example.com`;

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
      user_metadata: { full_name: "Alex Provider Architect" },
    });

    userBToken = await createTestJwt({
      sub: userBExternalId,
      email: userBEmail,
      user_metadata: { full_name: "Elena Provider Member" },
    });

    // 1. Resolve User A and their personal workspace
    const resA = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${userAToken}` },
    });
    const dataA = resA.json();
    userAWorkspaceId = dataA.data.memberships[0].workspaceId;

    // 2. Resolve User B and their personal workspace
    const resB = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${userBToken}` },
    });
    const dataB = resB.json();
    userBId = dataB.data.id;
    userBWorkspaceId = dataB.data.memberships[0].workspaceId;
  });

  afterAll(async () => {
    await app.close();
  });

  // ---------------------------------------------------------------------------
  // 1. CREDENTIAL VAULT (AES-256-GCM) TESTS
  // ---------------------------------------------------------------------------
  describe("1. Provider Credential Vault Security & Integrity", () => {
    const vault = new VaultService(new LocalKmsService(TEST_VAULT_KEY));

    it("should encrypt plaintext into AES-256-GCM ciphertext with 12-byte IV and 16-byte tag", () => {
      const plaintext = "sk-proj-super-secret-openai-api-key-12345";
      const encrypted = vault.encrypt(plaintext);

      expect(encrypted.ciphertext).toBeDefined();
      expect(encrypted.ciphertext).not.toBe(plaintext);
      expect(encrypted.initializationVector).toHaveLength(24); // 12 bytes = 24 hex chars
      expect(encrypted.authenticationTag).toHaveLength(32); // 16 bytes = 32 hex chars
      expect(encrypted.keyVersion).toBe("v1");
    });

    it("should decrypt ciphertext back to exact original plaintext", () => {
      const plaintext = "sk-ant-api-key-confidential-token-67890";
      const encrypted = vault.encrypt(plaintext);
      const decrypted = vault.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it("should reject tampered ciphertext and fail safely with CredentialDecryptionError", () => {
      const encrypted = vault.encrypt("sensitive-token");
      // Tamper with first two hex characters
      const tamperedCiphertext = "ff" + encrypted.ciphertext.slice(2);

      expect(() =>
        vault.decrypt({ ...encrypted, ciphertext: tamperedCiphertext })
      ).toThrow(CredentialDecryptionError);
    });

    it("should reject tampered authentication tag and fail safely", () => {
      const encrypted = vault.encrypt("sensitive-token");
      // Tamper with tag
      const tamperedTag = "00".repeat(16);

      expect(() =>
        vault.decrypt({ ...encrypted, authenticationTag: tamperedTag })
      ).toThrow(CredentialDecryptionError);
    });

    it("should fail safely when encryption master key is missing or invalid", () => {
      expect(() => new LocalKmsService("short-key")).toThrow(VaultConfigurationError);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. PROVIDER REGISTRY API ENDPOINTS
  // ---------------------------------------------------------------------------
  describe("2. Provider Registry Endpoints (GET /api/v1/providers)", () => {
    it("should reject unauthenticated request with 401", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/providers",
      });
      expect(res.statusCode).toBe(401);
    });

    it("should return the list of supported providers with normalized capabilities", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/providers",
        headers: { authorization: `Bearer ${userAToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.length).toBe(3);

      const ids = body.data.map((p: { id: string }) => p.id);
      expect(ids).toContain("openai");
      expect(ids).toContain("anthropic");
      expect(ids).toContain("gemini");
    });
  });

  // ---------------------------------------------------------------------------
  // 3. PROVIDER CONNECTIONS CRUD & RBAC
  // ---------------------------------------------------------------------------
  describe("3. Provider Connections CRUD & Workspace Authorization", () => {
    it("POST /api/v1/provider-connections should create and encrypt valid connection", async () => {
      // Mock validation on default OpenAI adapter
      const adapter = defaultProviderRegistry.getAdapter("openai");
      vi.spyOn(adapter, "validateCredentials").mockResolvedValue({
        valid: true,
        message: "Authenticated",
        testedAt: new Date().toISOString(),
        modelsFound: 10,
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/provider-connections",
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          workspaceId: userAWorkspaceId,
          provider: "openai",
          displayName: "Primary OpenAI Production Key",
          apiKey: "sk-proj-test-valid-api-key-1234567890",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.displayName).toBe("Primary OpenAI Production Key");
      expect(body.data.status).toBe("ACTIVE");
      expect(body.data.provider).toBe("openai");

      // CRITICAL SECURITY ASSERTION: API key or ciphertext must NEVER be returned in response!
      expect(body.data.apiKey).toBeUndefined();
      expect(body.data.ciphertext).toBeUndefined();
      expect(body.data.credential).toBeUndefined();

      createdConnectionId = body.data.id;

      // Verify database record has ciphertext and NOT the plaintext key
      const dbCred = await prisma.encryptedCredential.findUnique({
        where: { providerConnectionId: createdConnectionId },
      });
      expect(dbCred).toBeDefined();
      expect(dbCred?.ciphertext).not.toBe("sk-proj-test-valid-api-key-1234567890");
      expect(dbCred?.initializationVector).toHaveLength(24);
      expect(dbCred?.authenticationTag).toHaveLength(32);
    });

    it("POST /api/v1/provider-connections should reject invalid credentials without saving to DB", async () => {
      const adapter = defaultProviderRegistry.getAdapter("anthropic");
      vi.spyOn(adapter, "validateCredentials").mockRejectedValue(
        new Error("Invalid API Key for Anthropic")
      );

      const countBefore = await prisma.providerConnection.count();

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/provider-connections",
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          workspaceId: userAWorkspaceId,
          provider: "anthropic",
          displayName: "Faulty Anthropic Key",
          apiKey: "sk-ant-invalid-token-123456789",
        },
      });

      expect(res.statusCode).toBe(500);
      const countAfter = await prisma.providerConnection.count();
      expect(countAfter).toBe(countBefore); // Nothing saved
    });

    it("GET /api/v1/provider-connections should return connections without secrets", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/provider-connections?workspaceId=${userAWorkspaceId}`,
        headers: { authorization: `Bearer ${userAToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.length).toBeGreaterThanOrEqual(1);

      const found = body.data.find((c: { id: string }) => c.id === createdConnectionId);
      expect(found).toBeDefined();
      expect(found.apiKey).toBeUndefined();
      expect(found.ciphertext).toBeUndefined();
    });

    it("POST /api/v1/provider-connections/:id/test should re-test connection and return status", async () => {
      const adapter = defaultProviderRegistry.getAdapter("openai");
      vi.spyOn(adapter, "validateCredentials").mockResolvedValue({
        valid: true,
        message: "Re-validation verified",
        testedAt: new Date().toISOString(),
        modelsFound: 15,
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/provider-connections/${createdConnectionId}/test`,
        headers: { authorization: `Bearer ${userAToken}` },
        payload: { workspaceId: userAWorkspaceId },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.valid).toBe(true);
      expect(body.data.modelsFound).toBe(15);
    });

    it("PATCH /api/v1/provider-connections/:id should rename connection without exposing credentials", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/provider-connections/${createdConnectionId}`,
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          workspaceId: userAWorkspaceId,
          displayName: "Renamed OpenAI Production Key",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.displayName).toBe("Renamed OpenAI Production Key");
      expect(body.data.apiKey).toBeUndefined();
    });

    it("GET /api/v1/providers/openai/models should discover models using authorized connection", async () => {
      const adapter = defaultProviderRegistry.getAdapter("openai");
      vi.spyOn(adapter, "listModels").mockResolvedValue([
        {
          id: "gpt-4o",
          name: "gpt-4o",
          provider: "openai",
          capabilities: { vision: true, toolCalling: true },
          status: "available",
        },
      ]);

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/providers/openai/models?workspaceId=${userAWorkspaceId}`,
        headers: { authorization: `Bearer ${userAToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data[0].id).toBe("gpt-4o");
    });
  });

  // ---------------------------------------------------------------------------
  // 4. RBAC & ANTI-IDOR TENANCY ISOLATION TESTS
  // ---------------------------------------------------------------------------
  describe("4. RBAC & Anti-IDOR Security Gates", () => {
    it("MEMBER cannot create provider connection (403 FORBIDDEN_ROLE)", async () => {
      // Add User B as MEMBER to User A's workspace
      await prisma.workspaceMember.create({
        data: {
          workspaceId: userAWorkspaceId,
          userId: userBId,
          role: "MEMBER",
        },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/provider-connections",
        headers: { authorization: `Bearer ${userBToken}` },
        payload: {
          workspaceId: userAWorkspaceId,
          provider: "openai",
          displayName: "Unauthorized Member Key",
          apiKey: "sk-proj-unauthorized-member-12345",
        },
      });

      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.error.code).toBe("FORBIDDEN_ROLE");
    });

    it("MEMBER cannot test provider connection (403 FORBIDDEN_ROLE)", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/provider-connections/${createdConnectionId}/test`,
        headers: { authorization: `Bearer ${userBToken}` },
        payload: { workspaceId: userAWorkspaceId },
      });

      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.error.code).toBe("FORBIDDEN_ROLE");
    });

    it("Cross-Tenant Access: User B in Workspace B cannot access Workspace A connections (404 WORKSPACE_NOT_FOUND)", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/provider-connections/${createdConnectionId}/test`,
        headers: { authorization: `Bearer ${userBToken}` },
        payload: { workspaceId: userBWorkspaceId }, // passing B workspace with A's connectionId
      });

      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error.code).toBe("CONNECTION_NOT_FOUND");
    });

    it("DELETE /api/v1/provider-connections/:id cascades and deletes encrypted credential", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/provider-connections/${createdConnectionId}?workspaceId=${userAWorkspaceId}`,
        headers: { authorization: `Bearer ${userAToken}` },
      });

      expect(res.statusCode).toBe(200);

      // Verify connection and cascaded credential are gone
      const conn = await prisma.providerConnection.findUnique({
        where: { id: createdConnectionId },
      });
      expect(conn).toBeNull();

      const cred = await prisma.encryptedCredential.findUnique({
        where: { providerConnectionId: createdConnectionId },
      });
      expect(cred).toBeNull();
    });

    it("Audit log records security operations without leaking secrets", async () => {
      const auditLogs = await prisma.auditLog.findMany({
        where: { workspaceId: userAWorkspaceId },
        orderBy: { createdAt: "desc" },
      });

      expect(auditLogs.length).toBeGreaterThanOrEqual(1);
      auditLogs.forEach((log) => {
        const detailsString = JSON.stringify(log.details);
        expect(detailsString).not.toContain("sk-proj-");
        expect(detailsString).not.toContain("sk-ant-");
        expect(detailsString).not.toContain("secret");
      });
    });
  });
});
