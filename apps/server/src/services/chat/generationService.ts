import { prisma, type GenerationRun } from "@messiah/db";
import type { GenerationRunInfo } from "@messiah/shared";
import { threadService } from "./threadService.js";
import { cancellationService } from "./cancellationService.js";
import { streamPublisher } from "./streamPublisher.js";

export class GenerationServiceError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode = 400, code = "GENERATION_SERVICE_ERROR") {
    super(message);
    this.name = "GenerationServiceError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class GenerationService {
  public formatRun(run: GenerationRun): GenerationRunInfo {
    return {
      id: run.id,
      threadId: run.threadId,
      assistantMessageId: run.assistantMessageId,
      providerConnectionId: run.providerConnectionId,
      provider: run.provider as any,
      modelId: run.modelId,
      status: run.status,
      idempotencyKey: run.idempotencyKey,
      requestFingerprint: run.requestFingerprint,
      startedAt: run.startedAt ? run.startedAt.toISOString() : null,
      completedAt: run.completedAt ? run.completedAt.toISOString() : null,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      cachedInputTokens: run.cachedInputTokens,
      providerResponseId: run.providerResponseId,
      safeErrorCode: run.safeErrorCode,
      cancellationRequestedAt: run.cancellationRequestedAt
        ? run.cancellationRequestedAt.toISOString()
        : null,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
    };
  }

  public async getRun(userId: string, runId: string): Promise<GenerationRunInfo> {
    const run = await prisma.generationRun.findUnique({
      where: { id: runId },
    });

    if (!run) {
      throw new GenerationServiceError("Generation run not found.", 404, "RUN_NOT_FOUND");
    }

    // Authorization check via thread access
    await threadService.verifyThreadAccess(userId, run.threadId);

    return this.formatRun(run);
  }

  public async cancelRun(userId: string, runId: string, reason?: string): Promise<GenerationRunInfo> {
    const run = await prisma.generationRun.findUnique({
      where: { id: runId },
    });

    if (!run) {
      throw new GenerationServiceError("Generation run not found.", 404, "RUN_NOT_FOUND");
    }

    // Verify user authorization for thread
    await threadService.verifyThreadAccess(userId, run.threadId);

    if (run.status === "COMPLETED" || run.status === "FAILED" || run.status === "CANCELLED" || run.status === "INTERRUPTED") {
      return this.formatRun(run);
    }

    // Trigger local and distributed cancellation
    await cancellationService.requestCancellation(runId);

    // Update database state
    const now = new Date();
    const updatedRun = await prisma.generationRun.update({
      where: { id: runId },
      data: {
        status: "CANCELLED",
        cancellationRequestedAt: now,
        completedAt: now,
        safeErrorCode: reason || "USER_CANCELLED",
      },
    });

    await prisma.message.update({
      where: { id: run.assistantMessageId },
      data: {
        status: "CANCELLED",
        completedAt: now,
      },
    });

    // Publish run.cancelled event
    await streamPublisher.publish({
      type: "run.cancelled",
      threadId: run.threadId,
      runId: run.id,
      messageId: run.assistantMessageId,
      sequence: 999999,
      timestamp: now.toISOString(),
      payload: {
        status: "CANCELLED",
        error: { code: "USER_CANCELLED", message: reason || "Generation cancelled by user" },
      },
    });

    return this.formatRun(updatedRun);
  }
}

export const generationService = new GenerationService();
