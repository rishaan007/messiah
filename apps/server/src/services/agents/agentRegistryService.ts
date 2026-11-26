import crypto from "node:crypto";
import { prisma, type AgentConfigurationVersion, type AgentDefinition } from "@messiah/db";
import { defaultProviderRegistry } from "@messiah/providers";
import {
  DEFAULT_AGENT_TEMPLATES,
  SWARM_CONSTANTS,
  type AgentConfigurationVersionInfo,
  type AgentDefinitionInfo,
  type AgentExecutionBudget,
  type AgentStatus,
  type CreateAgentDto,
  type SupportedProviderId,
  type UpdateAgentDto,
} from "@messiah/shared";
import { workspaceService } from "../workspaceService.js";
import { logAuditEvent } from "../auditService.js";
import { VaultService } from "../vaultService.js";

export class AgentRegistryError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AgentRegistryError";
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "agent";
}

function computeConfigHash(fields: {
  name: string;
  roleTitle: string;
  canSupervise: boolean;
  providerConnectionId: string | null;
  modelId: string | null;
  systemPrompt: string;
  temperature: number;
  maxOutputTokens: number;
  allowedMcpToolIds: string[];
  allowedBridgeCapabilities: string[];
  preferredBridgeDeviceId: string | null;
  executionBudget: AgentExecutionBudget;
}): string {
  const canonical = JSON.stringify({
    ...fields,
    allowedMcpToolIds: [...fields.allowedMcpToolIds].sort(),
    allowedBridgeCapabilities: [...fields.allowedBridgeCapabilities].sort(),
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function formatVersion(v: AgentConfigurationVersion): AgentConfigurationVersionInfo {
  return {
    id: v.id,
    agentDefinitionId: v.agentDefinitionId,
    workspaceId: v.workspaceId,
    versionNumber: v.versionNumber,
    name: v.name,
    roleTitle: v.roleTitle,
    canSupervise: v.canSupervise,
    providerConnectionId: v.providerConnectionId,
    modelId: v.modelId,
    systemPrompt: v.systemPrompt,
    temperature: v.temperature,
    maxOutputTokens: v.maxOutputTokens,
    allowedMcpToolIds: v.allowedMcpToolIds,
    allowedBridgeCapabilities: v.allowedBridgeCapabilities,
    preferredBridgeDeviceId: v.preferredBridgeDeviceId,
    executionBudget: (v.executionBudget || {}) as AgentExecutionBudget,
    configHash: v.configHash,
    createdByUserId: v.createdByUserId,
    createdAt: v.createdAt.toISOString(),
  };
}

export function formatAgentDefinition(
  agent: AgentDefinition & {
    providerConnection?: {
      id: string;
      provider: string;
      displayName: string;
      status: string;
    } | null;
    versions?: AgentConfigurationVersion[];
  }
): AgentDefinitionInfo {
  return {
    id: agent.id,
    workspaceId: agent.workspaceId,
    createdByUserId: agent.createdByUserId,
    name: agent.name,
    slug: agent.slug,
    roleTitle: agent.roleTitle,
    category: agent.category,
    description: agent.description,
    avatarAccent: agent.avatarAccent,
    isTemplate: agent.isTemplate,
    canSupervise: agent.canSupervise,
    status: agent.status as AgentStatus,
    activeVersion: agent.activeVersion,
    providerConnectionId: agent.providerConnectionId,
    providerConnectionSummary: agent.providerConnection
      ? {
          id: agent.providerConnection.id,
          provider: agent.providerConnection.provider as SupportedProviderId,
          displayName: agent.providerConnection.displayName,
          status: agent.providerConnection.status as "ACTIVE" | "INVALID" | "ERROR",
        }
      : null,
    modelId: agent.modelId,
    systemPrompt: agent.systemPrompt,
    temperature: agent.temperature,
    maxOutputTokens: agent.maxOutputTokens,
    allowedMcpToolIds: agent.allowedMcpToolIds,
    allowedBridgeCapabilities: agent.allowedBridgeCapabilities,
    preferredBridgeDeviceId: agent.preferredBridgeDeviceId,
    defaultExecutionBudget: (agent.defaultExecutionBudget || {}) as AgentExecutionBudget,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    versions: agent.versions ? agent.versions.map(formatVersion) : undefined,
  };
}

export class AgentRegistryService {
  private async assertWorkspaceEditorRole(workspaceId: string, userId: string): Promise<void> {
    const role = await workspaceService.getUserRole(workspaceId, userId);
    if (!role) {
      throw new AgentRegistryError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }
    if (role === "VIEWER") {
      throw new AgentRegistryError(403, "FORBIDDEN_ROLE", "Viewers cannot create or modify workspace agents.");
    }
  }

  private async validateReferences(params: {
    workspaceId: string;
    providerConnectionId?: string | null;
    allowedMcpToolIds?: string[];
    preferredBridgeDeviceId?: string | null;
  }): Promise<void> {
    if (params.providerConnectionId) {
      const conn = await prisma.providerConnection.findUnique({
        where: { id: params.providerConnectionId },
        select: { workspaceId: true, status: true },
      });
      if (!conn || conn.workspaceId !== params.workspaceId) {
        throw new AgentRegistryError(
          404,
          "PROVIDER_CONNECTION_NOT_FOUND",
          "Referenced provider connection does not exist in this workspace."
        );
      }
    }

    if (params.allowedMcpToolIds && params.allowedMcpToolIds.length > 0) {
      const tools = await prisma.mcpToolDefinition.findMany({
        where: {
          id: { in: params.allowedMcpToolIds },
          connection: { workspaceId: params.workspaceId },
        },
        select: { id: true },
      });
      if (tools.length !== new Set(params.allowedMcpToolIds).size) {
        throw new AgentRegistryError(
          400,
          "INVALID_TOOL_ASSIGNMENT",
          "One or more assigned MCP tool IDs do not belong to this workspace."
        );
      }
    }

    if (params.preferredBridgeDeviceId) {
      const device = await prisma.bridgeDevice.findUnique({
        where: { id: params.preferredBridgeDeviceId },
        select: { workspaceId: true },
      });
      if (!device || device.workspaceId !== params.workspaceId) {
        throw new AgentRegistryError(
          404,
          "DEVICE_NOT_FOUND",
          "Preferred Local Bridge device does not exist in this workspace."
        );
      }
    }
  }

  public async listAgents(
    workspaceId: string,
    userId: string,
    options?: { includeArchived?: boolean }
  ): Promise<AgentDefinitionInfo[]> {
    const isMember = await workspaceService.isUserMember(workspaceId, userId);
    if (!isMember) {
      throw new AgentRegistryError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }

    const agents = await prisma.agentDefinition.findMany({
      where: {
        workspaceId,
        ...(options?.includeArchived ? {} : { status: { not: "ARCHIVED" } }),
      },
      include: {
        providerConnection: {
          select: { id: true, provider: true, displayName: true, status: true },
        },
      },
      orderBy: [{ canSupervise: "desc" }, { updatedAt: "desc" }],
    });

    return agents.map(formatAgentDefinition);
  }

  public async getAgent(workspaceId: string, agentId: string, userId: string): Promise<AgentDefinitionInfo> {
    const isMember = await workspaceService.isUserMember(workspaceId, userId);
    if (!isMember) {
      throw new AgentRegistryError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }

    const agent = await prisma.agentDefinition.findUnique({
      where: { id: agentId },
      include: {
        providerConnection: {
          select: { id: true, provider: true, displayName: true, status: true },
        },
        versions: {
          orderBy: { versionNumber: "desc" },
          take: 15,
        },
      },
    });

    if (!agent || agent.workspaceId !== workspaceId) {
      throw new AgentRegistryError(404, "AGENT_NOT_FOUND", "Agent not found in this workspace.");
    }

    return formatAgentDefinition(agent);
  }

  public async createAgent(
    userId: string,
    input: CreateAgentDto & { isTemplate?: boolean }
  ): Promise<AgentDefinitionInfo> {
    await this.assertWorkspaceEditorRole(input.workspaceId, userId);

    const existingCount = await prisma.agentDefinition.count({
      where: { workspaceId: input.workspaceId, status: { not: "ARCHIVED" } },
    });
    if (existingCount >= SWARM_CONSTANTS.MAX_AGENTS_PER_WORKSPACE) {
      throw new AgentRegistryError(
        400,
        "AGENT_LIMIT_REACHED",
        `Workspace cannot exceed ${SWARM_CONSTANTS.MAX_AGENTS_PER_WORKSPACE} active agents.`
      );
    }

    await this.validateReferences({
      workspaceId: input.workspaceId,
      providerConnectionId: input.providerConnectionId,
      allowedMcpToolIds: input.allowedMcpToolIds,
      preferredBridgeDeviceId: input.preferredBridgeDeviceId,
    });

    const baseSlug = input.slug || slugify(input.name);
    let candidateSlug = baseSlug;
    let suffix = 1;
    while (
      await prisma.agentDefinition.findUnique({
        where: { workspaceId_slug: { workspaceId: input.workspaceId, slug: candidateSlug } },
        select: { id: true },
      })
    ) {
      candidateSlug = `${baseSlug}-${suffix++}`;
    }

    const configHash = computeConfigHash({
      name: input.name,
      roleTitle: input.roleTitle,
      canSupervise: input.canSupervise,
      providerConnectionId: input.providerConnectionId || null,
      modelId: input.modelId || null,
      systemPrompt: input.systemPrompt,
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
      allowedMcpToolIds: input.allowedMcpToolIds,
      allowedBridgeCapabilities: input.allowedBridgeCapabilities,
      preferredBridgeDeviceId: input.preferredBridgeDeviceId || null,
      executionBudget: input.defaultExecutionBudget,
    });

    const created = await prisma.$transaction(async (tx) => {
      const def = await tx.agentDefinition.create({
        data: {
          workspaceId: input.workspaceId,
          createdByUserId: userId,
          name: input.name,
          slug: candidateSlug,
          roleTitle: input.roleTitle,
          category: input.category,
          description: input.description || null,
          avatarAccent: input.avatarAccent || "#00FFA3",
          isTemplate: Boolean(input.isTemplate),
          canSupervise: input.canSupervise,
          status: input.status,
          activeVersion: 1,
          providerConnectionId: input.providerConnectionId || null,
          modelId: input.modelId || null,
          systemPrompt: input.systemPrompt,
          temperature: input.temperature,
          maxOutputTokens: input.maxOutputTokens,
          allowedMcpToolIds: Array.from(new Set(input.allowedMcpToolIds)),
          allowedBridgeCapabilities: Array.from(new Set(input.allowedBridgeCapabilities)),
          preferredBridgeDeviceId: input.preferredBridgeDeviceId || null,
          defaultExecutionBudget: input.defaultExecutionBudget as any,
        },
        include: {
          providerConnection: {
            select: { id: true, provider: true, displayName: true, status: true },
          },
        },
      });

      await tx.agentConfigurationVersion.create({
        data: {
          agentDefinitionId: def.id,
          workspaceId: input.workspaceId,
          versionNumber: 1,
          name: def.name,
          roleTitle: def.roleTitle,
          canSupervise: def.canSupervise,
          providerConnectionId: def.providerConnectionId,
          modelId: def.modelId,
          systemPrompt: def.systemPrompt,
          temperature: def.temperature,
          maxOutputTokens: def.maxOutputTokens,
          allowedMcpToolIds: def.allowedMcpToolIds,
          allowedBridgeCapabilities: def.allowedBridgeCapabilities,
          preferredBridgeDeviceId: def.preferredBridgeDeviceId,
          executionBudget: def.defaultExecutionBudget as any,
          configHash,
          createdByUserId: userId,
        },
      });

      return def;
    });

    await logAuditEvent({
      actorId: userId,
      workspaceId: input.workspaceId,
      action: "agent_created",
      resourceType: "agent_definition",
      resourceId: created.id,
      details: { name: created.name, slug: created.slug, canSupervise: created.canSupervise },
    });

    return formatAgentDefinition(created);
  }

  public async updateAgent(
    workspaceId: string,
    agentId: string,
    userId: string,
    input: UpdateAgentDto
  ): Promise<AgentDefinitionInfo> {
    await this.assertWorkspaceEditorRole(workspaceId, userId);

    const existing = await prisma.agentDefinition.findUnique({ where: { id: agentId } });
    if (!existing || existing.workspaceId !== workspaceId) {
      throw new AgentRegistryError(404, "AGENT_NOT_FOUND", "Agent not found in this workspace.");
    }

    await this.validateReferences({
      workspaceId,
      providerConnectionId:
        input.providerConnectionId !== undefined ? input.providerConnectionId : existing.providerConnectionId,
      allowedMcpToolIds:
        input.allowedMcpToolIds !== undefined ? input.allowedMcpToolIds : existing.allowedMcpToolIds,
      preferredBridgeDeviceId:
        input.preferredBridgeDeviceId !== undefined
          ? input.preferredBridgeDeviceId
          : existing.preferredBridgeDeviceId,
    });

    const nextVersion = existing.activeVersion + 1;
    const nextName = input.name ?? existing.name;
    const nextRoleTitle = input.roleTitle ?? existing.roleTitle;
    const nextCanSupervise = input.canSupervise ?? existing.canSupervise;
    const nextConnId =
      input.providerConnectionId !== undefined ? input.providerConnectionId : existing.providerConnectionId;
    const nextModelId = input.modelId !== undefined ? input.modelId : existing.modelId;
    const nextPrompt = input.systemPrompt ?? existing.systemPrompt;
    const nextTemp = input.temperature ?? existing.temperature;
    const nextMaxTokens = input.maxOutputTokens ?? existing.maxOutputTokens;
    const nextMcpIds =
      input.allowedMcpToolIds !== undefined
        ? Array.from(new Set(input.allowedMcpToolIds))
        : existing.allowedMcpToolIds;
    const nextBridgeCaps =
      input.allowedBridgeCapabilities !== undefined
        ? Array.from(new Set(input.allowedBridgeCapabilities))
        : existing.allowedBridgeCapabilities;
    const nextDeviceId =
      input.preferredBridgeDeviceId !== undefined
        ? input.preferredBridgeDeviceId
        : existing.preferredBridgeDeviceId;
    const nextBudget = (input.defaultExecutionBudget ??
      existing.defaultExecutionBudget ??
      {}) as AgentExecutionBudget;

    const configHash = computeConfigHash({
      name: nextName,
      roleTitle: nextRoleTitle,
      canSupervise: nextCanSupervise,
      providerConnectionId: nextConnId,
      modelId: nextModelId,
      systemPrompt: nextPrompt,
      temperature: nextTemp,
      maxOutputTokens: nextMaxTokens,
      allowedMcpToolIds: nextMcpIds,
      allowedBridgeCapabilities: nextBridgeCaps,
      preferredBridgeDeviceId: nextDeviceId,
      executionBudget: nextBudget,
    });

    const updated = await prisma.$transaction(async (tx) => {
      await tx.agentDefinition.update({
        where: { id: agentId },
        data: {
          name: nextName,
          roleTitle: nextRoleTitle,
          category: input.category ?? existing.category,
          description: input.description !== undefined ? input.description : existing.description,
          avatarAccent: input.avatarAccent !== undefined ? input.avatarAccent : existing.avatarAccent,
          canSupervise: nextCanSupervise,
          status: input.status ?? existing.status,
          activeVersion: nextVersion,
          providerConnectionId: nextConnId,
          modelId: nextModelId,
          systemPrompt: nextPrompt,
          temperature: nextTemp,
          maxOutputTokens: nextMaxTokens,
          allowedMcpToolIds: nextMcpIds,
          allowedBridgeCapabilities: nextBridgeCaps,
          preferredBridgeDeviceId: nextDeviceId,
          defaultExecutionBudget: nextBudget as any,
        },
      });

      await tx.agentConfigurationVersion.create({
        data: {
          agentDefinitionId: agentId,
          workspaceId,
          versionNumber: nextVersion,
          name: nextName,
          roleTitle: nextRoleTitle,
          canSupervise: nextCanSupervise,
          providerConnectionId: nextConnId,
          modelId: nextModelId,
          systemPrompt: nextPrompt,
          temperature: nextTemp,
          maxOutputTokens: nextMaxTokens,
          allowedMcpToolIds: nextMcpIds,
          allowedBridgeCapabilities: nextBridgeCaps,
          preferredBridgeDeviceId: nextDeviceId,
          executionBudget: nextBudget as any,
          configHash,
          createdByUserId: userId,
        },
      });

      return tx.agentDefinition.findUniqueOrThrow({
        where: { id: agentId },
        include: {
          providerConnection: {
            select: { id: true, provider: true, displayName: true, status: true },
          },
          versions: {
            orderBy: { versionNumber: "desc" },
            take: 15,
          },
        },
      });
    });

    await logAuditEvent({
      actorId: userId,
      workspaceId,
      action: "agent_updated",
      resourceType: "agent_definition",
      resourceId: updated.id,
      details: { activeVersion: nextVersion, configHash },
    });

    return formatAgentDefinition(updated);
  }

  public async duplicateAgent(
    workspaceId: string,
    agentId: string,
    userId: string
  ): Promise<AgentDefinitionInfo> {
    const source = await this.getAgent(workspaceId, agentId, userId);
    return this.createAgent(userId, {
      workspaceId,
      name: `${source.name} (Copy)`,
      roleTitle: source.roleTitle,
      category: source.category,
      description: source.description,
      avatarAccent: source.avatarAccent,
      canSupervise: source.canSupervise,
      status: "ACTIVE",
      providerConnectionId: source.providerConnectionId,
      modelId: source.modelId,
      systemPrompt: source.systemPrompt,
      temperature: source.temperature,
      maxOutputTokens: source.maxOutputTokens,
      allowedMcpToolIds: source.allowedMcpToolIds,
      allowedBridgeCapabilities: source.allowedBridgeCapabilities,
      preferredBridgeDeviceId: source.preferredBridgeDeviceId,
      defaultExecutionBudget: source.defaultExecutionBudget,
    });
  }

  public async deleteOrArchiveAgent(
    workspaceId: string,
    agentId: string,
    userId: string
  ): Promise<{ archived: boolean; id: string }> {
    await this.assertWorkspaceEditorRole(workspaceId, userId);

    const existing = await prisma.agentDefinition.findUnique({ where: { id: agentId } });
    if (!existing || existing.workspaceId !== workspaceId) {
      throw new AgentRegistryError(404, "AGENT_NOT_FOUND", "Agent not found in this workspace.");
    }

    await prisma.agentDefinition.update({
      where: { id: agentId },
      data: { status: "ARCHIVED" },
    });

    await logAuditEvent({
      actorId: userId,
      workspaceId,
      action: "agent_archived",
      resourceType: "agent_definition",
      resourceId: agentId,
    });

    return { archived: true, id: agentId };
  }

  /**
   * Seeds default specialist templates for a workspace, wiring them to the workspace's active provider connection if available.
   */
  public async seedDefaultTemplates(workspaceId: string, userId: string): Promise<AgentDefinitionInfo[]> {
    await this.assertWorkspaceEditorRole(workspaceId, userId);

    const activeConn = await prisma.providerConnection.findFirst({
      where: { workspaceId, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
    });

    const defaultModelForProvider = (provider?: string): string | null => {
      if (provider === "openai") return "gpt-4o-mini";
      if (provider === "anthropic") return "claude-3-5-sonnet-20241022";
      if (provider === "gemini") return "gemini-2.5-flash";
      return null;
    };

    const existingSlugs = new Set(
      (
        await prisma.agentDefinition.findMany({
          where: { workspaceId },
          select: { slug: true },
        })
      ).map((a) => a.slug)
    );

    const createdAgents: AgentDefinitionInfo[] = [];
    for (const tpl of DEFAULT_AGENT_TEMPLATES) {
      if (existingSlugs.has(tpl.slug)) continue;
      const created = await this.createAgent(userId, {
        workspaceId,
        name: tpl.name,
        slug: tpl.slug,
        roleTitle: tpl.roleTitle,
        category: tpl.category,
        description: tpl.description,
        avatarAccent: tpl.avatarAccent,
        canSupervise: tpl.canSupervise,
        status: "ACTIVE",
        providerConnectionId: activeConn?.id || null,
        modelId: defaultModelForProvider(activeConn?.provider),
        systemPrompt: tpl.systemPrompt,
        temperature: tpl.temperature,
        maxOutputTokens: tpl.maxOutputTokens,
        allowedMcpToolIds: [],
        allowedBridgeCapabilities: [],
        preferredBridgeDeviceId: null,
        defaultExecutionBudget: { maxIterations: 4 },
        isTemplate: true,
      });
      createdAgents.push(created);
    }

    return createdAgents;
  }

  /**
   * Runs a single non-mutating test prompt against an agent's configured persona & model.
   */
  public async testAgentPrompt(
    workspaceId: string,
    agentId: string,
    userId: string,
    prompt: string
  ): Promise<{
    output: string;
    modelId: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
  }> {
    await this.assertWorkspaceEditorRole(workspaceId, userId);

    const agent = await prisma.agentDefinition.findUnique({
      where: { id: agentId },
      include: { providerConnection: { include: { credential: true } } },
    });

    if (!agent || agent.workspaceId !== workspaceId) {
      throw new AgentRegistryError(404, "AGENT_NOT_FOUND", "Agent not found in this workspace.");
    }

    if (!agent.providerConnection || !agent.providerConnection.credential || !agent.modelId) {
      throw new AgentRegistryError(
        400,
        "AGENT_MODEL_NOT_CONFIGURED",
        "Configure an active AI provider connection and model ID before testing this agent."
      );
    }

    if (agent.providerConnection.status !== "ACTIVE") {
      throw new AgentRegistryError(400, "PROVIDER_INACTIVE", "Agent provider connection is not active.");
    }

    const vault = new VaultService();
    const apiKey = vault.decrypt(agent.providerConnection.credential, {
      workspaceId,
      providerConnectionId: agent.providerConnectionId!,
      provider: agent.providerConnection.provider,
    });

    const adapter = defaultProviderRegistry.getAdapter(agent.providerConnection.provider as SupportedProviderId);
    const startedAt = Date.now();
    let output = "";
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const chunk of adapter.streamResponse({
      credentials: { apiKey },
      model: agent.modelId,
      messages: [
        { role: "system", content: agent.systemPrompt },
        { role: "user", content: prompt },
      ],
      temperature: agent.temperature,
      maxTokens: Math.min(agent.maxOutputTokens || 1024, 2048),
    })) {
      if (chunk.type === "text_delta" && chunk.text) {
        output += chunk.text;
      } else if (chunk.type === "usage") {
        inputTokens = chunk.inputTokens || inputTokens;
        outputTokens = chunk.outputTokens || outputTokens;
      }
    }

    return {
      output,
      modelId: agent.modelId,
      provider: agent.providerConnection.provider,
      inputTokens,
      outputTokens,
      durationMs: Date.now() - startedAt,
    };
  }
}

export const agentRegistryService = new AgentRegistryService();
