import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  CreateWorkflowSchema,
  PublishWorkflowSchema,
  ToggleWorkflowScheduleSchema,
  TriggerWorkflowRunSchema,
  UpdateWorkflowSchema,
  ValidateWorkflowGraphSchema,
  WorkflowApprovalDecisionSchema,
} from "@messiah/shared";
import { WorkflowServiceError, workflowService } from "../../../services/workflows/index.js";

const WorkspaceQuerySchema = z.object({
  workspaceId: z.string().uuid("Invalid workspace ID"),
  workflowId: z.string().uuid().optional(),
});

const WorkflowParamsSchema = z.object({
  workflowId: z.string().uuid("Invalid workflow ID"),
});

const RunParamsSchema = z.object({
  runId: z.string().uuid("Invalid workflow run ID"),
});

const ApprovalParamsSchema = z.object({
  approvalId: z.string().uuid("Invalid approval ID"),
});

export const workflowRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", fastify.authenticate);

  const handleError = (err: unknown, reply: any) => {
    if (err instanceof WorkflowServiceError) {
      return reply.code(err.statusCode).send({
        success: false,
        error: { code: err.code, message: err.message, details: err.details },
        meta: { timestamp: new Date().toISOString() },
      });
    }
    throw err;
  };

  /**
   * GET /api/v1/workflows?workspaceId=...
   */
  fastify.get("/workflows", async (request, reply) => {
    const query = WorkspaceQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Valid workspaceId required." },
      });
    }

    try {
      const items = await workflowService.listWorkflows(query.data.workspaceId, request.user.id);
      return reply.code(200).send({
        success: true,
        data: items,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * POST /api/v1/workflows
   */
  fastify.post("/workflows", async (request, reply) => {
    const body = CreateWorkflowSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid workflow definition payload.",
          details: body.error.format(),
        },
      });
    }

    try {
      const created = await workflowService.createWorkflow(request.user.id, body.data);
      return reply.code(201).send({
        success: true,
        data: created,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * POST /api/v1/workflows/validate
   */
  fastify.post("/workflows/validate", async (request, reply) => {
    const body = ValidateWorkflowGraphSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid workflow graph structure.",
          details: body.error.format(),
        },
      });
    }

    const result = workflowService.validateGraph(body.data.graph);
    return reply.code(200).send({
      success: true,
      data: result,
      meta: { timestamp: new Date().toISOString() },
    });
  });

  /**
   * POST /api/v1/workflows/templates/seed
   */
  fastify.post("/workflows/templates/seed", async (request, reply) => {
    const body = WorkspaceQuerySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Valid workspaceId required." },
      });
    }

    try {
      const result = await workflowService.seedStarterTemplates(
        body.data.workspaceId,
        request.user.id
      );
      return reply.code(201).send({
        success: true,
        data: result,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * GET /api/v1/workflows/runs?workspaceId=...
   */
  fastify.get("/workflows/runs", async (request, reply) => {
    const query = WorkspaceQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Valid workspaceId required." },
      });
    }

    try {
      const runs = await workflowService.listRuns({
        workspaceId: query.data.workspaceId,
        userId: request.user.id,
        workflowId: query.data.workflowId,
      });
      return reply.code(200).send({
        success: true,
        data: runs,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * GET /api/v1/workflows/runs/:runId?workspaceId=...
   */
  fastify.get("/workflows/runs/:runId", async (request, reply) => {
    const params = RunParamsSchema.safeParse(request.params);
    const query = WorkspaceQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Valid runId and workspaceId required." },
      });
    }

    try {
      const detail = await workflowService.getRunDetail(
        params.data.runId,
        query.data.workspaceId,
        request.user.id
      );
      return reply.code(200).send({
        success: true,
        data: detail,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * POST /api/v1/workflows/runs/:runId/cancel?workspaceId=...
   */
  fastify.post("/workflows/runs/:runId/cancel", async (request, reply) => {
    const params = RunParamsSchema.safeParse(request.params);
    const bodyOrQuery = WorkspaceQuerySchema.safeParse(request.body || request.query);
    if (!params.success || !bodyOrQuery.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Valid runId and workspaceId required." },
      });
    }

    try {
      const run = await workflowService.cancelRun(
        params.data.runId,
        bodyOrQuery.data.workspaceId,
        request.user.id
      );
      return reply.code(200).send({
        success: true,
        data: run,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * POST /api/v1/workflows/approvals/:approvalId/approve
   */
  fastify.post("/workflows/approvals/:approvalId/approve", async (request, reply) => {
    const params = ApprovalParamsSchema.safeParse(request.params);
    const body = WorkflowApprovalDecisionSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Valid approvalId and workspaceId required." },
      });
    }

    try {
      const run = await workflowService.decideApproval({
        approvalId: params.data.approvalId,
        workspaceId: body.data.workspaceId,
        userId: request.user.id,
        decision: "APPROVED",
      });
      return reply.code(200).send({
        success: true,
        data: run,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * POST /api/v1/workflows/approvals/:approvalId/reject
   */
  fastify.post("/workflows/approvals/:approvalId/reject", async (request, reply) => {
    const params = ApprovalParamsSchema.safeParse(request.params);
    const body = WorkflowApprovalDecisionSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Valid approvalId and workspaceId required." },
      });
    }

    try {
      const run = await workflowService.decideApproval({
        approvalId: params.data.approvalId,
        workspaceId: body.data.workspaceId,
        userId: request.user.id,
        decision: "DENIED",
        reason: body.data.reason,
      });
      return reply.code(200).send({
        success: true,
        data: run,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * GET /api/v1/workflows/:workflowId?workspaceId=...
   */
  fastify.get("/workflows/:workflowId", async (request, reply) => {
    const params = WorkflowParamsSchema.safeParse(request.params);
    const query = WorkspaceQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Valid workflowId and workspaceId required." },
      });
    }

    try {
      const wf = await workflowService.getWorkflow(
        params.data.workflowId,
        query.data.workspaceId,
        request.user.id
      );
      return reply.code(200).send({
        success: true,
        data: wf,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * PATCH /api/v1/workflows/:workflowId
   */
  fastify.patch("/workflows/:workflowId", async (request, reply) => {
    const params = WorkflowParamsSchema.safeParse(request.params);
    const body = UpdateWorkflowSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid workflow update parameters.",
          details: !body.success ? body.error.format() : undefined,
        },
      });
    }

    try {
      const updated = await workflowService.updateWorkflow(
        params.data.workflowId,
        request.user.id,
        body.data
      );
      return reply.code(200).send({
        success: true,
        data: updated,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * DELETE /api/v1/workflows/:workflowId?workspaceId=...
   */
  fastify.delete("/workflows/:workflowId", async (request, reply) => {
    const params = WorkflowParamsSchema.safeParse(request.params);
    const query = WorkspaceQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Valid workflowId and workspaceId required." },
      });
    }

    try {
      await workflowService.deleteWorkflow(
        params.data.workflowId,
        query.data.workspaceId,
        request.user.id
      );
      return reply.code(200).send({
        success: true,
        data: { deleted: true },
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * POST /api/v1/workflows/:workflowId/publish
   */
  fastify.post("/workflows/:workflowId/publish", async (request, reply) => {
    const params = WorkflowParamsSchema.safeParse(request.params);
    const body = PublishWorkflowSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Invalid workflow publish payload." },
      });
    }

    try {
      const wf = await workflowService.publishWorkflow(
        params.data.workflowId,
        request.user.id,
        body.data
      );
      return reply.code(200).send({
        success: true,
        data: wf,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * POST /api/v1/workflows/:workflowId/schedule/toggle
   */
  fastify.post("/workflows/:workflowId/schedule/toggle", async (request, reply) => {
    const params = WorkflowParamsSchema.safeParse(request.params);
    const body = ToggleWorkflowScheduleSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(422).send({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Invalid schedule toggle payload." },
      });
    }

    try {
      const wf = await workflowService.toggleSchedule(
        params.data.workflowId,
        request.user.id,
        body.data
      );
      return reply.code(200).send({
        success: true,
        data: wf,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /**
   * POST /api/v1/workflows/:workflowId/run
   */
  fastify.post("/workflows/:workflowId/run", async (request, reply) => {
    const params = WorkflowParamsSchema.safeParse(request.params);
    const body = TriggerWorkflowRunSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(422).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid workflow trigger parameters.",
          details: !body.success ? body.error.format() : undefined,
        },
      });
    }

    try {
      const run = await workflowService.triggerManualRun(
        params.data.workflowId,
        request.user.id,
        body.data
      );
      return reply.code(201).send({
        success: true,
        data: run,
        meta: { timestamp: new Date().toISOString() },
      });
    } catch (err) {
      return handleError(err, reply);
    }
  });
};
