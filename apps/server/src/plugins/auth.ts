import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import * as jose from 'jose';
import type { AuthUserContext } from '@messiah/shared';
import { userService } from '../services/userService.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUserContext;
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export interface AuthPluginOptions {
  supabaseUrl?: string;
  supabaseJwtSecret?: string;
  isTestEnv?: boolean;
}

const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (fastify, opts) => {
  // Remote JWKS set for Supabase Auth asymmetric keys
  const remoteJwks = opts.supabaseUrl
    ? jose.createRemoteJWKSet(new URL(`${opts.supabaseUrl}/auth/v1/.well-known/jwks.json`))
    : null;

  // Symmetric secret fallback (Supabase legacy/standard HMAC secret or test secret)
  const defaultSecret = opts.isTestEnv ? 'messiah_test_jwt_secret_minimum_32_characters_long' : undefined;
  const symmetricSecret = opts.supabaseJwtSecret || defaultSecret;
  const secretKey = symmetricSecret ? new TextEncoder().encode(symmetricSecret) : null;

  const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      reply.status(401).send({
        success: false,
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Missing or malformed Authorization header. Expected Bearer token.',
        },
        meta: { timestamp: new Date().toISOString() },
      });
      return;
    }

    const token = authHeader.substring(7).trim();
    if (!token) {
      reply.status(401).send({
        success: false,
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Bearer token is empty.',
        },
        meta: { timestamp: new Date().toISOString() },
      });
      return;
    }

    let payload: jose.JWTPayload;

    try {
      // 1. Verify cryptographic signature and claims
      if (secretKey) {
        // Symmetric verification
        const result = await jose.jwtVerify(token, secretKey, {
          // Audience or issuer checks if configured
        });
        payload = result.payload;
      } else if (remoteJwks) {
        // Asymmetric JWKS verification against Supabase endpoint
        const result = await jose.jwtVerify(token, remoteJwks);
        payload = result.payload;
      } else {
        // No verification key configured
        fastify.log.error('Authentication configuration missing: Neither SUPABASE_JWT_SECRET nor SUPABASE_URL configured');
        reply.status(500).send({
          success: false,
          error: {
            code: 'AUTH_CONFIG_ERROR',
            message: 'Authentication provider verification is not configured on this server.',
          },
          meta: { timestamp: new Date().toISOString() },
        });
        return;
      }

      // 2. Validate essential claims
      if (!payload.sub) {
        reply.status(401).send({
          success: false,
          error: {
            code: 'INVALID_TOKEN',
            message: 'Token claims missing subject identifier (sub).',
          },
          meta: { timestamp: new Date().toISOString() },
        });
        return;
      }

      const externalId = payload.sub;
      const email = (payload['email'] as string) || (payload['user_metadata'] as Record<string, unknown>)?.['email'] as string;

      if (!email) {
        reply.status(401).send({
          success: false,
          error: {
            code: 'INVALID_TOKEN',
            message: 'Token claims missing user email.',
          },
          meta: { timestamp: new Date().toISOString() },
        });
        return;
      }

      const userMetadata = (payload['user_metadata'] as Record<string, unknown>) || {};
      const fullName = (userMetadata['full_name'] as string) || (payload['name'] as string) || null;
      const avatarUrl = (userMetadata['avatar_url'] as string) || (payload['picture'] as string) || null;

      // 3. Resolve or create internal Messiah user and personal workspace
      const userContext = await userService.findOrCreateUserFromAuth({
        externalId,
        email,
        fullName,
        avatarUrl,
        externalProvider: 'supabase',
      });

      // 4. Attach authenticated user context to request
      request.user = userContext;
    } catch (err: unknown) {
      const error = err as Error;
      fastify.log.warn({ err: error.message }, 'JWT verification failed');

      const isExpired = error.name === 'JWTExpired';
      reply.status(401).send({
        success: false,
        error: {
          code: isExpired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
          message: isExpired ? 'Authentication token has expired. Please refresh session.' : 'Invalid or untrusted authentication token.',
        },
        meta: { timestamp: new Date().toISOString() },
      });
      return;
    }
  };

  fastify.decorate('authenticate', authenticate);
};

export default fp(authPlugin, {
  name: 'auth-plugin',
});
