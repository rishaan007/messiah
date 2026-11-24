import { prisma, type Thread } from "@messiah/db";
import type { ThreadInfo, CreateThreadInput, UpdateThreadInput } from "@messiah/shared";
import { workspaceService } from "../workspaceService.js";

export class ThreadServiceError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode = 400, code = "THREAD_SERVICE_ERROR") {
    super(message);
    this.name = "ThreadServiceError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class ThreadService {
  private formatThread(thread: Thread & { _count?: { messages: number } }): ThreadInfo {
    return {
      id: thread.id,
      workspaceId: thread.workspaceId,
      createdByUserId: thread.createdByUserId,
      title: thread.title,
      preferredProviderConnectionId: thread.preferredProviderConnectionId,
      preferredModelId: thread.preferredModelId,
      lastMessageAt: thread.lastMessageAt.toISOString(),
      archivedAt: thread.archivedAt ? thread.archivedAt.toISOString() : null,
      createdAt: thread.createdAt.toISOString(),
      updatedAt: thread.updatedAt.toISOString(),
      messageCount: thread._count?.messages,
    };
  }

  /**
   * Verifies that the user has authorized access to the thread via workspace membership.
   * Returns 404 for unauthorized or non-existent threads to prevent enumeration.
   */
  public async verifyThreadAccess(userId: string, threadId: string): Promise<Thread> {
    const thread = await prisma.thread.findUnique({
      where: { id: threadId },
    });

    if (!thread) {
      throw new ThreadServiceError("Conversation thread not found.", 404, "THREAD_NOT_FOUND");
    }

    const isMember = await workspaceService.isUserMember(thread.workspaceId, userId);
    if (!isMember) {
      throw new ThreadServiceError("Conversation thread not found.", 404, "THREAD_NOT_FOUND");
    }

    return thread;
  }

  public async createThread(userId: string, input: CreateThreadInput): Promise<ThreadInfo> {
    const isMember = await workspaceService.isUserMember(input.workspaceId, userId);
    if (!isMember) {
      throw new ThreadServiceError("Unauthorized: You are not a member of this workspace.", 403, "FORBIDDEN");
    }

    // Validate preferred provider connection if provided
    if (input.preferredProviderConnectionId) {
      const conn = await prisma.providerConnection.findFirst({
        where: { id: input.preferredProviderConnectionId, workspaceId: input.workspaceId },
      });
      if (!conn) {
        throw new ThreadServiceError("Preferred provider connection not found in this workspace.", 400, "INVALID_CONNECTION");
      }
    }

    const thread = await prisma.thread.create({
      data: {
        workspaceId: input.workspaceId,
        createdByUserId: userId,
        title: input.title?.trim() || "New Conversation",
        preferredProviderConnectionId: input.preferredProviderConnectionId,
        preferredModelId: input.preferredModelId?.trim(),
      },
    });

    return this.formatThread(thread);
  }

  public async listThreads(
    userId: string,
    workspaceId: string,
    options: { includeArchived?: boolean; limit?: number } = {}
  ): Promise<ThreadInfo[]> {
    const isMember = await workspaceService.isUserMember(workspaceId, userId);
    if (!isMember) {
      throw new ThreadServiceError("Unauthorized: You are not a member of this workspace.", 403, "FORBIDDEN");
    }

    const threads = await prisma.thread.findMany({
      where: {
        workspaceId,
        archivedAt: options.includeArchived ? undefined : null,
      },
      include: {
        _count: { select: { messages: true } },
      },
      orderBy: { lastMessageAt: "desc" },
      take: options.limit || 50,
    });

    return threads.map((t) => this.formatThread(t));
  }

  public async getThread(userId: string, threadId: string): Promise<ThreadInfo> {
    const thread = await this.verifyThreadAccess(userId, threadId);
    const count = await prisma.message.count({ where: { threadId } });
    return this.formatThread({ ...thread, _count: { messages: count } });
  }

  public async updateThread(
    userId: string,
    threadId: string,
    input: UpdateThreadInput
  ): Promise<ThreadInfo> {
    const thread = await this.verifyThreadAccess(userId, threadId);

    const updateData: {
      title?: string;
      archivedAt?: Date | null;
      preferredProviderConnectionId?: string | null;
      preferredModelId?: string | null;
    } = {};

    if (input.title !== undefined) {
      updateData.title = input.title.trim();
    }
    if (input.archived !== undefined) {
      updateData.archivedAt = input.archived ? new Date() : null;
    }
    if (input.preferredProviderConnectionId !== undefined) {
      if (input.preferredProviderConnectionId) {
        const conn = await prisma.providerConnection.findFirst({
          where: { id: input.preferredProviderConnectionId, workspaceId: thread.workspaceId },
        });
        if (!conn) {
          throw new ThreadServiceError("Preferred provider connection not found.", 400, "INVALID_CONNECTION");
        }
      }
      updateData.preferredProviderConnectionId = input.preferredProviderConnectionId;
    }
    if (input.preferredModelId !== undefined) {
      updateData.preferredModelId = input.preferredModelId ? input.preferredModelId.trim() : null;
    }

    const updated = await prisma.thread.update({
      where: { id: threadId },
      data: updateData,
    });

    return this.formatThread(updated);
  }

  public async deleteThread(userId: string, threadId: string): Promise<void> {
    const thread = await this.verifyThreadAccess(userId, threadId);

    // Only thread author or workspace admin/owner can delete
    const role = await workspaceService.getUserRole(thread.workspaceId, userId);
    if (thread.createdByUserId !== userId && role !== "OWNER" && role !== "ADMIN") {
      throw new ThreadServiceError("Unauthorized: Only thread authors or workspace admins can delete conversations.", 403, "FORBIDDEN");
    }

    await prisma.thread.delete({
      where: { id: threadId },
    });
  }
}

export const threadService = new ThreadService();
