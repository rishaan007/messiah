import crypto from "node:crypto";
import { prisma, type ProviderStatus, type WorkspaceRole, type Prisma } from "@messiah/db";
import type {
  SupportedProviderId,
  ProviderMetadataInfo,
  ProviderConnectionInfo,
  ProviderCapabilityMap,
  ModelInfo,
  ConnectionValidationResult,
  CreateProviderConnectionInput,
  UpdateProviderConnectionInput,
} from "@messiah/shared";
import { defaultProviderRegistry } from "@messiah/providers";
import { VaultService } from "./vaultService.js";
import { logAuditEvent } from "./auditService.js";
import { workspaceService } from "./workspaceService.js";

export class ProviderConnectionServiceError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode = 400, code = "PROVIDER_CONNECTION_ERROR") {
    super(message);
    this.name = "ProviderConnectionServiceError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class ProviderConnectionService {
  private vaultService: VaultService;

  constructor(vaultService?: VaultService) {
    this.vaultService = vaultService || new VaultService();
  }

  /**
   * Helper to verify workspace membership and role.
   */
  private async getAuthorizedMembership(
    userId: string,
    workspaceId: string
  ): Promise<WorkspaceRole> {
    const role = await workspaceService.getWorkspaceMembership(userId, workspaceId);
    if (!role) {
      // 404 Not Found to prevent leaking existence of private workspaces (anti-IDOR)
      throw new ProviderConnectionServiceError(
        "Workspace not found or access denied",
        404,
        "WORKSPACE_NOT_FOUND"
      );
    }
    return role;
  }

  /**
   * Helper to enforce administrative permissions (OWNER or ADMIN).
   */
  private requireAdminRole(role: WorkspaceRole): void {
    if (role !== "OWNER" && role !== "ADMIN") {
      throw new ProviderConnectionServiceError(
        "Insufficient workspace permissions. Only workspace owners and admins can manage provider credentials.",
        403,
        "FORBIDDEN_ROLE"
      );
    }
  }

  /**
   * Formats a database connection into a secure user-facing DTO (never exposing credentials).
   */
  private formatConnectionInfo(conn: {
    id: string;
    workspaceId: string;
    provider: string;
    displayName: string;
    status: ProviderStatus;
    capabilities: unknown;
    lastValidatedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): ProviderConnectionInfo {
    return {
      id: conn.id,
      workspaceId: conn.workspaceId,
      provider: conn.provider as SupportedProviderId,
      displayName: conn.displayName,
      status: conn.status,
      capabilities: (conn.capabilities as unknown as ProviderCapabilityMap) || {},
      lastValidatedAt: conn.lastValidatedAt ? conn.lastValidatedAt.toISOString() : null,
      createdAt: conn.createdAt.toISOString(),
      updatedAt: conn.updatedAt.toISOString(),
    };
  }

  /**
   * Lists all supported providers from the registry with normalized capabilities.
   */
  public listSupportedProviders(): ProviderMetadataInfo[] {
    return defaultProviderRegistry.listSupportedProviders();
  }

  /**
   * Lists all provider connections for a specific workspace.
   */
  public async listWorkspaceConnections(
    workspaceId: string,
    userId: string
  ): Promise<ProviderConnectionInfo[]> {
    await this.getAuthorizedMembership(userId, workspaceId);

    const connections = await prisma.providerConnection.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });

    return connections.map((conn) => this.formatConnectionInfo(conn));
  }

  /**
   * Creates a new provider connection after validating the API key with the provider.
   */
  public async createConnection(
    userId: string,
    input: CreateProviderConnectionInput,
    meta?: { ipAddress?: string; userAgent?: string }
  ): Promise<ProviderConnectionInfo> {
    const role = await this.getAuthorizedMembership(userId, input.workspaceId);
    this.requireAdminRole(role);

    if (!defaultProviderRegistry.isSupported(input.provider)) {
      throw new ProviderConnectionServiceError(
        `Provider '${input.provider}' is not supported. Supported: openai, anthropic, gemini.`,
        400,
        "UNSUPPORTED_PROVIDER"
      );
    }

    const adapter = defaultProviderRegistry.getAdapter(input.provider);

    // 1. LIVE VALIDATION WITH PROVIDER BEFORE PERSISTENCE
    try {
      await adapter.validateCredentials({ apiKey: input.apiKey });
    } catch (err: unknown) {
      await logAuditEvent({
        workspaceId: input.workspaceId,
        actorId: userId,
        action: "connection.validation_failed",
        resourceType: "provider_connection",
        details: {
          provider: input.provider,
          displayName: input.displayName,
          error: err instanceof Error ? err.message : "Validation failed",
        },
        ipAddress: meta?.ipAddress,
        userAgent: meta?.userAgent,
      });
      throw err;
    }

    // 2. ENCRYPT THE CREDENTIAL WITH AES-256-GCM BOUND TO CONTEXT (AAD)
    const connectionId = crypto.randomUUID();
    const encrypted = this.vaultService.encrypt(input.apiKey, {
      workspaceId: input.workspaceId,
      providerConnectionId: connectionId,
      provider: input.provider,
    });

    // 3. PERSIST TRANSACTIONALLY IN POSTGRESQL
    const result = await prisma.$transaction(async (tx) => {
      const connection = await tx.providerConnection.create({
        data: {
          id: connectionId,
          workspaceId: input.workspaceId,
          provider: input.provider,
          displayName: input.displayName.trim(),
          status: "ACTIVE",
          capabilities: adapter.getCapabilities() as unknown as Prisma.InputJsonValue,
          createdByUserId: userId,
          lastValidatedAt: new Date(),
        },
      });

      await tx.encryptedCredential.create({
        data: {
          providerConnectionId: connection.id,
          ciphertext: encrypted.ciphertext,
          initializationVector: encrypted.initializationVector,
          authenticationTag: encrypted.authenticationTag,
          keyVersion: encrypted.keyVersion,
        },
      });

      return connection;
    });

    // 4. AUDIT LOGGING
    await logAuditEvent({
      workspaceId: input.workspaceId,
      actorId: userId,
      action: "connection.created",
      resourceType: "provider_connection",
      resourceId: result.id,
      details: {
        provider: input.provider,
        displayName: input.displayName,
        keyVersion: encrypted.keyVersion,
      },
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });

    return this.formatConnectionInfo(result);
  }

  /**
   * Tests an existing connection by decrypting the credential and validating with the provider.
   */
  public async testConnection(
    workspaceId: string,
    connectionId: string,
    userId: string,
    meta?: { ipAddress?: string; userAgent?: string }
  ): Promise<ConnectionValidationResult> {
    const role = await this.getAuthorizedMembership(userId, workspaceId);
    this.requireAdminRole(role);

    const connection = await prisma.providerConnection.findFirst({
      where: { id: connectionId, workspaceId },
      include: { credential: true },
    });

    if (!connection || !connection.credential) {
      throw new ProviderConnectionServiceError(
        "Provider connection not found in this workspace.",
        404,
        "CONNECTION_NOT_FOUND"
      );
    }

    const decryptedKey = this.vaultService.decrypt(connection.credential, {
      workspaceId: connection.workspaceId,
      providerConnectionId: connection.id,
      provider: connection.provider,
    });
    const adapter = defaultProviderRegistry.getAdapter(
      connection.provider as SupportedProviderId
    );

    try {
      const validationResult = await adapter.validateCredentials({ apiKey: decryptedKey });

      await prisma.providerConnection.update({
        where: { id: connectionId },
        data: {
          status: "ACTIVE",
          lastValidatedAt: new Date(),
        },
      });

      await logAuditEvent({
        workspaceId,
        actorId: userId,
        action: "connection.validated",
        resourceType: "provider_connection",
        resourceId: connectionId,
        details: {
          provider: connection.provider,
          status: "ACTIVE",
        },
        ipAddress: meta?.ipAddress,
        userAgent: meta?.userAgent,
      });

      return validationResult;
    } catch (err: unknown) {
      await prisma.providerConnection.update({
        where: { id: connectionId },
        data: {
          status: "INVALID",
        },
      });

      await logAuditEvent({
        workspaceId,
        actorId: userId,
        action: "connection.validation_failed",
        resourceType: "provider_connection",
        resourceId: connectionId,
        details: {
          provider: connection.provider,
          error: err instanceof Error ? err.message : "Validation failed",
        },
        ipAddress: meta?.ipAddress,
        userAgent: meta?.userAgent,
      });

      throw err;
    }
  }

  /**
   * Updates an existing connection's display name and/or API key.
   */
  public async updateConnection(
    workspaceId: string,
    connectionId: string,
    userId: string,
    input: UpdateProviderConnectionInput,
    meta?: { ipAddress?: string; userAgent?: string }
  ): Promise<ProviderConnectionInfo> {
    const role = await this.getAuthorizedMembership(userId, workspaceId);
    this.requireAdminRole(role);

    const connection = await prisma.providerConnection.findFirst({
      where: { id: connectionId, workspaceId },
      include: { credential: true },
    });

    if (!connection) {
      throw new ProviderConnectionServiceError(
        "Provider connection not found.",
        404,
        "CONNECTION_NOT_FOUND"
      );
    }

    const adapter = defaultProviderRegistry.getAdapter(
      connection.provider as SupportedProviderId
    );

    await prisma.$transaction(async (tx) => {
      // 1. If new API key provided, validate first then encrypt
      if (input.apiKey) {
        await adapter.validateCredentials({ apiKey: input.apiKey });
        const encrypted = this.vaultService.encrypt(input.apiKey, {
          workspaceId: connection.workspaceId,
          providerConnectionId: connection.id,
          provider: connection.provider,
        });

        if (connection.credential) {
          await tx.encryptedCredential.update({
            where: { id: connection.credential.id },
            data: {
              ciphertext: encrypted.ciphertext,
              initializationVector: encrypted.initializationVector,
              authenticationTag: encrypted.authenticationTag,
              keyVersion: encrypted.keyVersion,
            },
          });
        }
      }

      // 2. Update metadata
      await tx.providerConnection.update({
        where: { id: connectionId },
        data: {
          ...(input.displayName ? { displayName: input.displayName.trim() } : {}),
          ...(input.apiKey ? { status: "ACTIVE", lastValidatedAt: new Date() } : {}),
        },
      });
    });

    const updated = await prisma.providerConnection.findUniqueOrThrow({
      where: { id: connectionId },
    });

    await logAuditEvent({
      workspaceId,
      actorId: userId,
      action: input.apiKey ? "connection.updated" : "connection.renamed",
      resourceType: "provider_connection",
      resourceId: connectionId,
      details: {
        provider: updated.provider,
        displayName: updated.displayName,
      },
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });

    return this.formatConnectionInfo(updated);
  }

  /**
   * Deletes a provider connection and cascades to its encrypted credential.
   */
  public async deleteConnection(
    workspaceId: string,
    connectionId: string,
    userId: string,
    meta?: { ipAddress?: string; userAgent?: string }
  ): Promise<void> {
    const role = await this.getAuthorizedMembership(userId, workspaceId);
    this.requireAdminRole(role);

    const connection = await prisma.providerConnection.findFirst({
      where: { id: connectionId, workspaceId },
    });

    if (!connection) {
      throw new ProviderConnectionServiceError(
        "Provider connection not found in this workspace.",
        404,
        "CONNECTION_NOT_FOUND"
      );
    }

    await prisma.providerConnection.delete({
      where: { id: connectionId },
    });

    await logAuditEvent({
      workspaceId,
      actorId: userId,
      action: "connection.deleted",
      resourceType: "provider_connection",
      resourceId: connectionId,
      details: {
        provider: connection.provider,
        displayName: connection.displayName,
      },
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    });
  }

  /**
   * Retrieves dynamically discovered models using the active workspace connection.
   */
  public async getWorkspaceProviderModels(
    workspaceId: string,
    providerId: SupportedProviderId,
    userId: string
  ): Promise<ModelInfo[]> {
    // Validates that caller is at least a member of the workspace
    await this.getAuthorizedMembership(userId, workspaceId);

    if (!defaultProviderRegistry.isSupported(providerId)) {
      throw new ProviderConnectionServiceError(
        `Provider '${providerId}' is not supported.`,
        400,
        "UNSUPPORTED_PROVIDER"
      );
    }

    const connection = await prisma.providerConnection.findFirst({
      where: { workspaceId, provider: providerId, status: "ACTIVE" },
      include: { credential: true },
      orderBy: { updatedAt: "desc" },
    });

    if (!connection || !connection.credential) {
      throw new ProviderConnectionServiceError(
        `No active connection found for provider '${providerId}' in this workspace. Please configure a connection in Workspace Settings.`,
        404,
        "NO_ACTIVE_CONNECTION"
      );
    }

    const decryptedKey = this.vaultService.decrypt(connection.credential, {
      workspaceId: connection.workspaceId,
      providerConnectionId: connection.id,
      provider: connection.provider,
    });
    const adapter = defaultProviderRegistry.getAdapter(providerId);

    return await adapter.listModels({ apiKey: decryptedKey });
  }

  /**
   * Internal server-only method to retrieve decrypted API key in transient memory.
   * Cryptographically validates AAD binding (workspaceId, connectionId, provider).
   * Never exposed via REST routes or returned to client.
   */
  public async getDecryptedKeyForInternalUse(
    connectionId: string,
    workspaceId: string
  ): Promise<{ apiKey: string; provider: SupportedProviderId; displayName: string }> {
    const connection = await prisma.providerConnection.findFirst({
      where: { id: connectionId, workspaceId },
      include: { credential: true },
    });

    if (!connection || !connection.credential) {
      throw new ProviderConnectionServiceError("Provider connection or credential not found", 404);
    }

    if (connection.status !== "ACTIVE") {
      throw new ProviderConnectionServiceError(
        `Provider connection is not active (current status: ${connection.status})`,
        400
      );
    }

    const decryptedKey = this.vaultService.decrypt(connection.credential, {
      workspaceId: connection.workspaceId,
      providerConnectionId: connection.id,
      provider: connection.provider,
    });

    return {
      apiKey: decryptedKey,
      provider: connection.provider as SupportedProviderId,
      displayName: connection.displayName,
    };
  }
}

export const providerConnectionService = new ProviderConnectionService();
