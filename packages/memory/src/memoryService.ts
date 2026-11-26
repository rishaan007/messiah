import crypto from "node:crypto";
import { prisma, Prisma } from "@messiah/db";
import { EmbeddingService } from "@messiah/providers";
import type {
  ClearMemoriesDto,
  CreateMemoryCollectionDto,
  CreateMemoryDto,
  MemoryCollectionInfo,
  MemoryInfo,
  MemoryScope,
  MemorySearchMatch,
  MemorySearchResponse,
  MemorySettingsInfo,
  MemorySourceType,
  MemorySensitivity,
  ReembedMemoriesDto,
  SearchMemoryDto,
  SupportedProviderId,
  UpdateMemoryDto,
  UpdateMemorySettingsDto,
  WorkspaceRole,
} from "@messiah/shared";
import { MEMORY_CONSTANTS } from "@messiah/shared";
import { MemorySanitizer } from "./sanitizer.js";

export class MemoryServiceError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "MemoryServiceError";
  }
}

export interface MemoryProviderDecryptInput {
  ciphertext: string;
  initializationVector: string;
  authenticationTag: string;
  keyVersion: string;
  providerConnectionId: string;
  workspaceId: string;
  provider: string;
}

export interface MemoryServiceDeps {
  decryptProviderSecret?: (input: MemoryProviderDecryptInput) => string;
  embedTextFn?: (params: {
    provider: SupportedProviderId;
    model: string;
    dimensions?: number;
    texts: string[];
    apiKey?: string;
  }) => Promise<{ embeddings: number[][]; dimensions: number; model: string; totalTokens: number }>;
}

interface ResolvedEmbeddingTarget {
  provider: SupportedProviderId;
  model: string;
  dimensions: number;
  apiKey?: string;
  providerConnectionId?: string;
}

function slugifyName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return base || `collection-${Date.now()}`;
}

function serializeVectorLiteral(vec: number[]): string {
  if (!Array.isArray(vec) || vec.length === 0) {
    throw new MemoryServiceError(400, "INVALID_VECTOR", "Embedding vector must be non-empty.");
  }
  const clean: string[] = [];
  for (let i = 0; i < vec.length; i++) {
    const val = vec[i];
    if (typeof val !== "number" || !Number.isFinite(val)) {
      throw new MemoryServiceError(400, "INVALID_VECTOR", "Embedding vector contains non-finite value.");
    }
    clean.push(Number(val).toString());
  }
  return `[${clean.join(",")}]`;
}

function mapMemoryRowToInfo(row: any): MemoryInfo {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    scope: row.scope,
    ownerUserId: row.ownerUserId || null,
    agentId: row.agentId || null,
    agentName: row.agent?.name || row.agentName || null,
    collectionId: row.collectionId || null,
    collectionName: row.collection?.name || row.collectionName || null,
    sourceType: row.sourceType,
    sourceThreadId: row.sourceThreadId || null,
    sourceMessageId: row.sourceMessageId || null,
    sourceAgentRunId: row.sourceAgentRunId || null,
    sourceWorkflowRunId: row.sourceWorkflowRunId || null,
    title: row.title,
    content: row.content,
    summary: row.summary || null,
    contentHash: row.contentHash,
    tags: Array.isArray(row.tags) ? row.tags : [],
    metadata: (row.metadata as Record<string, unknown>) || {},
    importance: typeof row.importance === "number" ? row.importance : Number(row.importance ?? 0.5),
    sensitivity: row.sensitivity,
    isPinned: Boolean(row.isPinned),
    isArchived: Boolean(row.isArchived),
    currentVersion: Number(row.currentVersion ?? 1),
    accessCount: Number(row.accessCount ?? 0),
    lastAccessedAt: row.lastAccessedAt ? new Date(row.lastAccessedAt).toISOString() : null,
    expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
    embeddingStatus: row.embedding?.status ?? row.embeddingStatus ?? null,
    embeddingModel: row.embedding?.embeddingModel ?? row.embeddingModel ?? null,
    embeddingDimensions: row.embedding?.embeddingDimensions ?? row.embeddingDimensions ?? null,
    createdByUserId: row.createdByUserId || null,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    versions: Array.isArray(row.versions)
      ? row.versions.map((v: any) => ({
          id: v.id,
          memoryId: v.memoryId,
          versionNumber: v.versionNumber,
          title: v.title,
          content: v.content,
          contentHash: v.contentHash,
          changeReason: v.changeReason || null,
          editedByUserId: v.editedByUserId || null,
          createdAt: new Date(v.createdAt).toISOString(),
        }))
      : undefined,
  };
}

export class MemoryService {
  constructor(private readonly deps: MemoryServiceDeps = {}) {}

  private async assertMember(workspaceId: string, userId: string): Promise<WorkspaceRole> {
    const member = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    if (!member) {
      throw new MemoryServiceError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }
    return member.role as WorkspaceRole;
  }

  private assertCanWriteScope(role: WorkspaceRole, scope: MemoryScope): void {
    if (scope !== "PERSONAL" && role === "VIEWER") {
      throw new MemoryServiceError(
        403,
        "INSUFFICIENT_ROLE",
        "Viewer role cannot create or modify shared workspace or agent memories."
      );
    }
  }

  public async getSettings(workspaceId: string, userId: string): Promise<MemorySettingsInfo> {
    await this.assertMember(workspaceId, userId);
    return this.getOrCreateSettingsInternal(workspaceId);
  }

  public async getOrCreateSettingsInternal(workspaceId: string): Promise<MemorySettingsInfo> {
    const existing = await prisma.memorySettings.findUnique({
      where: { workspaceId },
    });
    if (existing) {
      return {
        ...existing,
        createdAt: existing.createdAt.toISOString(),
        updatedAt: existing.updatedAt.toISOString(),
      };
    }
    const created = await prisma.memorySettings.create({
      data: {
        workspaceId,
        embeddingDimensions: MEMORY_CONSTANTS.DEFAULT_EMBEDDING_DIMENSIONS,
        enableAutoCapture: false,
        enableChatInjection: true,
        enableSwarmInjection: true,
        defaultTopK: MEMORY_CONSTANTS.DEFAULT_TOP_K,
        minSimilarityScore: MEMORY_CONSTANTS.DEFAULT_MIN_SIMILARITY,
      },
    });
    return {
      ...created,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    };
  }

  public async updateSettings(
    userId: string,
    dto: UpdateMemorySettingsDto
  ): Promise<MemorySettingsInfo> {
    const role = await this.assertMember(dto.workspaceId, userId);
    if (role !== "OWNER" && role !== "ADMIN") {
      throw new MemoryServiceError(
        403,
        "FORBIDDEN_ROLE",
        "Only workspace OWNER or ADMIN can update memory configuration."
      );
    }

    if (dto.embeddingProvider === "anthropic") {
      throw new MemoryServiceError(
        422,
        "UNSUPPORTED_EMBEDDING_PROVIDER",
        "Anthropic does not provide native text embeddings; configure OpenAI or Gemini for embeddings."
      );
    }

    if (dto.providerConnectionId) {
      const conn = await prisma.providerConnection.findUnique({
        where: { id: dto.providerConnectionId },
      });
      if (!conn || conn.workspaceId !== dto.workspaceId) {
        throw new MemoryServiceError(404, "CONNECTION_NOT_FOUND", "Provider connection not found in workspace.");
      }
      if (!EmbeddingService.supportsEmbeddings(conn.provider as SupportedProviderId)) {
        throw new MemoryServiceError(
          422,
          "UNSUPPORTED_EMBEDDING_PROVIDER",
          `Provider '${conn.provider}' does not support text embeddings.`
        );
      }
    }

    await this.getOrCreateSettingsInternal(dto.workspaceId);

    const updated = await prisma.memorySettings.update({
      where: { workspaceId: dto.workspaceId },
      data: {
        ...(dto.embeddingProvider !== undefined ? { embeddingProvider: dto.embeddingProvider } : {}),
        ...(dto.embeddingModel !== undefined ? { embeddingModel: dto.embeddingModel } : {}),
        ...(dto.embeddingDimensions !== undefined ? { embeddingDimensions: dto.embeddingDimensions } : {}),
        ...(dto.providerConnectionId !== undefined ? { providerConnectionId: dto.providerConnectionId } : {}),
        ...(dto.enableAutoCapture !== undefined ? { enableAutoCapture: dto.enableAutoCapture } : {}),
        ...(dto.enableChatInjection !== undefined ? { enableChatInjection: dto.enableChatInjection } : {}),
        ...(dto.enableSwarmInjection !== undefined ? { enableSwarmInjection: dto.enableSwarmInjection } : {}),
        ...(dto.defaultTopK !== undefined ? { defaultTopK: dto.defaultTopK } : {}),
        ...(dto.minSimilarityScore !== undefined ? { minSimilarityScore: dto.minSimilarityScore } : {}),
        ...(dto.retentionDays !== undefined ? { retentionDays: dto.retentionDays } : {}),
      },
    });

    return {
      ...updated,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  private async resolveEmbeddingTarget(workspaceId: string): Promise<ResolvedEmbeddingTarget | null> {
    const settings = await this.getOrCreateSettingsInternal(workspaceId);

    if (this.deps.embedTextFn) {
      const provider = (settings.embeddingProvider as SupportedProviderId) || "openai";
      return {
        provider,
        model: settings.embeddingModel || EmbeddingService.getDefaultModel(provider),
        dimensions: settings.embeddingDimensions || MEMORY_CONSTANTS.DEFAULT_EMBEDDING_DIMENSIONS,
      };
    }

    if (!this.deps.decryptProviderSecret) {
      return null;
    }

    let connection = null;
    if (settings.providerConnectionId) {
      connection = await prisma.providerConnection.findFirst({
        where: {
          id: settings.providerConnectionId,
          workspaceId,
          status: "ACTIVE",
        },
        include: { credential: true },
      });
    }

    if (!connection) {
      const preferredProviders: SupportedProviderId[] = settings.embeddingProvider
        ? [settings.embeddingProvider as SupportedProviderId]
        : ["openai", "gemini"];

      for (const p of preferredProviders) {
        if (!EmbeddingService.supportsEmbeddings(p)) continue;
        connection = await prisma.providerConnection.findFirst({
          where: { workspaceId, provider: p, status: "ACTIVE" },
          include: { credential: true },
          orderBy: { createdAt: "desc" },
        });
        if (connection?.credential) break;
      }
    }

    if (!connection?.credential) {
      return null;
    }

    const provider = connection.provider as SupportedProviderId;
    if (!EmbeddingService.supportsEmbeddings(provider)) {
      return null;
    }

    const apiKey = this.deps.decryptProviderSecret({
      ciphertext: connection.credential.ciphertext,
      initializationVector: connection.credential.initializationVector,
      authenticationTag: connection.credential.authenticationTag,
      keyVersion: connection.credential.keyVersion,
      providerConnectionId: connection.id,
      workspaceId,
      provider,
    });

    const defaultModel = EmbeddingService.getDefaultModel(provider);
    const defaultDim = provider === "gemini" ? 768 : MEMORY_CONSTANTS.DEFAULT_EMBEDDING_DIMENSIONS;

    return {
      provider,
      model: settings.embeddingModel || defaultModel,
      dimensions: settings.embeddingDimensions || defaultDim,
      apiKey,
      providerConnectionId: connection.id,
    };
  }

  private async generateVectors(
    target: ResolvedEmbeddingTarget,
    texts: string[]
  ): Promise<{ embeddings: number[][]; dimensions: number; model: string }> {
    if (this.deps.embedTextFn) {
      const res = await this.deps.embedTextFn({
        provider: target.provider,
        model: target.model,
        dimensions: target.dimensions,
        texts,
        apiKey: target.apiKey,
      });
      return {
        embeddings: res.embeddings,
        dimensions: res.dimensions,
        model: res.model,
      };
    }

    if (!target.apiKey) {
      throw new MemoryServiceError(400, "MISSING_EMBEDDING_KEY", "Embedding API key is missing.");
    }

    const res = await EmbeddingService.embedTexts({
      provider: target.provider,
      credentials: { apiKey: target.apiKey },
      texts,
      model: target.model,
      dimensions: target.dimensions,
    });

    return {
      embeddings: res.embeddings,
      dimensions: res.dimensions,
      model: res.model,
    };
  }

  private async upsertEmbeddingVector(params: {
    memoryId: string;
    workspaceId: string;
    contentHash: string;
    provider: string;
    model: string;
    dimensions: number;
    vector: number[];
  }): Promise<void> {
    const vectorLiteral = serializeVectorLiteral(params.vector);
    const id = crypto.randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "memory_embeddings" (
         "id", "memory_id", "workspace_id", "embedding_model", "embedding_provider",
         "embedding_dimensions", "embedding", "content_hash", "status", "last_error",
         "created_at", "updated_at"
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5,
         $6::integer, $7::vector, $8, 'READY', NULL,
         NOW(), NOW()
       )
       ON CONFLICT ("memory_id") DO UPDATE SET
         "embedding_model" = EXCLUDED."embedding_model",
         "embedding_provider" = EXCLUDED."embedding_provider",
         "embedding_dimensions" = EXCLUDED."embedding_dimensions",
         "embedding" = EXCLUDED."embedding",
         "content_hash" = EXCLUDED."content_hash",
         "status" = 'READY',
         "last_error" = NULL,
         "updated_at" = NOW()`,
      id,
      params.memoryId,
      params.workspaceId,
      params.model,
      params.provider,
      params.dimensions,
      vectorLiteral,
      params.contentHash
    );
  }

  public async embedMemoryRow(
    memoryId: string,
    workspaceId: string,
    title: string,
    content: string,
    contentHash: string
  ): Promise<boolean> {
    const target = await this.resolveEmbeddingTarget(workspaceId);
    if (!target) {
      return false;
    }

    try {
      const textToEmbed = `${title.trim()}\n\n${content.trim()}`.slice(0, 8000);
      const res = await this.generateVectors(target, [textToEmbed]);
      const vec = res.embeddings[0];
      if (!vec || vec.length === 0) return false;

      await this.upsertEmbeddingVector({
        memoryId,
        workspaceId,
        contentHash,
        provider: target.provider,
        model: res.model,
        dimensions: vec.length,
        vector: vec,
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 500) : "Embedding generation failed";
      await prisma.memoryEmbedding.upsert({
        where: { memoryId },
        create: {
          memoryId,
          workspaceId,
          embeddingModel: target.model,
          embeddingProvider: target.provider,
          embeddingDimensions: target.dimensions,
          contentHash,
          status: "FAILED",
          lastError: msg,
        },
        update: {
          embeddingModel: target.model,
          embeddingProvider: target.provider,
          embeddingDimensions: target.dimensions,
          contentHash,
          status: "FAILED",
          lastError: msg,
        },
      });
      return false;
    }
  }

  public async createCollection(
    userId: string,
    dto: CreateMemoryCollectionDto
  ): Promise<MemoryCollectionInfo> {
    const role = await this.assertMember(dto.workspaceId, userId);
    this.assertCanWriteScope(role, dto.scope);

    if (dto.scope === "AGENT") {
      if (!dto.agentId) {
        throw new MemoryServiceError(422, "AGENT_ID_REQUIRED", "agentId is required for AGENT scoped collections.");
      }
      const agent = await prisma.agentDefinition.findFirst({
        where: { id: dto.agentId, workspaceId: dto.workspaceId },
      });
      if (!agent) {
        throw new MemoryServiceError(404, "AGENT_NOT_FOUND", "Target agent not found in workspace.");
      }
    }

    const baseSlug = slugifyName(dto.name);
    let slug = baseSlug;
    let suffix = 1;
    while (await prisma.memoryCollection.findUnique({ where: { workspaceId_slug: { workspaceId: dto.workspaceId, slug } } })) {
      suffix++;
      slug = `${baseSlug}-${suffix}`;
    }

    const col = await prisma.memoryCollection.create({
      data: {
        workspaceId: dto.workspaceId,
        scope: dto.scope,
        ownerUserId: dto.scope === "PERSONAL" ? userId : null,
        agentId: dto.scope === "AGENT" ? dto.agentId || null : null,
        name: dto.name,
        slug,
        description: dto.description || null,
        createdByUserId: userId,
      },
    });

    return {
      ...col,
      memoryCount: 0,
      createdAt: col.createdAt.toISOString(),
      updatedAt: col.updatedAt.toISOString(),
    };
  }

  public async listCollections(
    workspaceId: string,
    userId: string,
    scope?: MemoryScope
  ): Promise<MemoryCollectionInfo[]> {
    await this.assertMember(workspaceId, userId);
    const cols = await prisma.memoryCollection.findMany({
      where: {
        workspaceId,
        ...(scope ? { scope } : {}),
        OR: [
          { scope: "WORKSPACE" },
          { scope: "AGENT" },
          { scope: "PERSONAL", ownerUserId: userId },
        ],
      },
      include: { _count: { select: { memories: true } } },
      orderBy: { createdAt: "desc" },
    });

    return cols.map((c) => ({
      id: c.id,
      workspaceId: c.workspaceId,
      scope: c.scope,
      ownerUserId: c.ownerUserId,
      agentId: c.agentId,
      name: c.name,
      slug: c.slug,
      description: c.description,
      memoryCount: c._count.memories,
      createdByUserId: c.createdByUserId,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }));
  }

  public async deleteCollection(collectionId: string, workspaceId: string, userId: string): Promise<void> {
    const role = await this.assertMember(workspaceId, userId);
    const col = await prisma.memoryCollection.findUnique({ where: { id: collectionId } });
    if (!col || col.workspaceId !== workspaceId) {
      throw new MemoryServiceError(404, "COLLECTION_NOT_FOUND", "Collection not found.");
    }
    if (col.scope === "PERSONAL" && col.ownerUserId !== userId) {
      throw new MemoryServiceError(403, "FORBIDDEN", "Cannot delete another user's personal collection.");
    }
    if (col.scope !== "PERSONAL" && role !== "OWNER" && role !== "ADMIN" && col.createdByUserId !== userId) {
      throw new MemoryServiceError(403, "FORBIDDEN", "Insufficient permissions to delete this collection.");
    }
    await prisma.memoryCollection.delete({ where: { id: collectionId } });
  }

  public async createMemory(
    userId: string | null,
    dto: CreateMemoryDto,
    options?: {
      bypassMembershipCheck?: boolean;
      upsertByTitle?: boolean;
      redactInsteadOfReject?: boolean;
    }
  ): Promise<MemoryInfo> {
    if (!options?.bypassMembershipCheck) {
      if (!userId) {
        throw new MemoryServiceError(401, "UNAUTHORIZED", "User context is required.");
      }
      const role = await this.assertMember(dto.workspaceId, userId);
      this.assertCanWriteScope(role, dto.scope);
    }

    if (dto.scope === "PERSONAL" && !userId) {
      throw new MemoryServiceError(422, "OWNER_REQUIRED", "PERSONAL memories require an owner user.");
    }

    if (dto.scope === "AGENT") {
      if (!dto.agentId) {
        throw new MemoryServiceError(422, "AGENT_ID_REQUIRED", "agentId is required for AGENT scoped memory.");
      }
      const agent = await prisma.agentDefinition.findFirst({
        where: { id: dto.agentId, workspaceId: dto.workspaceId },
      });
      if (!agent) {
        throw new MemoryServiceError(404, "AGENT_NOT_FOUND", "Target agent not found in workspace.");
      }
    }

    if (dto.collectionId) {
      const col = await prisma.memoryCollection.findUnique({ where: { id: dto.collectionId } });
      if (!col || col.workspaceId !== dto.workspaceId) {
        throw new MemoryServiceError(404, "COLLECTION_NOT_FOUND", "Memory collection not found in workspace.");
      }
      if (col.scope === "PERSONAL" && col.ownerUserId !== userId) {
        throw new MemoryServiceError(403, "FORBIDDEN", "Cannot store memories into another user's personal collection.");
      }
    }

    // Secret / Credential Security Guard
    let title = dto.title.trim();
    let content = dto.content.trim();
    let summary = dto.summary ? dto.summary.trim() : null;
    let sensitivity: MemorySensitivity =
      dto.scope === "PERSONAL"
        ? "PERSONAL_PRIVATE"
        : dto.scope === "AGENT"
        ? "AGENT_RESTRICTED"
        : "PUBLIC_WORKSPACE";

    const detected = MemorySanitizer.detectSecrets(`${title}\n${content}\n${summary || ""}`);
    if (detected.length > 0) {
      if (!options?.redactInsteadOfReject) {
        throw new MemoryServiceError(
          422,
          "MEMORY_SECRET_REJECTED",
          `Refused to persist secret or credential material (${detected.join(", ")}) in long-term memory.`
        );
      }
      title = MemorySanitizer.scrubSecrets(title).scrubbed;
      content = MemorySanitizer.scrubSecrets(content).scrubbed;
      summary = summary ? MemorySanitizer.scrubSecrets(summary).scrubbed : null;
      sensitivity = "SENSITIVE_REDACTED";
    }

    const contentHash = MemorySanitizer.computeContentHash(content);
    const ownerUserId = dto.scope === "PERSONAL" ? userId : null;
    const agentId = dto.scope === "AGENT" ? dto.agentId || null : null;

    // Deduplicate exact active memory in same partition
    const exactExisting = await prisma.memory.findFirst({
      where: {
        workspaceId: dto.workspaceId,
        scope: dto.scope,
        ownerUserId,
        agentId,
        contentHash,
        isArchived: false,
      },
      include: {
        agent: { select: { name: true } },
        collection: { select: { name: true } },
        embedding: {
          select: { status: true, embeddingModel: true, embeddingDimensions: true },
        },
        versions: { orderBy: { versionNumber: "desc" } },
      },
    });
    if (exactExisting) {
      return mapMemoryRowToInfo(exactExisting);
    }

    // Optional conflict resolution by identical title in same partition -> append version history cleanly
    if (options?.upsertByTitle) {
      const sameTitleExisting = await prisma.memory.findFirst({
        where: {
          workspaceId: dto.workspaceId,
          scope: dto.scope,
          ownerUserId,
          agentId,
          title,
          isArchived: false,
        },
      });
      if (sameTitleExisting) {
        return this.updateMemoryInternal(sameTitleExisting.id, userId, {
          workspaceId: dto.workspaceId,
          title,
          content,
          summary,
          tags: dto.tags,
          importance: dto.importance,
          changeReason: "Updated from latest execution output",
        });
      }
    }

    const settings = await this.getOrCreateSettingsInternal(dto.workspaceId);
    let expiresAt: Date | null = dto.expiresAt ? new Date(dto.expiresAt) : null;
    if (!expiresAt && settings.retentionDays && settings.retentionDays > 0) {
      expiresAt = new Date(Date.now() + settings.retentionDays * 24 * 60 * 60 * 1000);
    }

    const created = await prisma.$transaction(async (tx) => {
      const m = await tx.memory.create({
        data: {
          workspaceId: dto.workspaceId,
          scope: dto.scope,
          ownerUserId,
          agentId,
          collectionId: dto.collectionId || null,
          sourceType: (dto.sourceType || "MANUAL") as MemorySourceType,
          sourceThreadId: dto.sourceThreadId || null,
          sourceMessageId: dto.sourceMessageId || null,
          sourceAgentRunId: dto.sourceAgentRunId || null,
          sourceWorkflowRunId: dto.sourceWorkflowRunId || null,
          title,
          content,
          summary,
          contentHash,
          tags: dto.tags || [],
          metadata: (dto.metadata || {}) as Prisma.InputJsonValue,
          importance: dto.importance ?? 0.6,
          sensitivity,
          isPinned: Boolean(dto.isPinned),
          currentVersion: 1,
          expiresAt,
          createdByUserId: userId,
        },
      });

      await tx.memoryVersion.create({
        data: {
          memoryId: m.id,
          workspaceId: dto.workspaceId,
          versionNumber: 1,
          title,
          content,
          contentHash,
          changeReason: "Initial memory creation",
          editedByUserId: userId,
        },
      });

      return m;
    });

    if (dto.embedImmediately !== false) {
      await this.embedMemoryRow(created.id, dto.workspaceId, title, content, contentHash);
    }

    return this.getMemoryInternal(created.id);
  }

  public async getMemory(memoryId: string, workspaceId: string, userId: string): Promise<MemoryInfo> {
    await this.assertMember(workspaceId, userId);
    const m = await prisma.memory.findUnique({
      where: { id: memoryId },
      include: {
        agent: { select: { name: true } },
        collection: { select: { name: true } },
        embedding: {
          select: { status: true, embeddingModel: true, embeddingDimensions: true },
        },
        versions: { orderBy: { versionNumber: "desc" } },
      },
    });
    if (!m || m.workspaceId !== workspaceId) {
      throw new MemoryServiceError(404, "MEMORY_NOT_FOUND", "Memory entry not found.");
    }
    if (m.scope === "PERSONAL" && m.ownerUserId !== userId) {
      throw new MemoryServiceError(404, "MEMORY_NOT_FOUND", "Memory entry not found.");
    }
    return mapMemoryRowToInfo(m);
  }

  private async getMemoryInternal(memoryId: string): Promise<MemoryInfo> {
    const m = await prisma.memory.findUniqueOrThrow({
      where: { id: memoryId },
      include: {
        agent: { select: { name: true } },
        collection: { select: { name: true } },
        embedding: {
          select: { status: true, embeddingModel: true, embeddingDimensions: true },
        },
        versions: { orderBy: { versionNumber: "desc" } },
      },
    });
    return mapMemoryRowToInfo(m);
  }

  public async listMemories(params: {
    workspaceId: string;
    userId: string;
    scope?: MemoryScope;
    agentId?: string;
    collectionId?: string;
    search?: string;
    includeArchived?: boolean;
    limit?: number;
  }): Promise<MemoryInfo[]> {
    await this.assertMember(params.workspaceId, params.userId);

    const scopeFilter: Prisma.MemoryWhereInput = params.scope
      ? params.scope === "PERSONAL"
        ? { scope: "PERSONAL", ownerUserId: params.userId }
        : params.scope === "AGENT"
        ? { scope: "AGENT", ...(params.agentId ? { agentId: params.agentId } : {}) }
        : { scope: "WORKSPACE" }
      : {
          OR: [
            { scope: "WORKSPACE" },
            { scope: "AGENT", ...(params.agentId ? { agentId: params.agentId } : {}) },
            { scope: "PERSONAL", ownerUserId: params.userId },
          ],
        };

    const rows = await prisma.memory.findMany({
      where: {
        workspaceId: params.workspaceId,
        ...scopeFilter,
        ...(params.collectionId ? { collectionId: params.collectionId } : {}),
        ...(params.includeArchived ? {} : { isArchived: false }),
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        ...(params.search
          ? {
              AND: [
                {
                  OR: [
                    { title: { contains: params.search, mode: "insensitive" } },
                    { content: { contains: params.search, mode: "insensitive" } },
                  ],
                },
              ],
            }
          : {}),
      },
      include: {
        agent: { select: { name: true } },
        collection: { select: { name: true } },
        embedding: {
          select: { status: true, embeddingModel: true, embeddingDimensions: true },
        },
      },
      orderBy: [{ isPinned: "desc" }, { updatedAt: "desc" }],
      take: Math.min(params.limit || 100, 200),
    });

    return rows.map(mapMemoryRowToInfo);
  }

  public async updateMemory(
    memoryId: string,
    userId: string,
    dto: UpdateMemoryDto
  ): Promise<MemoryInfo> {
    const role = await this.assertMember(dto.workspaceId, userId);
    const existing = await prisma.memory.findUnique({ where: { id: memoryId } });
    if (!existing || existing.workspaceId !== dto.workspaceId) {
      throw new MemoryServiceError(404, "MEMORY_NOT_FOUND", "Memory entry not found.");
    }
    if (existing.scope === "PERSONAL" && existing.ownerUserId !== userId) {
      throw new MemoryServiceError(404, "MEMORY_NOT_FOUND", "Memory entry not found.");
    }
    this.assertCanWriteScope(role, existing.scope as MemoryScope);

    return this.updateMemoryInternal(memoryId, userId, dto);
  }

  private async updateMemoryInternal(
    memoryId: string,
    userId: string | null,
    dto: UpdateMemoryDto
  ): Promise<MemoryInfo> {
    const existing = await prisma.memory.findUniqueOrThrow({ where: { id: memoryId } });

    const nextTitle = dto.title !== undefined ? dto.title.trim() : existing.title;
    const nextContent = dto.content !== undefined ? dto.content.trim() : existing.content;
    const nextSummary = dto.summary !== undefined ? (dto.summary ? dto.summary.trim() : null) : existing.summary;

    const detected = MemorySanitizer.detectSecrets(`${nextTitle}\n${nextContent}\n${nextSummary || ""}`);
    if (detected.length > 0) {
      throw new MemoryServiceError(
        422,
        "MEMORY_SECRET_REJECTED",
        `Refused to persist secret or credential material (${detected.join(", ")}).`
      );
    }

    const nextHash = MemorySanitizer.computeContentHash(nextContent);
    const contentChanged = nextHash !== existing.contentHash || nextTitle !== existing.title;
    const nextVersion = contentChanged ? existing.currentVersion + 1 : existing.currentVersion;

    await prisma.$transaction(async (tx) => {
      await tx.memory.update({
        where: { id: memoryId },
        data: {
          title: nextTitle,
          content: nextContent,
          summary: nextSummary,
          contentHash: nextHash,
          ...(dto.collectionId !== undefined ? { collectionId: dto.collectionId } : {}),
          ...(dto.tags !== undefined ? { tags: dto.tags } : {}),
          ...(dto.importance !== undefined ? { importance: dto.importance } : {}),
          ...(dto.isPinned !== undefined ? { isPinned: dto.isPinned } : {}),
          ...(dto.isArchived !== undefined ? { isArchived: dto.isArchived } : {}),
          ...(dto.expiresAt !== undefined
            ? { expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null }
            : {}),
          currentVersion: nextVersion,
        },
      });

      if (contentChanged) {
        await tx.memoryVersion.create({
          data: {
            memoryId,
            workspaceId: existing.workspaceId,
            versionNumber: nextVersion,
            title: nextTitle,
            content: nextContent,
            contentHash: nextHash,
            changeReason: dto.changeReason || "Edited memory content",
            editedByUserId: userId,
          },
        });
      }
    });

    if (contentChanged) {
      await this.embedMemoryRow(memoryId, existing.workspaceId, nextTitle, nextContent, nextHash);
    }

    return this.getMemoryInternal(memoryId);
  }

  public async deleteMemory(memoryId: string, workspaceId: string, userId: string): Promise<void> {
    const role = await this.assertMember(workspaceId, userId);
    const existing = await prisma.memory.findUnique({ where: { id: memoryId } });
    if (!existing || existing.workspaceId !== workspaceId) {
      throw new MemoryServiceError(404, "MEMORY_NOT_FOUND", "Memory entry not found.");
    }
    if (existing.scope === "PERSONAL" && existing.ownerUserId !== userId) {
      throw new MemoryServiceError(404, "MEMORY_NOT_FOUND", "Memory entry not found.");
    }
    if (
      existing.scope !== "PERSONAL" &&
      role !== "OWNER" &&
      role !== "ADMIN" &&
      existing.createdByUserId !== userId
    ) {
      throw new MemoryServiceError(403, "FORBIDDEN", "Insufficient permissions to delete this workspace/agent memory.");
    }
    await prisma.memory.delete({ where: { id: memoryId } });
  }

  public async clearMemories(userId: string, dto: ClearMemoriesDto): Promise<{ deletedCount: number }> {
    const role = await this.assertMember(dto.workspaceId, userId);

    if (dto.scope === "PERSONAL" || (!dto.scope && role !== "OWNER" && role !== "ADMIN")) {
      const res = await prisma.memory.deleteMany({
        where: {
          workspaceId: dto.workspaceId,
          scope: "PERSONAL",
          ownerUserId: userId,
          ...(dto.collectionId ? { collectionId: dto.collectionId } : {}),
        },
      });
      return { deletedCount: res.count };
    }

    if (role !== "OWNER" && role !== "ADMIN") {
      throw new MemoryServiceError(
        403,
        "FORBIDDEN_ROLE",
        "Only workspace OWNER or ADMIN can clear workspace or agent memories."
      );
    }

    const res = await prisma.memory.deleteMany({
      where: {
        workspaceId: dto.workspaceId,
        ...(dto.scope ? { scope: dto.scope } : {}),
        ...(dto.agentId ? { agentId: dto.agentId } : {}),
        ...(dto.collectionId ? { collectionId: dto.collectionId } : {}),
      },
    });
    return { deletedCount: res.count };
  }

  public async reembedWorkspaceMemories(
    userId: string,
    dto: ReembedMemoriesDto
  ): Promise<{ processed: number; succeeded: number; failed: number; mode: string }> {
    const role = await this.assertMember(dto.workspaceId, userId);
    if (role !== "OWNER" && role !== "ADMIN") {
      throw new MemoryServiceError(403, "FORBIDDEN_ROLE", "Only workspace OWNER or ADMIN can re-embed workspace memories.");
    }

    const target = await this.resolveEmbeddingTarget(dto.workspaceId);
    if (!target) {
      throw new MemoryServiceError(
        400,
        "NO_EMBEDDING_PROVIDER",
        "No active OpenAI or Gemini provider connection is configured for embeddings in this workspace."
      );
    }

    const memories = await prisma.memory.findMany({
      where: {
        workspaceId: dto.workspaceId,
        isArchived: false,
      },
      include: { embedding: true },
    });

    const candidates = dto.forceAll
      ? memories
      : memories.filter(
          (m) =>
            !m.embedding ||
            m.embedding.status !== "READY" ||
            m.embedding.embeddingModel !== target.model ||
            m.embedding.embeddingDimensions !== target.dimensions
        );

    let succeeded = 0;
    let failed = 0;
    const chunkSize = 16;

    for (let i = 0; i < candidates.length; i += chunkSize) {
      const slice = candidates.slice(i, i + chunkSize);
      const texts = slice.map((m) => `${m.title.trim()}\n\n${m.content.trim()}`.slice(0, 8000));
      try {
        const res = await this.generateVectors(target, texts);
        for (let idx = 0; idx < slice.length; idx++) {
          const item = slice[idx];
          const vec = res.embeddings[idx];
          if (!item || !vec || vec.length === 0) {
            failed++;
            continue;
          }
          await this.upsertEmbeddingVector({
            memoryId: item.id,
            workspaceId: dto.workspaceId,
            contentHash: item.contentHash,
            provider: target.provider,
            model: res.model,
            dimensions: vec.length,
            vector: vec,
          });
          succeeded++;
        }
      } catch {
        failed += slice.length;
      }
    }

    return {
      processed: candidates.length,
      succeeded,
      failed,
      mode: `${target.provider}/${target.model} (${target.dimensions}d)`,
    };
  }

  /**
   * Hybrid vector + lexical memory retrieval enforcing strict SQL-level tenant/owner/agent
   * isolation BEFORE any similarity scoring, ordering, or top-K slicing.
   */
  public async searchMemories(
    params: SearchMemoryDto & {
      userId: string;
      enforceStrictAgentScope?: boolean;
      bypassMembershipCheck?: boolean;
    }
  ): Promise<MemorySearchResponse> {
    if (!params.bypassMembershipCheck) {
      await this.assertMember(params.workspaceId, params.userId);
    }

    const scopes = Array.from(new Set(params.scopes || ["PERSONAL", "WORKSPACE"]));
    const topK = Math.max(1, Math.min(params.topK || 6, 25));
    const minSimilarity = Math.max(0, Math.min(params.minSimilarity ?? 0.15, 1));

    // Construct strictly parameterized authorization WHERE clauses evaluated BEFORE ranking
    const scopeClauses: string[] = [];
    const sqlParams: unknown[] = [params.workspaceId, params.userId, params.query];

    if (scopes.includes("WORKSPACE")) {
      scopeClauses.push(`m."scope" = 'WORKSPACE'::"MemoryScope"`);
    }
    if (scopes.includes("PERSONAL")) {
      scopeClauses.push(`(m."scope" = 'PERSONAL'::"MemoryScope" AND m."owner_user_id" = $2::uuid)`);
    }
    if (scopes.includes("AGENT")) {
      if (params.agentIds && params.agentIds.length > 0) {
        const idx = sqlParams.length + 1;
        sqlParams.push(params.agentIds);
        scopeClauses.push(`(m."scope" = 'AGENT'::"MemoryScope" AND m."agent_id" = ANY($${idx}::uuid[]))`);
      } else if (!params.enforceStrictAgentScope) {
        scopeClauses.push(`m."scope" = 'AGENT'::"MemoryScope"`);
      }
    }

    if (scopeClauses.length === 0) {
      return {
        query: params.query,
        mode: "lexical_fallback",
        embeddingProvider: null,
        embeddingModel: null,
        matches: [],
      };
    }

    let collectionFilter = "";
    if (params.collectionId) {
      const idx = sqlParams.length + 1;
      sqlParams.push(params.collectionId);
      collectionFilter = `AND m."collection_id" = $${idx}::uuid`;
    }

    const archivedFilter = params.includeArchived ? "" : `AND m."is_archived" = false`;

    const baseWhere = `
      m."workspace_id" = $1::uuid
      ${archivedFilter}
      ${collectionFilter}
      AND (m."expires_at" IS NULL OR m."expires_at" > NOW())
      AND (${scopeClauses.join(" OR ")})
      AND NOT EXISTS (
        SELECT 1 FROM "memory_access_policies" map
        WHERE map."workspace_id" = m."workspace_id"
          AND (map."memory_id" = m."id" OR map."collection_id" = m."collection_id")
          AND map."can_read" = false
          AND map."principal_type" = 'USER'
          AND map."principal_id" = $2
      )
    `;

    const readyVectorCount = await prisma.memoryEmbedding.count({
      where: { workspaceId: params.workspaceId, status: "READY" },
    });

    const target =
      readyVectorCount > 0
        ? await this.resolveEmbeddingTarget(params.workspaceId)
        : null;
    let queryVector: number[] | null = null;
    let usedModel: string | null = null;
    let usedProvider: string | null = null;

    if (target) {
      try {
        const vecRes = await this.generateVectors(target, [params.query]);
        if (vecRes.embeddings[0] && vecRes.embeddings[0].length > 0) {
          queryVector = vecRes.embeddings[0];
          usedModel = vecRes.model;
          usedProvider = target.provider;
        }
      } catch {
        // Gracefully degrade to lexical PostgreSQL search without interrupting chat or workflows
        queryVector = null;
      }
    }

    const matches: MemorySearchMatch[] = [];
    let mode: "vector" | "hybrid" | "lexical_fallback" = "lexical_fallback";

    if (queryVector) {
      const dims = queryVector.length;
      if (!Number.isInteger(dims) || dims < 64 || dims > 3072) {
        throw new MemoryServiceError(400, "INVALID_VECTOR_DIMENSIONS", "Unsupported embedding vector dimensionality.");
      }

      const vecLiteral = serializeVectorLiteral(queryVector);
      const vecParamIdx = sqlParams.length + 1;
      sqlParams.push(vecLiteral);
      const dimParamIdx = sqlParams.length + 1;
      sqlParams.push(dims);
      const limitParamIdx = sqlParams.length + 1;
      sqlParams.push(topK);

      // Leverage HNSW expression casts when dimensions match 1536 or 768
      const vecExpr =
        dims === 1536
          ? `(me."embedding"::vector(1536) <=> $${vecParamIdx}::vector(1536))`
          : dims === 768
          ? `(me."embedding"::vector(768) <=> $${vecParamIdx}::vector(768))`
          : `(me."embedding" <=> $${vecParamIdx}::vector)`;

      const vectorRows = (await prisma.$queryRawUnsafe(
        `
        SELECT
          m.*,
          m."owner_user_id" AS "ownerUserId",
          m."agent_id" AS "agentId",
          m."collection_id" AS "collectionId",
          m."source_type" AS "sourceType",
          m."source_thread_id" AS "sourceThreadId",
          m."source_message_id" AS "sourceMessageId",
          m."source_agent_run_id" AS "sourceAgentRunId",
          m."source_workflow_run_id" AS "sourceWorkflowRunId",
          m."content_hash" AS "contentHash",
          m."is_pinned" AS "isPinned",
          m."is_archived" AS "isArchived",
          m."current_version" AS "currentVersion",
          m."access_count" AS "accessCount",
          m."last_accessed_at" AS "lastAccessedAt",
          m."expires_at" AS "expiresAt",
          m."created_by_user_id" AS "createdByUserId",
          m."created_at" AS "createdAt",
          m."updated_at" AS "updatedAt",
          m."workspace_id" AS "workspaceId",
          ag."name" AS "agentName",
          col."name" AS "collectionName",
          me."status" AS "embeddingStatus",
          me."embedding_model" AS "embeddingModel",
          me."embedding_dimensions" AS "embeddingDimensions",
          GREATEST(0.0, 1.0 - ${vecExpr}) AS "semanticScore",
          ts_rank_cd(
            to_tsvector('english', coalesce(m."title", '') || ' ' || coalesce(m."content", '')),
            plainto_tsquery('english', $3)
          ) AS "lexicalScore"
        FROM "memories" m
        INNER JOIN "memory_embeddings" me
          ON me."memory_id" = m."id"
         AND me."status" = 'READY'
         AND me."embedding_dimensions" = $${dimParamIdx}::integer
         AND me."embedding" IS NOT NULL
        LEFT JOIN "agent_definitions" ag ON ag."id" = m."agent_id"
        LEFT JOIN "memory_collections" col ON col."id" = m."collection_id"
        WHERE ${baseWhere}
        ORDER BY ${vecExpr} ASC
        LIMIT $${limitParamIdx}::integer
        `,
        ...sqlParams
      )) as any[];

      for (const r of vectorRows) {
        const semanticScore = Math.max(0, Math.min(1, Number(r.semanticScore || 0)));
        const lexicalScore = Math.max(0, Math.min(1, Number(r.lexicalScore || 0)));
        const blended = Math.min(
          1,
          semanticScore * 0.78 +
            lexicalScore * 0.14 +
            (r.isPinned ? 0.08 : 0) +
            Number(r.importance || 0) * 0.08
        );
        if (semanticScore >= minSimilarity || lexicalScore > 0.01 || r.isPinned) {
          matches.push({
            memory: mapMemoryRowToInfo(r),
            score: Number(blended.toFixed(4)),
            semanticScore: Number(semanticScore.toFixed(4)),
            lexicalScore: Number(lexicalScore.toFixed(4)),
            matchMode: lexicalScore > 0 ? "hybrid" : "vector",
          });
        }
      }

      if (matches.length > 0) {
        mode = matches.some((m) => m.matchMode === "hybrid") ? "hybrid" : "vector";
      }
    }

    // Lexical fallback / augmentation if fewer than topK matches found via vector index
    if (matches.length < topK) {
      const existingIds = new Set(matches.map((m) => m.memory.id));
      const lexRows = await this.executeLexicalQuery({
        workspaceId: params.workspaceId,
        userId: params.userId,
        query: params.query,
        scopes,
        agentIds: params.agentIds,
        enforceStrictAgentScope: Boolean(params.enforceStrictAgentScope),
        collectionId: params.collectionId || undefined,
        includeArchived: Boolean(params.includeArchived),
        limit: topK,
      });

      for (const lr of lexRows) {
        if (existingIds.has(lr.memory.id)) continue;
        matches.push(lr);
        if (matches.length >= topK) break;
      }
    }

    matches.sort((a, b) => b.score - a.score);
    const topMatches = matches.slice(0, topK);

    // Record retrieval access counts cleanly
    const ids = topMatches.map((m) => m.memory.id);
    if (ids.length > 0) {
      await prisma.memory
        .updateMany({
          where: { id: { in: ids } },
          data: { accessCount: { increment: 1 }, lastAccessedAt: new Date() },
        })
        .catch(() => {});
    }

    return {
      query: params.query,
      mode: topMatches.some((m) => m.matchMode !== "lexical_fallback") ? mode : "lexical_fallback",
      embeddingProvider: usedProvider,
      embeddingModel: usedModel,
      matches: topMatches,
    };
  }

  private async executeLexicalQuery(params: {
    workspaceId: string;
    userId: string;
    query: string;
    scopes: MemoryScope[];
    agentIds?: string[];
    enforceStrictAgentScope: boolean;
    collectionId?: string;
    includeArchived: boolean;
    limit: number;
  }): Promise<MemorySearchMatch[]> {
    const sqlParams: unknown[] = [params.workspaceId, params.userId, params.query];
    const scopeClauses: string[] = [];

    if (params.scopes.includes("WORKSPACE")) {
      scopeClauses.push(`m."scope" = 'WORKSPACE'::"MemoryScope"`);
    }
    if (params.scopes.includes("PERSONAL")) {
      scopeClauses.push(`(m."scope" = 'PERSONAL'::"MemoryScope" AND m."owner_user_id" = $2::uuid)`);
    }
    if (params.scopes.includes("AGENT")) {
      if (params.agentIds && params.agentIds.length > 0) {
        const idx = sqlParams.length + 1;
        sqlParams.push(params.agentIds);
        scopeClauses.push(`(m."scope" = 'AGENT'::"MemoryScope" AND m."agent_id" = ANY($${idx}::uuid[]))`);
      } else if (!params.enforceStrictAgentScope) {
        scopeClauses.push(`m."scope" = 'AGENT'::"MemoryScope"`);
      }
    }

    if (scopeClauses.length === 0) return [];

    let collectionFilter = "";
    if (params.collectionId) {
      const idx = sqlParams.length + 1;
      sqlParams.push(params.collectionId);
      collectionFilter = `AND m."collection_id" = $${idx}::uuid`;
    }

    // Build safe wildcard LIKE pattern for fallback token matching
    const cleanTokens = params.query
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.replace(/[^a-z0-9_-]/g, ""))
      .filter((t) => t.length >= 2)
      .slice(0, 6);

    const ilikeClauses: string[] = [];
    for (const tok of cleanTokens) {
      const idx = sqlParams.length + 1;
      sqlParams.push(`%${tok}%`);
      ilikeClauses.push(`(m."title" ILIKE $${idx} OR m."content" ILIKE $${idx} OR array_to_string(m."tags", ' ') ILIKE $${idx})`);
    }

    const tokenMatchSql =
      ilikeClauses.length > 0 ? ilikeClauses.join(" OR ") : "TRUE";

    const limitIdx = sqlParams.length + 1;
    sqlParams.push(params.limit);

    const rows = (await prisma.$queryRawUnsafe(
      `
      SELECT
        m.*,
        m."owner_user_id" AS "ownerUserId",
        m."agent_id" AS "agentId",
        m."collection_id" AS "collectionId",
        m."source_type" AS "sourceType",
        m."source_thread_id" AS "sourceThreadId",
        m."source_message_id" AS "sourceMessageId",
        m."source_agent_run_id" AS "sourceAgentRunId",
        m."source_workflow_run_id" AS "sourceWorkflowRunId",
        m."content_hash" AS "contentHash",
        m."is_pinned" AS "isPinned",
        m."is_archived" AS "isArchived",
        m."current_version" AS "currentVersion",
        m."access_count" AS "accessCount",
        m."last_accessed_at" AS "lastAccessedAt",
        m."expires_at" AS "expiresAt",
        m."created_by_user_id" AS "createdByUserId",
        m."created_at" AS "createdAt",
        m."updated_at" AS "updatedAt",
        m."workspace_id" AS "workspaceId",
        ag."name" AS "agentName",
        col."name" AS "collectionName",
        me."status" AS "embeddingStatus",
        me."embedding_model" AS "embeddingModel",
        me."embedding_dimensions" AS "embeddingDimensions",
        ts_rank_cd(
          to_tsvector('english', coalesce(m."title", '') || ' ' || coalesce(m."content", '')),
          plainto_tsquery('english', $3)
        ) AS "lexicalScore"
      FROM "memories" m
      LEFT JOIN "memory_embeddings" me ON me."memory_id" = m."id"
      LEFT JOIN "agent_definitions" ag ON ag."id" = m."agent_id"
      LEFT JOIN "memory_collections" col ON col."id" = m."collection_id"
      WHERE m."workspace_id" = $1::uuid
        ${params.includeArchived ? "" : `AND m."is_archived" = false`}
        ${collectionFilter}
        AND (m."expires_at" IS NULL OR m."expires_at" > NOW())
        AND (${scopeClauses.join(" OR ")})
        AND (
          to_tsvector('english', coalesce(m."title", '') || ' ' || coalesce(m."content", '')) @@ plainto_tsquery('english', $3)
          OR (${tokenMatchSql})
          OR m."is_pinned" = true
        )
        AND NOT EXISTS (
          SELECT 1 FROM "memory_access_policies" map
          WHERE map."workspace_id" = m."workspace_id"
            AND (map."memory_id" = m."id" OR map."collection_id" = m."collection_id")
            AND map."can_read" = false
            AND map."principal_type" = 'USER'
            AND map."principal_id" = $2
        )
      ORDER BY
        ts_rank_cd(
          to_tsvector('english', coalesce(m."title", '') || ' ' || coalesce(m."content", '')),
          plainto_tsquery('english', $3)
        ) DESC,
        m."is_pinned" DESC,
        m."importance" DESC,
        m."updated_at" DESC
      LIMIT $${limitIdx}::integer
      `,
      ...sqlParams
    )) as any[];

    return rows.map((r) => {
      const tsvScore = Math.max(0, Math.min(1, Number(r.lexicalScore || 0)));
      const textLower = `${r.title} ${r.content}`.toLowerCase();
      let tokenHits = 0;
      for (const tok of cleanTokens) {
        if (textLower.includes(tok)) tokenHits++;
      }
      const tokenRatio = cleanTokens.length > 0 ? tokenHits / cleanTokens.length : 0;
      const lexicalScore = Math.max(tsvScore, tokenRatio * 0.85);
      const total = Math.min(
        1,
        lexicalScore * 0.8 + (r.isPinned ? 0.12 : 0) + Number(r.importance || 0) * 0.08
      );

      return {
        memory: mapMemoryRowToInfo(r),
        score: Number(total.toFixed(4)),
        semanticScore: 0,
        lexicalScore: Number(lexicalScore.toFixed(4)),
        matchMode: "lexical_fallback" as const,
      };
    });
  }

  /**
   * Retrieves authorized memory context formatted safely for Chat or Multi-Agent Swarm injection.
   */
  public async buildPromptMemoryBlock(params: {
    workspaceId: string;
    userId: string;
    query: string;
    scopes: MemoryScope[];
    agentIds?: string[];
    topK?: number;
    channel: "chat" | "swarm" | "workflow";
  }): Promise<{
    contextBlock: string;
    matches: MemorySearchMatch[];
  }> {
    const activeMemoryCount = await prisma.memory.count({
      where: { workspaceId: params.workspaceId, isArchived: false },
    });
    if (activeMemoryCount === 0) {
      return { contextBlock: "", matches: [] };
    }

    const settings = await this.getOrCreateSettingsInternal(params.workspaceId);
    if (params.channel === "chat" && !settings.enableChatInjection) {
      return { contextBlock: "", matches: [] };
    }
    if (params.channel === "swarm" && !settings.enableSwarmInjection) {
      return { contextBlock: "", matches: [] };
    }

    const searchRes = await this.searchMemories({
      workspaceId: params.workspaceId,
      userId: params.userId,
      query: params.query.slice(0, 1500),
      scopes: params.scopes,
      agentIds: params.agentIds,
      topK: params.topK ?? settings.defaultTopK,
      minSimilarity: settings.minSimilarityScore,
      includeArchived: false,
      enforceStrictAgentScope: true,
      bypassMembershipCheck: true,
    });

    if (searchRes.matches.length === 0) {
      return { contextBlock: "", matches: [] };
    }

    return {
      contextBlock: MemorySanitizer.formatUntrustedMemoryContext(searchRes.matches),
      matches: searchRes.matches,
    };
  }
}
