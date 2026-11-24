import { prisma, type Message, type MessageRole, type MessageStatus } from "@messiah/db";
import type { MessageInfo } from "@messiah/shared";
import { threadService } from "./threadService.js";

export class MessageService {
  public formatMessage(msg: Message & { generationRuns?: any[] }): MessageInfo {
    const latestRun = msg.generationRuns && msg.generationRuns.length > 0 ? msg.generationRuns[0] : null;

    return {
      id: msg.id,
      threadId: msg.threadId,
      sequence: msg.sequence,
      role: msg.role,
      content: msg.content,
      status: msg.status,
      providerConnectionId: msg.providerConnectionId,
      modelId: msg.modelId,
      completedAt: msg.completedAt ? msg.completedAt.toISOString() : null,
      createdAt: msg.createdAt.toISOString(),
      updatedAt: msg.updatedAt.toISOString(),
      run: latestRun
        ? {
            id: latestRun.id,
            threadId: latestRun.threadId,
            assistantMessageId: latestRun.assistantMessageId,
            providerConnectionId: latestRun.providerConnectionId,
            provider: latestRun.provider,
            modelId: latestRun.modelId,
            status: latestRun.status,
            idempotencyKey: latestRun.idempotencyKey,
            requestFingerprint: latestRun.requestFingerprint,
            startedAt: latestRun.startedAt ? latestRun.startedAt.toISOString() : null,
            completedAt: latestRun.completedAt ? latestRun.completedAt.toISOString() : null,
            inputTokens: latestRun.inputTokens,
            outputTokens: latestRun.outputTokens,
            cachedInputTokens: latestRun.cachedInputTokens,
            providerResponseId: latestRun.providerResponseId,
            safeErrorCode: latestRun.safeErrorCode,
            cancellationRequestedAt: latestRun.cancellationRequestedAt
              ? latestRun.cancellationRequestedAt.toISOString()
              : null,
            createdAt: latestRun.createdAt.toISOString(),
            updatedAt: latestRun.updatedAt.toISOString(),
          }
        : null,
    };
  }

  public async listMessages(
    userId: string,
    threadId: string,
    options: { limit?: number; cursor?: string } = {}
  ): Promise<{ messages: MessageInfo[]; nextCursor: string | null }> {
    // Verify user authorization for this thread
    await threadService.verifyThreadAccess(userId, threadId);

    const limit = Math.min(options.limit || 50, 100);

    const messages = await prisma.message.findMany({
      where: { threadId },
      include: {
        generationRuns: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      orderBy: { sequence: "asc" },
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });

    let nextCursor: string | null = null;
    if (messages.length > limit) {
      const nextItem = messages.pop();
      nextCursor = nextItem ? nextItem.id : null;
    }

    return {
      messages: messages.map((m) => this.formatMessage(m)),
      nextCursor,
    };
  }

  public async getNextSequence(threadId: string): Promise<number> {
    const latest = await prisma.message.findFirst({
      where: { threadId },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    return (latest?.sequence || 0) + 1;
  }

  public async createMessage(
    threadId: string,
    role: MessageRole,
    content: string,
    status: MessageStatus = "COMPLETED",
    options: { providerConnectionId?: string; modelId?: string; sequence?: number } = {}
  ): Promise<Message> {
    const sequence = options.sequence ?? (await this.getNextSequence(threadId));

    return await prisma.message.create({
      data: {
        threadId,
        sequence,
        role,
        content,
        status,
        providerConnectionId: options.providerConnectionId,
        modelId: options.modelId,
        completedAt: status === "COMPLETED" ? new Date() : null,
      },
    });
  }

  public async updateMessageContent(
    messageId: string,
    content: string,
    status?: MessageStatus,
    completedAt?: Date
  ): Promise<Message> {
    return await prisma.message.update({
      where: { id: messageId },
      data: {
        content,
        ...(status ? { status } : {}),
        ...(completedAt !== undefined ? { completedAt } : {}),
      },
    });
  }
}

export const messageService = new MessageService();
