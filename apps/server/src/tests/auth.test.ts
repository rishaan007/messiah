import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as jose from 'jose';
import { buildApp } from '../app.js';
import { loadAndValidateEnv } from '../config/env.js';

const TEST_SECRET = new TextEncoder().encode('messiah_test_jwt_secret_minimum_32_characters_long');

async function createTestJwt(payload: {
  sub: string;
  email: string;
  user_metadata?: { full_name?: string; avatar_url?: string };
  exp?: number;
}): Promise<string> {
  const jwtBuilder = new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt();

  if (payload.exp !== undefined) {
    jwtBuilder.setExpirationTime(payload.exp);
  } else {
    jwtBuilder.setExpirationTime('1h');
  }

  return await jwtBuilder.sign(TEST_SECRET);
}

describe('Messiah Authentication & Workspace Security Suite', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let userAToken: string;
  let userBToken: string;
  let userAWorkspaceId: string;
  const runId = Math.random().toString(36).substring(2, 9);
  const userAExternalId = `supabase-user-a-${runId}`;
  const userBExternalId = `supabase-user-b-${runId}`;
  const userAEmail = `alex.${runId}@example.com`;
  const userBEmail = `elena.${runId}@example.com`;

  beforeAll(async () => {
    const testEnv = loadAndValidateEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      SUPABASE_JWT_SECRET: 'messiah_test_jwt_secret_minimum_32_characters_long',
    });

    app = await buildApp({ env: testEnv, logger: false });
    await app.ready();

    // Create valid test tokens for User A and User B
    userAToken = await createTestJwt({
      sub: userAExternalId,
      email: userAEmail,
      user_metadata: { full_name: 'Alex Chen', avatar_url: 'https://example.com/avatar1.png' },
    });

    userBToken = await createTestJwt({
      sub: userBExternalId,
      email: userBEmail,
      user_metadata: { full_name: 'Elena Rostova' },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('1. Token Verification & Authentication Gates', () => {
    it('should reject requests with missing Authorization header (401)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
      });

      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('UNAUTHENTICATED');
    });

    it('should reject malformed Authorization headers (401)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: {
          authorization: 'NotBearer xyz',
        },
      });

      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error.code).toBe('UNAUTHENTICATED');
    });

    it('should reject invalid or tampered JWT signatures (401)', async () => {
      const tamperedToken = userAToken + 'tampered';
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: {
          authorization: `Bearer ${tamperedToken}`,
        },
      });

      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error.code).toBe('INVALID_TOKEN');
    });

    it('should reject expired tokens with TOKEN_EXPIRED error code (401)', async () => {
      // Past epoch timestamp (expired)
      const expiredToken = await createTestJwt({
        sub: 'supabase-test-user-expired',
        email: 'expired@example.com',
        exp: Math.floor(Date.now() / 1000) - 3600,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: {
          authorization: `Bearer ${expiredToken}`,
        },
      });

      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error.code).toBe('TOKEN_EXPIRED');
    });

    it('should reject tokens signed with an untrusted key (401)', async () => {
      const rogueSecret = new TextEncoder().encode('untrusted_rogue_secret_32_characters_long');
      const rogueToken = await new jose.SignJWT({
        sub: 'rogue-user',
        email: 'rogue@example.com',
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setExpirationTime('1h')
        .sign(rogueSecret);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: {
          authorization: `Bearer ${rogueToken}`,
        },
      });

      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error.code).toBe('INVALID_TOKEN');
    });
  });

  describe('2. User Resolution & Profile API (GET/PATCH /api/v1/me)', () => {
    it('should resolve or create user and initial personal workspace on first valid auth', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: {
          authorization: `Bearer ${userAToken}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.email).toBe(userAEmail);
      expect(body.data.fullName).toBe('Alex Chen');
      expect(body.data.externalId).toBe(userAExternalId);
      expect(body.data.memberships.length).toBeGreaterThanOrEqual(1);

      const defaultWorkspace = body.data.memberships[0];
      expect(defaultWorkspace.role).toBe('OWNER');
      expect(defaultWorkspace.workspaceName).toContain('Alex Chen');
      userAWorkspaceId = defaultWorkspace.workspaceId;
    });

    it('should be idempotent: repeated auth requests do not duplicate workspaces', async () => {
      const res1 = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { authorization: `Bearer ${userAToken}` },
      });
      const res2 = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { authorization: `Bearer ${userAToken}` },
      });

      expect(res1.statusCode).toBe(200);
      expect(res2.statusCode).toBe(200);
      expect(res1.json().data.memberships.length).toBe(res2.json().data.memberships.length);
    });

    it('PATCH /api/v1/me should validate and update user display name', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/me',
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          fullName: 'Alexander Chen, Ph.D.',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.fullName).toBe('Alexander Chen, Ph.D.');
    });

    it('PATCH /api/v1/me should reject invalid avatar URL format (422)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/me',
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          avatarUrl: 'not-a-valid-url',
        },
      });

      expect(res.statusCode).toBe(422);
      const body = res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('3. Workspaces Management & Tenancy Isolation', () => {
    it('GET /api/v1/workspaces should return workspaces accessible to the user', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/workspaces',
        headers: { authorization: `Bearer ${userAToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.some((w: { id: string }) => w.id === userAWorkspaceId)).toBe(true);
    });

    it('POST /api/v1/workspaces should create a new workspace with user as OWNER', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/workspaces',
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          name: 'Quantum Agent Lab',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data.name).toBe('Quantum Agent Lab');
      expect(body.data.role).toBe('OWNER');
      expect(body.data.slug).toContain('quantum-agent-lab');
    });

    it('POST /api/v1/workspaces should reject invalid workspace names (422)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/workspaces',
        headers: { authorization: `Bearer ${userAToken}` },
        payload: {
          name: 'x', // too short (< 2 chars)
        },
      });

      expect(res.statusCode).toBe(422);
      const body = res.json();
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('GET /api/v1/workspaces/:workspaceId should return workspace for authorized member', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/workspaces/${userAWorkspaceId}`,
        headers: { authorization: `Bearer ${userAToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.id).toBe(userAWorkspaceId);
      expect(body.data.role).toBe('OWNER');
    });

    it('Cross-User Data Isolation: User B cannot access User A private workspace (404/IDOR Protection)', async () => {
      // User B authenticates for the first time
      await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { authorization: `Bearer ${userBToken}` },
      });

      // User B attempts to access User A's workspace ID
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/workspaces/${userAWorkspaceId}`,
        headers: { authorization: `Bearer ${userBToken}` },
      });

      // Must return 404 to avoid leaking existence of private workspace (preventing IDOR)
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error.code).toBe('WORKSPACE_NOT_FOUND');
    });
  });
});
