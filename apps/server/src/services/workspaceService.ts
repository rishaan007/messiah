import { prisma, type WorkspaceRole } from '@messiah/db';
import type { WorkspaceInfo, CreateWorkspaceInput } from '@messiah/shared';

function generateSlug(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  const randomSuffix = Math.random().toString(36).substring(2, 7);
  return `${base || 'workspace'}-${randomSuffix}`;
}

export class WorkspaceService {
  /**
   * Retrieves all workspaces accessible to the authenticated user.
   */
  async getAccessibleWorkspaces(userId: string): Promise<WorkspaceInfo[]> {
    const memberships = await prisma.workspaceMember.findMany({
      where: { userId },
      include: {
        workspace: {
          include: {
            _count: {
              select: { members: true },
            },
          },
        },
      },
      orderBy: {
        joinedAt: 'asc',
      },
    });

    return memberships.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      slug: m.workspace.slug,
      role: m.role as WorkspaceRole,
      ownerId: m.workspace.ownerId,
      createdAt: m.workspace.createdAt.toISOString(),
      updatedAt: m.workspace.updatedAt.toISOString(),
      memberCount: m.workspace._count.members,
    }));
  }

  /**
   * Creates a new workspace with the authenticated user as OWNER.
   */
  async createWorkspace(userId: string, input: CreateWorkspaceInput): Promise<WorkspaceInfo> {
    let slug = input.slug ? input.slug.toLowerCase().trim() : generateSlug(input.name);

    // Verify slug uniqueness
    const existing = await prisma.workspace.findUnique({ where: { slug } });
    if (existing) {
      slug = generateSlug(input.name);
    }

    return await prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: {
          name: input.name.trim(),
          slug,
          ownerId: userId,
        },
      });

      const member = await tx.workspaceMember.create({
        data: {
          workspaceId: workspace.id,
          userId,
          role: 'OWNER',
        },
      });

      return {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        role: member.role as WorkspaceRole,
        ownerId: workspace.ownerId,
        createdAt: workspace.createdAt.toISOString(),
        updatedAt: workspace.updatedAt.toISOString(),
        memberCount: 1,
      };
    });
  }

  /**
   * Retrieves a specific workspace after verifying the authenticated user is an authorized member.
   * Returns null if the workspace does not exist or user is not a member (IDOR protection).
   */
  async getWorkspaceById(userId: string, workspaceId: string): Promise<WorkspaceInfo | null> {
    const membership = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId,
        },
      },
      include: {
        workspace: {
          include: {
            _count: {
              select: { members: true },
            },
          },
        },
      },
    });

    if (!membership) {
      return null;
    }

    return {
      id: membership.workspace.id,
      name: membership.workspace.name,
      slug: membership.workspace.slug,
      role: membership.role as WorkspaceRole,
      ownerId: membership.workspace.ownerId,
      createdAt: membership.workspace.createdAt.toISOString(),
      updatedAt: membership.workspace.updatedAt.toISOString(),
      memberCount: membership.workspace._count.members,
    };
  }

  /**
   * Fast membership role lookup for authorization checks.
   */
  async getWorkspaceMembership(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
    const member = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId,
        },
      },
      select: {
        role: true,
      },
    });

    return (member?.role as WorkspaceRole) ?? null;
  }

  async isUserMember(workspaceId: string, userId: string): Promise<boolean> {
    const role = await this.getWorkspaceMembership(userId, workspaceId);
    return role !== null;
  }

  async getUserRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
    return await this.getWorkspaceMembership(userId, workspaceId);
  }
}

export const workspaceService = new WorkspaceService();
