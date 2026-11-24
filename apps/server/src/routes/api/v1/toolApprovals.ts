import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { toolApprovalService } from "../../../services/tools/toolApprovalService.js";
import { workspaceService } from "../../../services/workspaceService.js";

const WorkspaceQuerySchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID format"),
});

const ApprovalParamsSchema = z.object({
  id: z.string().uuid("Invalid approval ID format"),
});

const ApproveBodySchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID format"),
  toolCallId: z.string().uuid().optional(),
  generationRunId: z.string().uuid().optional(),
  threadId: z.string().uuid().optional(),
  connectionId: z.string().uuid().optional(),
  toolDefinitionId: z.string().uuid().optional(),
  toolName: z.string().optional(),
  schemaHash: z.string().optional(),
  argumentsHash: z.string().optional(),
});

const DenyBodySchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID format"),
  reason: z.string().max(1000).optional(),
  toolCallId: z.string().uuid().optional(),
  generationRunId: z.string().uuid().optional(),
  threadId: z.string().uuid().optional(),
  connectionId: z.string().uuid().optional(),
  toolDefinitionId: z.string().uuid().optional(),
  toolName: z.string().optional(),
  schemaHash: z.string().optional(),
  argumentsHash: z.string().optional(),
});

export const toolApprovalRoutes: FastifyPluginAsync = async (fastify) => {
  // Enforce authentication across all tool approval routes
  fastify.addHook("preHandler", fastify.authenticate);

  /**
   * GET /api/v1/tool-approvals?workspaceId=...
   * Lists pending tool approvals for the workspace.
   */
  fastify.get<{
    Querystring: { workspaceId?: string };
  }>("/tool-approvals", async (request, reply) => {
    const parseResult = WorkspaceQuerySchema.safeParse(request.query);
    if (!parseResult.success) {
      return reply.code(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Query parameter 'workspaceId' must be a valid UUID.",
          details: parseResult.error.format(),
        },
      });
    }

    const { workspaceId } = parseResult.data;
    const approvals = await toolApprovalService.getPendingApprovals(workspaceId, request.user.id);

    return reply.send({
      success: true,
      data: approvals,
      meta: { timestamp: new Date().toISOString() },
    });
  });

  /**
   * GET /api/v1/tool-approvals/:id?workspaceId=...
   * Retrieves specific tool approval.
   */
  fastify.get<{
    Params: { id: string };
    Querystring: { workspaceId?: string };
  }>("/tool-approvals/:id", async (request, reply) => {
    const paramsResult = ApprovalParamsSchema.safeParse(request.params);
    const queryResult = WorkspaceQuerySchema.safeParse(request.query);

    if (!paramsResult.success || !queryResult.success) {
      return reply.code(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Approval ID and workspaceId query parameter must be valid UUIDs.",
        },
      });
    }

    const approval = await toolApprovalService.getApprovalById(
      paramsResult.data.id,
      queryResult.data.workspaceId,
      request.user.id
    );

    return reply.send({
      success: true,
      data: approval,
      meta: { timestamp: new Date().toISOString() },
    });
  });

  /**
   * POST /api/v1/tool-approvals/:id/approve
   * Approves a pending tool call and resumes generation.
   */
  fastify.post<{
    Params: { id: string };
    Body: unknown;
  }>("/tool-approvals/:id/approve", async (request, reply) => {
    const paramsResult = ApprovalParamsSchema.safeParse(request.params);
    const bodyResult = ApproveBodySchema.safeParse(request.body);

    if (!paramsResult.success || !bodyResult.success) {
      return reply.code(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid approval ID or request payload.",
        },
      });
    }

    const { id } = paramsResult.data;
    const { workspaceId, ...context } = bodyResult.data;

    const role = await workspaceService.getWorkspaceMembership(request.user.id, workspaceId);
    if (!role) {
      return reply.code(404).send({
        success: false,
        error: {
          code: "WORKSPACE_NOT_FOUND",
          message: "Workspace not found or access denied.",
        },
      });
    }

    const updated = await toolApprovalService.approve(id, request.user.id, role, {
      workspaceId,
      ...context,
    });

    return reply.send({
      success: true,
      data: updated,
      meta: { timestamp: new Date().toISOString() },
    });
  });

  /**
   * POST /api/v1/tool-approvals/:id/deny
   * Denies a pending tool call with an optional rejection reason.
   */
  fastify.post<{
    Params: { id: string };
    Body: unknown;
  }>("/tool-approvals/:id/deny", async (request, reply) => {
    const paramsResult = ApprovalParamsSchema.safeParse(request.params);
    const bodyResult = DenyBodySchema.safeParse(request.body);

    if (!paramsResult.success || !bodyResult.success) {
      return reply.code(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid approval ID or request payload.",
        },
      });
    }

    const { id } = paramsResult.data;
    const { workspaceId, reason, ...context } = bodyResult.data;

    const role = await workspaceService.getWorkspaceMembership(request.user.id, workspaceId);
    if (!role) {
      return reply.code(404).send({
        success: false,
        error: {
          code: "WORKSPACE_NOT_FOUND",
          message: "Workspace not found or access denied.",
        },
      });
    }

    const updated = await toolApprovalService.deny(id, request.user.id, role, reason, {
      workspaceId,
      ...context,
    });

    return reply.send({
      success: true,
      data: updated,
      meta: { timestamp: new Date().toISOString() },
    });
  });
};
