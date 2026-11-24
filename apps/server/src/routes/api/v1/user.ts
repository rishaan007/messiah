import type { FastifyPluginAsync } from 'fastify';
import { UpdateProfileSchema, type ApiResponse, type UserProfile } from '@messiah/shared';
import { userService } from '../../../services/userService.js';

export const userRoutes: FastifyPluginAsync = async (fastify) => {
  // Pre-handler hook enforcing authentication across all user routes
  fastify.addHook('preHandler', fastify.authenticate);

  /**
   * GET /api/v1/me
   * Retrieves the currently authenticated user's profile and workspace memberships.
   */
  fastify.get('/api/v1/me', async (request, reply) => {
    const profile = await userService.getUserProfile(request.user.id);

    if (!profile) {
      reply.status(404).send({
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: 'User profile not found.',
        },
        meta: { timestamp: new Date().toISOString() },
      });
      return;
    }

    const response: ApiResponse<UserProfile> = {
      success: true,
      data: profile,
      meta: { timestamp: new Date().toISOString() },
    };

    return reply.status(200).send(response);
  });

  /**
   * PATCH /api/v1/me
   * Updates display name or avatar URL for the authenticated user.
   */
  fastify.patch('/api/v1/me', async (request, reply) => {
    const parseResult = UpdateProfileSchema.safeParse(request.body);

    if (!parseResult.success) {
      reply.status(422).send({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid profile update parameters.',
          details: parseResult.error.format(),
        },
        meta: { timestamp: new Date().toISOString() },
      });
      return;
    }

    const updatedProfile = await userService.updateUserProfile(request.user.id, parseResult.data);

    const response: ApiResponse<UserProfile> = {
      success: true,
      data: updatedProfile,
      meta: { timestamp: new Date().toISOString() },
    };

    return reply.status(200).send(response);
  });
};
