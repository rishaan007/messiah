import {
  prisma,
  type ToolApproval,
  type ToolCall,
  type WorkspaceRole,
} from "@messiah/db";
import { computeArgumentsHash, computeSchemaHash } from "@messiah/mcp";
import { streamPublisher } from "../chat/streamPublisher.js";
import { chatQueueManager, type GenerationJobPayload } from "../chat/chatQueue.js";
import { logAuditEvent } from "../auditService.js";
import { workspaceService } from "../workspaceService.js";

export class ToolApprovalServiceError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode = 400, code = "TOOL_APPROVAL_ERROR") {
    super(message);
    this.name = "ToolApprovalServiceError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface ApprovalVerificationContext {
  toolCallId?: string;
  generationRunId?: string;
  threadId?: string;
  workspaceId?: string;
  connectionId?: string;
  toolDefinitionId?: string;
  toolName?: string;
  schemaHash?: string;
  argumentsHash?: string;
}

export interface RequestApprovalParams {
  generationRunId: string;
  threadId: string;
  workspaceId: string;
  toolDefinitionId: string;
  connectionId: string;
  providerCallId: string;
  providerToolAlias: string;
  toolName: string;
  schemaHash: string;
  arguments: Record<string, unknown>;
  requestedByUserId?: string;
}

export class ToolApprovalService {
  /**
   * 5-minute approval TTL in milliseconds.
   */
  public static readonly APPROVAL_TTL_MS = 5 * 60 * 1000;

  /**
   * Sanitizes preview arguments to ensure no raw passwords, keys, or tokens leak into UI previews.
   */
  private sanitizeArgumentsPreview(args: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    const SENSITIVE_KEY_PATTERN = /(password|secret|token|api_key|credential|private_key|auth)/i;

    for (const [key, value] of Object.entries(args)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        sanitized[key] = "[REDACTED]";
      } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        sanitized[key] = this.sanitizeArgumentsPreview(value as Record<string, unknown>);
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  /**
   * Creates a ToolCall and associated ToolApproval in AWAITING_APPROVAL/PENDING status,
   * transitions the GenerationRun, and emits a real-time event.
   */
  public async requestApproval(
    params: RequestApprovalParams
  ): Promise<{ toolCall: ToolCall; toolApproval: ToolApproval }> {
    const argumentsHash = computeArgumentsHash(params.arguments);
    const schemaHash = params.schemaHash || computeSchemaHash({});
    const expiresAt = new Date(Date.now() + ToolApprovalService.APPROVAL_TTL_MS);
    const argumentsPreview = this.sanitizeArgumentsPreview(params.arguments);

    const result = await prisma.$transaction(async (tx) => {
      // 1. Create or update ToolCall record
      const toolCall = await tx.toolCall.create({
        data: {
          generationRunId: params.generationRunId,
          threadId: params.threadId,
          workspaceId: params.workspaceId,
          toolDefinitionId: params.toolDefinitionId,
          connectionId: params.connectionId,
          providerCallId: params.providerCallId,
          providerToolAlias: params.providerToolAlias,
          toolName: params.toolName,
          schemaHash,
          argumentsHash,
          argumentsPreview: argumentsPreview as any,
          status: "AWAITING_APPROVAL",
        },
      });

      // 2. Create ToolApproval bound to the ToolCall
      const toolApproval = await tx.toolApproval.create({
        data: {
          toolCallId: toolCall.id,
          workspaceId: params.workspaceId,
          requestedByUserId: params.requestedByUserId || null,
          status: "PENDING",
          argumentsHash,
          schemaHash,
          expiresAt,
        },
      });

      // 3. Mark the generation run as AWAITING_APPROVAL
      await tx.generationRun.update({
        where: { id: params.generationRunId },
        data: {
          status: "AWAITING_APPROVAL",
        },
      });

      return { toolCall, toolApproval };
    });

    // 4. Publish real-time event for connected clients
    await streamPublisher.publish({
      type: "tool.approval_requested",
      threadId: params.threadId,
      runId: params.generationRunId,
      messageId: params.providerCallId,
      sequence: 0,
      timestamp: new Date().toISOString(),
      payload: {
        toolCall: {
          id: result.toolCall.id,
          providerCallId: result.toolCall.providerCallId,
          toolName: result.toolCall.toolName,
          providerToolAlias: result.toolCall.providerToolAlias,
          argumentsPreview: result.toolCall.argumentsPreview as Record<string, unknown>,
          status: result.toolCall.status,
          createdAt: result.toolCall.createdAt.toISOString(),
          updatedAt: result.toolCall.updatedAt.toISOString(),
        },
        toolApproval: {
          id: result.toolApproval.id,
          toolCallId: result.toolApproval.toolCallId,
          workspaceId: result.toolApproval.workspaceId,
          requestedByUserId: result.toolApproval.requestedByUserId,
          status: result.toolApproval.status,
          expiresAt: result.toolApproval.expiresAt.toISOString(),
          createdAt: result.toolApproval.createdAt.toISOString(),
          updatedAt: result.toolApproval.updatedAt.toISOString(),
        },
      },
    });

    // 5. Audit logging
    await logAuditEvent({
      actorId: params.requestedByUserId || undefined,
      workspaceId: params.workspaceId,
      action: "tool_approval_requested",
      resourceType: "tool_approval",
      resourceId: result.toolApproval.id,
      details: {
        toolName: params.toolName,
        toolCallId: result.toolCall.id,
        runId: params.generationRunId,
        expiresAt: expiresAt.toISOString(),
      },
    });

    return result;
  }

  /**
   * Approves a pending tool call in a single atomic transaction:
   * 1. Validates pending approval, status, and role authorization (OWNER or ADMIN only).
   * 2. Verifies cryptographic schema and arguments hashes match tool call.
   * 3. Verifies context bindings (toolCallId, runId, threadId, connectionId, toolName, etc.).
   * 4. Marks approval as consumed (APPROVED).
   * 5. Transitions tool call to APPROVED and generation run to PENDING.
   * 6. Writes a durable OutboxEvent (generation.resume) for at-least-once BullMQ resumption.
   */
  public async approve(
    approvalId: string,
    decidedByUserId: string,
    workspaceRole: WorkspaceRole,
    context?: ApprovalVerificationContext
  ): Promise<ToolApproval> {
    if (workspaceRole !== "OWNER" && workspaceRole !== "ADMIN") {
      throw new ToolApprovalServiceError(
        "Only workspace OWNER or ADMIN roles are permitted to approve tool executions.",
        403,
        "FORBIDDEN_ROLE"
      );
    }

    // Atomic transaction executing all validations, state changes, and durable outbox insertion
    const txResult = await prisma.$transaction(async (tx) => {
      const approval = await tx.toolApproval.findUnique({
        where: { id: approvalId },
        include: {
          toolCall: {
            include: {
              generationRun: {
                include: {
                  thread: true,
                },
              },
              connection: true,
              toolDefinition: true,
            },
          },
        },
      });

      if (!approval) {
        throw new ToolApprovalServiceError("Tool approval request not found.", 404, "NOT_FOUND");
      }

      if (approval.status !== "PENDING") {
        throw new ToolApprovalServiceError(
          `Tool approval request is already ${approval.status}.`,
          400,
          "ALREADY_DECIDED"
        );
      }

      const toolCall = approval.toolCall;
      if (!toolCall) {
        throw new ToolApprovalServiceError("Associated tool call not found.", 404, "NOT_FOUND");
      }

      if (toolCall.status !== "AWAITING_APPROVAL") {
        throw new ToolApprovalServiceError(
          `Associated tool call is not awaiting approval (current status: ${toolCall.status}).`,
          400,
          "INVALID_TOOL_CALL_STATE"
        );
      }

      // Check expiration (5-minute TTL)
      if (Date.now() > approval.expiresAt.getTime()) {
        // Must persist EXPIRED status immediately
        await prisma.$transaction([
          prisma.toolApproval.update({
            where: { id: approvalId },
            data: { status: "EXPIRED" },
          }),
          prisma.toolCall.update({
            where: { id: toolCall.id },
            data: { status: "EXPIRED" },
          }),
        ]);
        throw new ToolApprovalServiceError(
          "Tool approval request has expired (5-minute TTL).",
          400,
          "APPROVAL_EXPIRED"
        );
      }

      // Cryptographic hash consistency validation between approval and tool call
      if (approval.schemaHash !== toolCall.schemaHash) {
        throw new ToolApprovalServiceError(
          "Schema hash mismatch between approval record and tool call.",
          400,
          "HASH_MISMATCH"
        );
      }
      if (approval.argumentsHash !== toolCall.argumentsHash) {
        throw new ToolApprovalServiceError(
          "Arguments hash mismatch between approval record and tool call.",
          400,
          "HASH_MISMATCH"
        );
      }

      // Strict context binding checks if caller provided verification parameters
      if (context) {
        if (context.toolCallId && toolCall.id !== context.toolCallId) {
          throw new ToolApprovalServiceError("Tool call ID binding mismatch.", 400, "BINDING_MISMATCH");
        }
        if (context.generationRunId && toolCall.generationRunId !== context.generationRunId) {
          throw new ToolApprovalServiceError("Generation run ID binding mismatch.", 400, "BINDING_MISMATCH");
        }
        if (context.threadId && toolCall.threadId !== context.threadId) {
          throw new ToolApprovalServiceError("Thread ID binding mismatch.", 400, "BINDING_MISMATCH");
        }
        if (context.workspaceId && approval.workspaceId !== context.workspaceId) {
          throw new ToolApprovalServiceError("Workspace ID binding mismatch.", 400, "BINDING_MISMATCH");
        }
        if (context.connectionId && toolCall.connectionId !== context.connectionId) {
          throw new ToolApprovalServiceError("Connection ID binding mismatch.", 400, "BINDING_MISMATCH");
        }
        if (context.toolDefinitionId && toolCall.toolDefinitionId !== context.toolDefinitionId) {
          throw new ToolApprovalServiceError("Tool definition ID binding mismatch.", 400, "BINDING_MISMATCH");
        }
        if (context.toolName && toolCall.toolName !== context.toolName) {
          throw new ToolApprovalServiceError("Tool name binding mismatch.", 400, "BINDING_MISMATCH");
        }
        if (
          context.schemaHash &&
          (approval.schemaHash !== context.schemaHash || toolCall.schemaHash !== context.schemaHash)
        ) {
          throw new ToolApprovalServiceError("Schema hash binding mismatch.", 400, "BINDING_MISMATCH");
        }
        if (
          context.argumentsHash &&
          (approval.argumentsHash !== context.argumentsHash || toolCall.argumentsHash !== context.argumentsHash)
        ) {
          throw new ToolApprovalServiceError("Arguments hash binding mismatch.", 400, "BINDING_MISMATCH");
        }
      }

      // Re-verify underlying MCP connection status
      if (toolCall.connection && toolCall.connection.status !== "CONNECTED") {
        throw new ToolApprovalServiceError(
          `Underlying MCP connection is not connected (current status: ${toolCall.connection.status}).`,
          400,
          "CONNECTION_NOT_CONNECTED"
        );
      }

      // Re-verify tool permission mode has not been set to DISABLED
      const permission = await tx.mcpToolPermission.findUnique({
        where: { toolDefinitionId: toolCall.toolDefinitionId },
      });
      if (permission?.permissionMode === "DISABLED") {
        throw new ToolApprovalServiceError(
          "Tool execution is disabled by workspace administration.",
          400,
          "TOOL_DISABLED"
        );
      }

      const run = toolCall.generationRun;
      const agentRunId = toolCall.agentRunId;
      const thread = run?.thread;

      if (!run && !agentRunId) {
        throw new ToolApprovalServiceError("Tool call is not associated with any active run.", 400, "INVALID_RUN_STATE");
      }

      // 4. Mark approval as consumed with atomic concurrency guard
      const updateCount = await tx.toolApproval.updateMany({
        where: { id: approvalId, status: "PENDING" },
        data: {
          status: "APPROVED",
          decidedByUserId,
          decidedAt: new Date(),
        },
      });

      if (updateCount.count === 0) {
        throw new ToolApprovalServiceError(
          "Tool approval request is already decided or no longer pending.",
          400,
          "ALREADY_DECIDED"
        );
      }

      const updatedApproval = await tx.toolApproval.findUniqueOrThrow({
        where: { id: approvalId },
      });

      // 5. Transition tool call to APPROVED and owning run to PENDING
      const updatedToolCall = await tx.toolCall.update({
        where: { id: toolCall.id },
        data: {
          status: "APPROVED",
        },
      });

      if (run) {
        await tx.generationRun.update({
          where: { id: run.id },
          data: {
            status: "PENDING",
          },
        });

        // 6. Write durable outbox event for resumption
        const jobPayload: GenerationJobPayload = {
          runId: run.id,
          threadId: run.threadId,
          workspaceId: approval.workspaceId,
          userId: thread?.createdByUserId || decidedByUserId,
          userMessageId: "",
          assistantMessageId: run.assistantMessageId,
          providerConnectionId: run.providerConnectionId,
          provider: run.provider,
          modelId: run.modelId,
          content: "",
        };

        const outboxEvent = await tx.outboxEvent.create({
          data: {
            eventType: "generation.resume",
            aggregateType: "GenerationRun",
            aggregateId: run.id,
            payload: jobPayload as any,
            status: "PENDING",
          },
        });

        return {
          approval: updatedApproval,
          toolCall: updatedToolCall,
          run,
          agentRunId: null as string | null,
          outboxEvent,
          jobPayload,
        };
      }

      await tx.agentRun.updateMany({
        where: { id: agentRunId!, status: "AWAITING_APPROVAL" },
        data: { status: "PENDING" },
      });

      const swarmOutbox = await tx.outboxEvent.create({
        data: {
          eventType: "swarm.resume",
          aggregateType: "AgentRun",
          aggregateId: agentRunId!,
          payload: {
            kind: "swarm.execute",
            runId: agentRunId!,
            workspaceId: approval.workspaceId,
            userId: decidedByUserId,
          },
          status: "PENDING",
        },
      });

      return {
        approval: updatedApproval,
        toolCall: updatedToolCall,
        run: null,
        agentRunId: agentRunId!,
        outboxEvent: swarmOutbox,
        jobPayload: null as GenerationJobPayload | null,
      };
    });

    const { approval: updatedApproval, run, agentRunId, outboxEvent, jobPayload } = txResult;

    if (run && jobPayload) {
      // Resumption: Enqueue to BullMQ with deterministic jobId bound to outbox event
      const resumedJobId = `${run.id}-resume-${outboxEvent.id}`;
      chatQueueManager
        .enqueueRun(
          {
            ...jobPayload,
            outboxEventId: outboxEvent.id,
          },
          resumedJobId
        )
        .catch((err) => {
          console.warn(
            `[ToolApprovalService] Immediate enqueue of resumed run ${run.id} deferred to outbox sweeper:`,
            err
          );
        });

      // Publish WebSocket notification
      await streamPublisher.publish({
        type: "tool.approval_decided",
        threadId: txResult.toolCall.threadId || run.threadId,
        runId: run.id,
        messageId: txResult.toolCall.providerCallId,
        sequence: 0,
        timestamp: new Date().toISOString(),
        payload: {
          toolCall: {
            id: txResult.toolCall.id,
            status: "APPROVED",
          },
          toolApproval: {
            id: updatedApproval.id,
            status: "APPROVED",
            decidedByUserId,
            decidedAt: updatedApproval.decidedAt?.toISOString(),
          },
        },
      });
    } else if (agentRunId) {
      chatQueueManager
        .enqueueSwarmRun(
          {
            kind: "swarm.execute",
            runId: agentRunId,
            workspaceId: updatedApproval.workspaceId,
            userId: decidedByUserId,
            outboxEventId: outboxEvent.id,
          },
          `swarm-${agentRunId}-resume-${outboxEvent.id}`
        )
        .catch(() => {});
    }

    // Audit log
    await logAuditEvent({
      actorId: decidedByUserId,
      workspaceId: updatedApproval.workspaceId,
      action: "tool_approval_decided",
      resourceType: "tool_approval",
      resourceId: updatedApproval.id,
      details: {
        decision: "APPROVED",
        toolCallId: txResult.toolCall.id,
        toolName: txResult.toolCall.toolName,
        outboxEventId: outboxEvent.id,
      },
    });

    return updatedApproval;
  }

  /**
   * Denies a pending tool call in a single atomic transaction:
   * 1. Validates pending approval, status, and role authorization (OWNER or ADMIN only).
   * 2. Marks approval as DENIED with explicit denial reason.
   * 3. Transitions tool call to DENIED with error message.
   * 4. Transitions generation run to PENDING to allow assistant to continue with denial outcome.
   * 5. Writes a durable OutboxEvent (generation.resume).
   */
  public async deny(
    approvalId: string,
    decidedByUserId: string,
    workspaceRole: WorkspaceRole,
    reason?: string,
    context?: ApprovalVerificationContext
  ): Promise<ToolApproval> {
    if (workspaceRole !== "OWNER" && workspaceRole !== "ADMIN") {
      throw new ToolApprovalServiceError(
        "Only workspace OWNER or ADMIN roles are permitted to deny or decide tool executions.",
        403,
        "FORBIDDEN_ROLE"
      );
    }

    const denialReason = reason || "Tool execution was explicitly denied by the user.";

    const txResult = await prisma.$transaction(async (tx) => {
      const approval = await tx.toolApproval.findUnique({
        where: { id: approvalId },
        include: {
          toolCall: {
            include: {
              generationRun: {
                include: {
                  thread: true,
                },
              },
            },
          },
        },
      });

      if (!approval) {
        throw new ToolApprovalServiceError("Tool approval request not found.", 404, "NOT_FOUND");
      }

      if (approval.status !== "PENDING") {
        throw new ToolApprovalServiceError(
          `Tool approval request is already ${approval.status}.`,
          400,
          "ALREADY_DECIDED"
        );
      }

      const toolCall = approval.toolCall;
      if (!toolCall) {
        throw new ToolApprovalServiceError("Associated tool call not found.", 404, "NOT_FOUND");
      }

      // Check context bindings if provided
      if (context) {
        if (context.toolCallId && toolCall.id !== context.toolCallId) {
          throw new ToolApprovalServiceError("Tool call ID binding mismatch.", 400, "BINDING_MISMATCH");
        }
        if (context.generationRunId && toolCall.generationRunId !== context.generationRunId) {
          throw new ToolApprovalServiceError("Generation run ID binding mismatch.", 400, "BINDING_MISMATCH");
        }
        if (context.threadId && toolCall.threadId !== context.threadId) {
          throw new ToolApprovalServiceError("Thread ID binding mismatch.", 400, "BINDING_MISMATCH");
        }
        if (context.workspaceId && approval.workspaceId !== context.workspaceId) {
          throw new ToolApprovalServiceError("Workspace ID binding mismatch.", 400, "BINDING_MISMATCH");
        }
      }

      const updateCount = await tx.toolApproval.updateMany({
        where: { id: approvalId, status: "PENDING" },
        data: {
          status: "DENIED",
          decidedByUserId,
          decidedAt: new Date(),
          rejectionReason: denialReason,
        },
      });

      if (updateCount.count === 0) {
        throw new ToolApprovalServiceError(
          "Tool approval request is already decided or no longer pending.",
          400,
          "ALREADY_DECIDED"
        );
      }

      const updatedApproval = await tx.toolApproval.findUniqueOrThrow({
        where: { id: approvalId },
      });

      const updatedToolCall = await tx.toolCall.update({
        where: { id: toolCall.id },
        data: {
          status: "DENIED",
          isError: true,
          errorMessage: denialReason,
        },
      });

      const run = toolCall.generationRun;
      const agentRunId = toolCall.agentRunId;
      const thread = run?.thread;

      if (!run && !agentRunId) {
        throw new ToolApprovalServiceError("Tool call is not associated with any active run.", 400, "INVALID_RUN_STATE");
      }

      if (run) {
        await tx.generationRun.update({
          where: { id: run.id },
          data: {
            status: "PENDING",
          },
        });

        // Write durable outbox event for resumption
        const jobPayload: GenerationJobPayload = {
          runId: run.id,
          threadId: run.threadId,
          workspaceId: approval.workspaceId,
          userId: thread?.createdByUserId || decidedByUserId,
          userMessageId: "",
          assistantMessageId: run.assistantMessageId,
          providerConnectionId: run.providerConnectionId,
          provider: run.provider,
          modelId: run.modelId,
          content: "",
        };

        const outboxEvent = await tx.outboxEvent.create({
          data: {
            eventType: "generation.resume",
            aggregateType: "GenerationRun",
            aggregateId: run.id,
            payload: jobPayload as any,
            status: "PENDING",
          },
        });

        return {
          approval: updatedApproval,
          toolCall: updatedToolCall,
          run,
          agentRunId: null as string | null,
          outboxEvent,
          jobPayload,
        };
      }

      await tx.agentRun.updateMany({
        where: { id: agentRunId!, status: "AWAITING_APPROVAL" },
        data: { status: "PENDING" },
      });

      const swarmOutbox = await tx.outboxEvent.create({
        data: {
          eventType: "swarm.resume",
          aggregateType: "AgentRun",
          aggregateId: agentRunId!,
          payload: {
            kind: "swarm.execute",
            runId: agentRunId!,
            workspaceId: approval.workspaceId,
            userId: decidedByUserId,
          },
          status: "PENDING",
        },
      });

      return {
        approval: updatedApproval,
        toolCall: updatedToolCall,
        run: null,
        agentRunId: agentRunId!,
        outboxEvent: swarmOutbox,
        jobPayload: null as GenerationJobPayload | null,
      };
    });

    const { approval: updatedApproval, run, agentRunId, outboxEvent, jobPayload } = txResult;

    if (run && jobPayload) {
      // Resumption: Enqueue to BullMQ with deterministic jobId bound to outbox event
      const resumedJobId = `${run.id}-resume-${outboxEvent.id}`;
      chatQueueManager
        .enqueueRun(
          {
            ...jobPayload,
            outboxEventId: outboxEvent.id,
          },
          resumedJobId
        )
        .catch((err) => {
          console.warn(
            `[ToolApprovalService] Immediate enqueue of resumed run ${run.id} deferred to outbox sweeper:`,
            err
          );
        });

      // Publish WebSocket event
      await streamPublisher.publish({
        type: "tool.approval_decided",
        threadId: txResult.toolCall.threadId || run.threadId,
        runId: run.id,
        messageId: txResult.toolCall.providerCallId,
        sequence: 0,
        timestamp: new Date().toISOString(),
        payload: {
          toolCall: {
            id: txResult.toolCall.id,
            status: "DENIED",
            errorMessage: denialReason,
          },
          toolApproval: {
            id: updatedApproval.id,
            status: "DENIED",
            decidedByUserId,
            rejectionReason: denialReason,
          },
        },
      });
    } else if (agentRunId) {
      chatQueueManager
        .enqueueSwarmRun(
          {
            kind: "swarm.execute",
            runId: agentRunId,
            workspaceId: updatedApproval.workspaceId,
            userId: decidedByUserId,
            outboxEventId: outboxEvent.id,
          },
          `swarm-${agentRunId}-resume-${outboxEvent.id}`
        )
        .catch(() => {});
    }

    // Audit log
    await logAuditEvent({
      actorId: decidedByUserId,
      workspaceId: updatedApproval.workspaceId,
      action: "tool_approval_denied",
      resourceType: "tool_approval",
      resourceId: updatedApproval.id,
      details: {
        decision: "DENIED",
        reason: denialReason,
        toolCallId: txResult.toolCall.id,
        outboxEventId: outboxEvent.id,
      },
    });

    return updatedApproval;
  }

  /**
   * Retrieves pending approvals for a workspace, automatically expiring stale ones.
   */
  public async getPendingApprovals(
    workspaceId: string,
    userId: string
  ): Promise<ToolApproval[]> {
    const role = await workspaceService.getWorkspaceMembership(userId, workspaceId);
    if (!role) {
      throw new ToolApprovalServiceError("Workspace not found or access denied.", 404, "NOT_FOUND");
    }

    const now = new Date();

    // Expire overdue pending approvals
    const expired = await prisma.toolApproval.findMany({
      where: {
        workspaceId,
        status: "PENDING",
        expiresAt: { lt: now },
      },
      select: { id: true, toolCallId: true },
    });

    if (expired.length > 0) {
      const approvalIds = expired.map((e) => e.id);
      const toolCallIds = expired.map((e) => e.toolCallId);

      await prisma.$transaction([
        prisma.toolApproval.updateMany({
          where: { id: { in: approvalIds } },
          data: { status: "EXPIRED" },
        }),
        prisma.toolCall.updateMany({
          where: { id: { in: toolCallIds } },
          data: { status: "EXPIRED" },
        }),
      ]);
    }

    // Return active pending approvals
    return prisma.toolApproval.findMany({
      where: {
        workspaceId,
        status: "PENDING",
        expiresAt: { gte: now },
      },
      include: {
        toolCall: true,
      },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Retrieves a single approval by ID with workspace authorization check.
   */
  public async getApprovalById(
    approvalId: string,
    workspaceId: string,
    userId: string
  ): Promise<ToolApproval> {
    const role = await workspaceService.getWorkspaceMembership(userId, workspaceId);
    if (!role) {
      throw new ToolApprovalServiceError("Workspace not found or access denied.", 404, "NOT_FOUND");
    }

    const approval = await prisma.toolApproval.findFirst({
      where: {
        id: approvalId,
        workspaceId,
      },
      include: {
        toolCall: true,
      },
    });

    if (!approval) {
      throw new ToolApprovalServiceError("Tool approval request not found.", 404, "NOT_FOUND");
    }

    return approval;
  }
}

export const toolApprovalService = new ToolApprovalService();
