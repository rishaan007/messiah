import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { prisma } from "@messiah/db";
import { MemorySanitizer, MemoryService, MemoryServiceError } from "../index.js";

function makeDeterministicVector(seed: string, dims: number): number[] {
  const vec = new Array<number>(dims).fill(0);
  const s = seed.toLowerCase();
  if (s.includes("postgres") || s.includes("database") || s.includes("pgvector")) {
    vec[0] = 0.9;
    vec[1] = 0.3;
  } else if (s.includes("react") || s.includes("tailwind") || s.includes("frontend")) {
    vec[2] = 0.95;
    vec[3] = 0.25;
  } else {
    vec[4] = 0.85;
  }
  // Tiny hash perturbation for uniqueness
  const hash = crypto.createHash("sha256").update(seed).digest();
  for (let i = 5; i < Math.min(dims, 16); i++) {
    vec[i] = ((hash[i] || 0) / 255) * 0.05;
  }
  const norm = Math.sqrt(vec.reduce((sum, x) => sum + x * x, 0)) || 1;
  return vec.map((x) => x / norm);
}

describe("Phase 6: Vector Memory Engine & Pgvector Isolation", () => {
  const testRunId = crypto.randomUUID().slice(0, 8);
  let workspaceAId = "";
  let workspaceBId = "";
  let userAId = "";
  let userBId = "";
  let agentAId = "";
  let agentBId = "";
  let mockDims = 1536;

  const memoryService = new MemoryService({
    embedTextFn: async ({ texts, dimensions }) => {
      const dims = dimensions || mockDims;
      return {
        provider: "openai",
        model: dims === 768 ? "gemini-embedding-001" : "text-embedding-3-small",
        dimensions: dims,
        embeddings: texts.map((t) => makeDeterministicVector(t, dims)),
        totalTokens: texts.length * 10,
      };
    },
  });

  beforeAll(async () => {
    const uA = await prisma.user.create({
      data: {
        externalId: `ext_mem_a_${testRunId}`,
        email: `mem_a_${testRunId}@test.local`,
        fullName: "Memory Owner A",
      },
    });
    const uB = await prisma.user.create({
      data: {
        externalId: `ext_mem_b_${testRunId}`,
        email: `mem_b_${testRunId}@test.local`,
        fullName: "Memory Member B",
      },
    });
    userAId = uA.id;
    userBId = uB.id;

    const wsA = await prisma.workspace.create({
      data: {
        name: `Mem Workspace A ${testRunId}`,
        slug: `mem-ws-a-${testRunId}`,
        ownerId: userAId,
        members: {
          create: [
            { userId: userAId, role: "OWNER" },
            { userId: userBId, role: "MEMBER" },
          ],
        },
      },
    });
    const wsB = await prisma.workspace.create({
      data: {
        name: `Mem Workspace B ${testRunId}`,
        slug: `mem-ws-b-${testRunId}`,
        ownerId: userBId,
        members: { create: [{ userId: userBId, role: "OWNER" }] },
      },
    });
    workspaceAId = wsA.id;
    workspaceBId = wsB.id;

    const agA = await prisma.agentDefinition.create({
      data: {
        workspaceId: workspaceAId,
        name: "Research Bot A",
        slug: `res-bot-a-${testRunId}`,
        roleTitle: "Researcher",
        systemPrompt: "Inspect docs cleanly.",
      },
    });
    const agB = await prisma.agentDefinition.create({
      data: {
        workspaceId: workspaceAId,
        name: "Builder Bot B",
        slug: `bld-bot-b-${testRunId}`,
        roleTitle: "Developer",
        systemPrompt: "Write code cleanly.",
      },
    });
    agentAId = agA.id;
    agentBId = agB.id;
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: [workspaceAId, workspaceBId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userAId, userBId] } } });
  });

  it("blocks raw credentials/secrets from manual memory persistence and scrubs auto-capture", async () => {
    expect(MemorySanitizer.detectSecrets("OPENAI_API_KEY=sk-proj-1234567890abcdef123456")).not.toHaveLength(0);

    await expect(
      memoryService.createMemory(userAId, {
        workspaceId: workspaceAId,
        scope: "PERSONAL",
        sourceType: "MANUAL",
        title: "Leaked key test",
        content: "Use key sk-proj-supersecretkey1234567890abcd to login",
        tags: [],
        metadata: {},
        importance: 0.5,
        isPinned: false,
        embedImmediately: false,
      })
    ).rejects.toThrowError(MemoryServiceError);

    const scrubbed = await memoryService.createMemory(
      userAId,
      {
        workspaceId: workspaceAId,
        scope: "PERSONAL",
        sourceType: "CONVERSATION_SUMMARY",
        title: "Session notes",
        content: "Connected using postgresql://admin:mysecretpass@db.local:5432/app",
        tags: [],
        metadata: {},
        importance: 0.5,
        isPinned: false,
        embedImmediately: false,
      },
      { redactInsteadOfReject: true }
    );
    expect(scrubbed.content).toContain("[REDACTED_CREDENTIALS]");
    expect(scrubbed.sensitivity).toBe("SENSITIVE_REDACTED");
  });

  it("enforces SQL-level Personal, Agent, and Tenant isolation BEFORE vector ranking", async () => {
    // User A private personal memory about pgvector
    const personalA = await memoryService.createMemory(userAId, {
      workspaceId: workspaceAId,
      scope: "PERSONAL",
      sourceType: "PREFERENCE",
      title: "Private DB Preference",
      content: "User A prefers postgres and pgvector cosine index with 1536 dimensions.",
      tags: ["postgres"],
      metadata: {},
      importance: 0.9,
      isPinned: true,
      embedImmediately: true,
    });

    // Shared Workspace memory about pgvector
    const wsShared = await memoryService.createMemory(userAId, {
      workspaceId: workspaceAId,
      scope: "WORKSPACE",
      sourceType: "WORKSPACE_DECISION",
      title: "Workspace Database Standard",
      content: "Team standardized on PostgreSQL 16 with pgvector for semantic memory.",
      tags: ["architecture"],
      metadata: {},
      importance: 0.8,
      isPinned: false,
      embedImmediately: true,
    });

    // Private Agent A memory about pgvector
    const agentAMem = await memoryService.createMemory(userAId, {
      workspaceId: workspaceAId,
      scope: "AGENT",
      agentId: agentAId,
      sourceType: "AGENT_FINDING",
      title: "Agent A Postgres Finding",
      content: "Agent A observed pgvector HNSW index ready in messiah_db.",
      tags: [],
      metadata: {},
      importance: 0.7,
      isPinned: false,
      embedImmediately: true,
    });

    // User B searching in Workspace A for "postgres pgvector" -> sees WORKSPACE, MUST NOT see User A's PERSONAL or Agent A's memory!
    const userBRes = await memoryService.searchMemories({
      workspaceId: workspaceAId,
      userId: userBId,
      query: "postgres pgvector database",
      scopes: ["PERSONAL", "WORKSPACE", "AGENT"],
      agentIds: [agentBId],
      topK: 10,
      minSimilarity: 0.1,
      includeArchived: false,
      enforceStrictAgentScope: true,
    });

    const userBIds = userBRes.matches.map((m) => m.memory.id);
    expect(userBIds).toContain(wsShared.id);
    expect(userBIds).not.toContain(personalA.id);
    expect(userBIds).not.toContain(agentAMem.id);
    expect(userBRes.mode === "vector" || userBRes.mode === "hybrid").toBe(true);

    // Unrelated Workspace B sees zero Workspace A items
    const wsBRes = await memoryService.searchMemories({
      workspaceId: workspaceBId,
      userId: userBId,
      query: "postgres pgvector",
      scopes: ["PERSONAL", "WORKSPACE"],
      topK: 10,
      minSimilarity: 0.1,
      includeArchived: false,
    });
    expect(wsBRes.matches).toHaveLength(0);
  });

  it("tracks revision history on edits, supports lexical fallback, and re-embeds across dimensions without data loss", async () => {
    const created = await memoryService.createMemory(userAId, {
      workspaceId: workspaceAId,
      scope: "WORKSPACE",
      sourceType: "WORKSPACE_DECISION",
      title: "UI Palette Convention",
      content: "All interfaces use obsidian dark surface #090A0F and #12151E cards.",
      tags: ["frontend", "tailwind"],
      metadata: {},
      importance: 0.7,
      isPinned: false,
      embedImmediately: true,
    });

    const updated = await memoryService.updateMemory(created.id, userAId, {
      workspaceId: workspaceAId,
      content: "All interfaces use obsidian dark surface #090A0F, #12151E cards, and #00F0FF cyan highlights.",
      changeReason: "Added primary accent hex",
    });
    expect(updated.currentVersion).toBe(2);
    expect(updated.versions?.length).toBeGreaterThanOrEqual(2);

    // Lexical fallback service (no embedTextFn or decryptor)
    const lexicalOnlyService = new MemoryService({});
    const lexSearch = await lexicalOnlyService.searchMemories({
      workspaceId: workspaceAId,
      userId: userAId,
      query: "obsidian dark cyan highlights",
      scopes: ["WORKSPACE"],
      topK: 5,
      minSimilarity: 0.1,
      includeArchived: false,
    });
    expect(lexSearch.mode).toBe("lexical_fallback");
    expect(lexSearch.matches.some((m) => m.memory.id === created.id)).toBe(true);

    // Switch dimension 1536 -> 768 and re-embed cleanly
    await prisma.memorySettings.upsert({
      where: { workspaceId: workspaceAId },
      create: {
        workspaceId: workspaceAId,
        embeddingProvider: "gemini",
        embeddingModel: "gemini-embedding-001",
        embeddingDimensions: 768,
      },
      update: {
        embeddingProvider: "gemini",
        embeddingModel: "gemini-embedding-001",
        embeddingDimensions: 768,
      },
    });
    mockDims = 768;

    const reembed = await memoryService.reembedWorkspaceMemories(userAId, {
      workspaceId: workspaceAId,
      forceAll: true,
    });
    expect(reembed.succeeded).toBeGreaterThanOrEqual(3);

    const reloaded = await memoryService.getMemory(updated.id, workspaceAId, userAId);
    expect(reloaded.embeddingDimensions).toBe(768);
    expect(reloaded.content).toContain("#00F0FF");
  });
});
