import type { FastifyPluginAsync } from 'fastify';
import { CreateWorkspaceSchema, type ApiResponse, type WorkspaceInfo } from '@messiah/shared';
import { workspaceService } from '../../../services/workspaceService.js';

export const workspaceRoutes: FastifyPluginAsync = async (fastify) => {
  // Pre-handler hook enforcing authentication across all workspace routes
  fastify.addHook('preHandler', fastify.authenticate);

  /**
   * GET /api/v1/workspaces
   * Returns all workspaces accessible to the authenticated user.
   */
  fastify.get('/api/v1/workspaces', async (request, reply) => {
    const workspaces = await workspaceService.getAccessibleWorkspaces(request.user.id);

    const response: ApiResponse<WorkspaceInfo[]> = {
      success: true,
      data: workspaces,
      meta: { timestamp: new Date().toISOString() },
    };

    return reply.status(200).send(response);
  });

  /**
   * POST /api/v1/workspaces
   * Creates a new workspace with the authenticated user as OWNER.
   */
  fastify.post('/api/v1/workspaces', async (request, reply) => {
    const parseResult = CreateWorkspaceSchema.safeParse(request.body);

    if (!parseResult.success) {
      reply.status(422).send({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid workspace parameters.',
          details: parseResult.error.format(),
        },
        meta: { timestamp: new Date().toISOString() },
      });
      return;
    }

    const createdWorkspace = await workspaceService.createWorkspace(request.user.id, parseResult.data);

    const response: ApiResponse<WorkspaceInfo> = {
      success: true,
      data: createdWorkspace,
      meta: { timestamp: new Date().toISOString() },
    };

    return reply.status(201).send(response);
  });

  /**
   * GET /api/v1/workspaces/:workspaceId
   * Retrieves a specific workspace only after validating that the user is an authorized member.
   * Protects against IDOR (Insecure Direct Object Reference).
   */
  fastify.get<{ Params: { workspaceId: string } }>(
    '/api/v1/workspaces/:workspaceId',
    async (request, reply) => {
      const { workspaceId } = request.params;

      if (!workspaceId || workspaceId.length < 10) {
        reply.status(422).send({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid workspace identifier format.',
          },
          meta: { timestamp: new Date().toISOString() },
        });
        return;
      }

      const workspace = await workspaceService.getWorkspaceById(request.user.id, workspaceId);

      if (!workspace) {
        reply.status(404).send({
          success: false,
          error: {
            code: 'WORKSPACE_NOT_FOUND',
            message: 'Workspace not found or access denied.',
          },
          meta: { timestamp: new Date().toISOString() },
        });
        return;
      }

      const response: ApiResponse<WorkspaceInfo> = {
        success: true,
        data: workspace,
        meta: { timestamp: new Date().toISOString() },
      };

      return reply.status(200).send(response);
    }
  );
};
