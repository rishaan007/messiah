import { prisma, type WorkspaceRole } from '@messiah/db';
import type { AuthUserContext, UserProfile, UpdateProfileInput } from '@messiah/shared';

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

export class UserService {
  /**
   * Idempotently resolves an internal Messiah user from external provider claims.
   * If the user does not exist, creates the user and a default personal workspace transactionally.
   */
  async findOrCreateUserFromAuth(params: {
    externalId: string;
    email: string;
    fullName?: string | null;
    avatarUrl?: string | null;
    externalProvider?: string;
  }): Promise<AuthUserContext> {
    const { externalId, email, fullName, avatarUrl, externalProvider = 'supabase' } = params;

    // 1. Check if user already exists
    let user = await prisma.user.findUnique({
      where: { externalId },
      include: {
        memberships: {
          include: {
            workspace: true,
          },
        },
      },
    });

    if (!user) {
      // 2. User does not exist, create user and personal workspace transactionally
      const displayName = fullName || email.split('@')[0] || 'User';
      const workspaceName = `${displayName}'s Workspace`;
      const slug = generateSlug(displayName);

      user = await prisma.$transaction(async (tx) => {
        // Create user record
        const newUser = await tx.user.create({
          data: {
            externalId,
            externalProvider,
            email,
            fullName: fullName || null,
            avatarUrl: avatarUrl || null,
          },
        });

        // Create default personal workspace
        const workspace = await tx.workspace.create({
          data: {
            name: workspaceName,
            slug,
            ownerId: newUser.id,
          },
        });

        // Create OWNER membership
        await tx.workspaceMember.create({
          data: {
            workspaceId: workspace.id,
            userId: newUser.id,
            role: 'OWNER',
          },
        });

        return tx.user.findUniqueOrThrow({
          where: { id: newUser.id },
          include: {
            memberships: {
              include: {
                workspace: true,
              },
            },
          },
        });
      });
    } else {
      // 3. User exists, ensure they have at least one workspace (idempotency safety check)
      const existingUser = user;
      if (existingUser.memberships.length === 0) {
        const displayName = existingUser.fullName || existingUser.email.split('@')[0] || 'User';
        const workspaceName = `${displayName}'s Workspace`;
        const slug = generateSlug(displayName);

        await prisma.$transaction(async (tx) => {
          const workspace = await tx.workspace.create({
            data: {
              name: workspaceName,
              slug,
              ownerId: existingUser.id,
            },
          });

          await tx.workspaceMember.create({
            data: {
              workspaceId: workspace.id,
              userId: existingUser.id,
              role: 'OWNER',
            },
          });
        });
      }
    }

    return {
      id: user.id,
      externalId: user.externalId,
      externalProvider: user.externalProvider,
      email: user.email,
      fullName: user.fullName,
    };
  }

  /**
   * Retrieves full user profile including all workspace memberships.
   */
  async getUserProfile(userId: string): Promise<UserProfile | null> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        memberships: {
          include: {
            workspace: true,
          },
          orderBy: {
            joinedAt: 'asc',
          },
        },
      },
    });

    if (!user) {
      return null;
    }

    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      avatarUrl: user.avatarUrl,
      externalProvider: user.externalProvider,
      externalId: user.externalId,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
      memberships: user.memberships.map((m) => ({
        id: m.id,
        workspaceId: m.workspaceId,
        workspaceName: m.workspace.name,
        workspaceSlug: m.workspace.slug,
        role: m.role as WorkspaceRole,
        joinedAt: m.joinedAt.toISOString(),
      })),
    };
  }

  /**
   * Updates user profile fields with validation.
   */
  async updateUserProfile(userId: string, input: UpdateProfileInput): Promise<UserProfile> {
    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(input.fullName !== undefined && { fullName: input.fullName }),
        ...(input.avatarUrl !== undefined && { avatarUrl: input.avatarUrl }),
      },
      include: {
        memberships: {
          include: {
            workspace: true,
          },
          orderBy: {
            joinedAt: 'asc',
          },
        },
      },
    });

    return {
      id: updated.id,
      email: updated.email,
      fullName: updated.fullName,
      avatarUrl: updated.avatarUrl,
      externalProvider: updated.externalProvider,
      externalId: updated.externalId,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
      memberships: updated.memberships.map((m) => ({
        id: m.id,
        workspaceId: m.workspaceId,
        workspaceName: m.workspace.name,
        workspaceSlug: m.workspace.slug,
        role: m.role as WorkspaceRole,
        joinedAt: m.joinedAt.toISOString(),
      })),
    };
  }
}

export const userService = new UserService();
