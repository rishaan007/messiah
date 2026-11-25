import { prisma } from "@messiah/db";
import type { BridgeDeviceInfo } from "@messiah/shared";
import { workspaceService } from "../workspaceService.js";
import { devicePresenceService } from "./devicePresenceService.js";

export class DeviceManagementError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "DeviceManagementError";
  }
}

export class DeviceManagementService {
  /**
   * Lists all bridge devices in a workspace.
   */
  public async listDevices(workspaceId: string, userId: string): Promise<BridgeDeviceInfo[]> {
    const isMember = await workspaceService.isUserMember(workspaceId, userId);
    if (!isMember) {
      throw new DeviceManagementError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }

    const devices = await prisma.bridgeDevice.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });

    const result: BridgeDeviceInfo[] = [];
    for (const d of devices) {
      const isOnline = await devicePresenceService.isDeviceOnline(d.id);
      result.push({
        id: d.id,
        workspaceId: d.workspaceId,
        ownerUserId: d.ownerUserId,
        displayName: d.displayName,
        platform: d.platform,
        architecture: d.architecture,
        bridgeVersion: d.bridgeVersion,
        publicKey: d.publicKey,
        publicKeyFingerprint: d.publicKeyFingerprint,
        protocolVersion: d.protocolVersion,
        status: d.status as BridgeDeviceInfo["status"],
        isOnline: d.status === "ACTIVE" && isOnline,
        lastSeenAt: d.lastSeenAt ? d.lastSeenAt.toISOString() : null,
        lastConnectedAt: d.lastConnectedAt ? d.lastConnectedAt.toISOString() : null,
        pairedAt: d.pairedAt ? d.pairedAt.toISOString() : null,
        revokedAt: d.revokedAt ? d.revokedAt.toISOString() : null,
        createdAt: d.createdAt.toISOString(),
        updatedAt: d.updatedAt.toISOString(),
      });
    }

    return result;
  }

  /**
   * Retrieves single device detail including recent connection sessions.
   */
  public async getDevice(deviceId: string, workspaceId: string, userId: string) {
    const isMember = await workspaceService.isUserMember(workspaceId, userId);
    if (!isMember) {
      throw new DeviceManagementError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }

    const device = await prisma.bridgeDevice.findUnique({
      where: { id: deviceId },
      include: {
        sessions: {
          orderBy: { connectedAt: "desc" },
          take: 10,
        },
      },
    });

    if (!device || device.workspaceId !== workspaceId) {
      throw new DeviceManagementError(404, "DEVICE_NOT_FOUND", "Device not found in this workspace.");
    }

    const isOnline = await devicePresenceService.isDeviceOnline(device.id);

    return {
      ...device,
      isOnline: device.status === "ACTIVE" && isOnline,
      lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
      lastConnectedAt: device.lastConnectedAt?.toISOString() ?? null,
      pairedAt: device.pairedAt?.toISOString() ?? null,
      revokedAt: device.revokedAt?.toISOString() ?? null,
      createdAt: device.createdAt.toISOString(),
      updatedAt: device.updatedAt.toISOString(),
      sessions: device.sessions.map((s) => ({
        id: s.id,
        ipAddress: s.ipAddress,
        userAgent: s.userAgent,
        connectedAt: s.connectedAt.toISOString(),
        lastHeartbeatAt: s.lastHeartbeatAt.toISOString(),
        disconnectedAt: s.disconnectedAt?.toISOString() ?? null,
        disconnectReason: s.disconnectReason,
        expiresAt: s.expiresAt.toISOString(),
      })),
    };
  }

  /**
   * Renames a bridge device.
   * Requires OWNER or ADMIN role.
   */
  public async renameDevice(
    deviceId: string,
    workspaceId: string,
    userId: string,
    displayName: string
  ): Promise<BridgeDeviceInfo> {
    const role = await workspaceService.getUserRole(workspaceId, userId);
    if (!role) {
      throw new DeviceManagementError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }
    if (role !== "OWNER" && role !== "ADMIN") {
      throw new DeviceManagementError(403, "FORBIDDEN_ROLE", "Only workspace OWNER or ADMIN can rename devices.");
    }

    const device = await prisma.bridgeDevice.findUnique({
      where: { id: deviceId },
    });

    if (!device || device.workspaceId !== workspaceId) {
      throw new DeviceManagementError(404, "DEVICE_NOT_FOUND", "Device not found in this workspace.");
    }

    const updated = await prisma.bridgeDevice.update({
      where: { id: deviceId },
      data: { displayName: displayName.trim() },
    });

    const isOnline = await devicePresenceService.isDeviceOnline(updated.id);

    return {
      id: updated.id,
      workspaceId: updated.workspaceId,
      ownerUserId: updated.ownerUserId,
      displayName: updated.displayName,
      platform: updated.platform,
      architecture: updated.architecture,
      bridgeVersion: updated.bridgeVersion,
      publicKey: updated.publicKey,
      publicKeyFingerprint: updated.publicKeyFingerprint,
      protocolVersion: updated.protocolVersion,
      status: updated.status as BridgeDeviceInfo["status"],
      isOnline: updated.status === "ACTIVE" && isOnline,
      lastSeenAt: updated.lastSeenAt ? updated.lastSeenAt.toISOString() : null,
      lastConnectedAt: updated.lastConnectedAt ? updated.lastConnectedAt.toISOString() : null,
      pairedAt: updated.pairedAt ? updated.pairedAt.toISOString() : null,
      revokedAt: updated.revokedAt ? updated.revokedAt.toISOString() : null,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  /**
   * Pauses an active device.
   * Immediately terminates active WebSocket connections.
   */
  public async pauseDevice(deviceId: string, workspaceId: string, userId: string) {
    const role = await workspaceService.getUserRole(workspaceId, userId);
    if (!role) {
      throw new DeviceManagementError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }
    if (role !== "OWNER" && role !== "ADMIN") {
      throw new DeviceManagementError(403, "FORBIDDEN_ROLE", "Only workspace OWNER or ADMIN can pause devices.");
    }

    const device = await prisma.bridgeDevice.findUnique({
      where: { id: deviceId },
    });

    if (!device || device.workspaceId !== workspaceId) {
      throw new DeviceManagementError(404, "DEVICE_NOT_FOUND", "Device not found in this workspace.");
    }

    if (device.status === "REVOKED") {
      throw new DeviceManagementError(400, "DEVICE_ALREADY_REVOKED", "Cannot pause a revoked device.");
    }

    const updated = await prisma.bridgeDevice.update({
      where: { id: deviceId },
      data: { status: "PAUSED" },
    });

    // Notify connected gateway to disconnect immediately
    await devicePresenceService.publishDisconnect(deviceId, "Device paused by workspace administrator");

    return updated;
  }

  /**
   * Resumes a paused device.
   */
  public async resumeDevice(deviceId: string, workspaceId: string, userId: string) {
    const role = await workspaceService.getUserRole(workspaceId, userId);
    if (!role) {
      throw new DeviceManagementError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }
    if (role !== "OWNER" && role !== "ADMIN") {
      throw new DeviceManagementError(403, "FORBIDDEN_ROLE", "Only workspace OWNER or ADMIN can resume devices.");
    }

    const device = await prisma.bridgeDevice.findUnique({
      where: { id: deviceId },
    });

    if (!device || device.workspaceId !== workspaceId) {
      throw new DeviceManagementError(404, "DEVICE_NOT_FOUND", "Device not found in this workspace.");
    }

    if (device.status === "REVOKED") {
      throw new DeviceManagementError(400, "DEVICE_ALREADY_REVOKED", "Cannot resume a revoked device.");
    }

    const updated = await prisma.bridgeDevice.update({
      where: { id: deviceId },
      data: { status: "ACTIVE" },
    });

    return updated;
  }

  /**
   * Permanently revokes a device.
   * Immediately disconnects active WebSocket session with device.revoked message.
   */
  public async revokeDevice(deviceId: string, workspaceId: string, userId: string) {
    const role = await workspaceService.getUserRole(workspaceId, userId);
    if (!role) {
      throw new DeviceManagementError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }
    if (role !== "OWNER" && role !== "ADMIN") {
      throw new DeviceManagementError(403, "FORBIDDEN_ROLE", "Only workspace OWNER or ADMIN can revoke devices.");
    }

    const device = await prisma.bridgeDevice.findUnique({
      where: { id: deviceId },
    });

    if (!device || device.workspaceId !== workspaceId) {
      throw new DeviceManagementError(404, "DEVICE_NOT_FOUND", "Device not found in this workspace.");
    }

    const updated = await prisma.bridgeDevice.update({
      where: { id: deviceId },
      data: {
        status: "REVOKED",
        revokedAt: new Date(),
      },
    });

    // Notify connected gateway to terminate immediately with revocation message
    await devicePresenceService.publishRevoke(deviceId, "Device permanently revoked by workspace administrator");

    return updated;
  }

  /**
   * Updates device execution policy, allowed project roots, and enabled capabilities.
   * Requires OWNER or ADMIN role.
   */
  public async updateDevicePolicy(
    deviceId: string,
    workspaceId: string,
    userId: string,
    update: {
      allowedRoots?: string[];
      capabilities?: string[];
      devicePolicy?: Record<string, unknown>;
    }
  ) {
    const role = await workspaceService.getUserRole(workspaceId, userId);
    if (!role) {
      throw new DeviceManagementError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }
    if (role !== "OWNER" && role !== "ADMIN") {
      throw new DeviceManagementError(403, "FORBIDDEN_ROLE", "Only workspace OWNER or ADMIN can configure device policy.");
    }

    const device = await prisma.bridgeDevice.findUnique({
      where: { id: deviceId },
    });

    if (!device || device.workspaceId !== workspaceId) {
      throw new DeviceManagementError(404, "DEVICE_NOT_FOUND", "Device not found in this workspace.");
    }

    const data: Record<string, unknown> = {};
    if (update.allowedRoots !== undefined) {
      data.allowedRoots = update.allowedRoots;
    }
    if (update.capabilities !== undefined) {
      data.capabilities = update.capabilities;
    }
    if (update.devicePolicy !== undefined) {
      data.devicePolicy = update.devicePolicy;
    }

    const updated = await prisma.bridgeDevice.update({
      where: { id: deviceId },
      data,
    });

    return updated;
  }

  /**
   * Retrieves capabilities, allowed project roots, and policy for a device.
   */
  public async getDeviceCapabilities(deviceId: string, workspaceId: string, userId: string) {
    const isMember = await workspaceService.isUserMember(workspaceId, userId);
    if (!isMember) {
      throw new DeviceManagementError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }

    const device = await prisma.bridgeDevice.findUnique({
      where: { id: deviceId },
      include: {
        localMcpServers: true,
      },
    });

    if (!device || device.workspaceId !== workspaceId) {
      throw new DeviceManagementError(404, "DEVICE_NOT_FOUND", "Device not found in this workspace.");
    }

    const isOnline = await devicePresenceService.isDeviceOnline(device.id);

    return {
      deviceId: device.id,
      displayName: device.displayName,
      platform: device.platform,
      architecture: device.architecture,
      isOnline: device.status === "ACTIVE" && isOnline,
      capabilities: device.capabilities,
      allowedRoots: device.allowedRoots,
      devicePolicy: device.devicePolicy,
      localMcpServers: device.localMcpServers,
      updatedAt: device.updatedAt.toISOString(),
    };
  }

  /**
   * Lists local MCP servers registered on the device.
   */
  public async listLocalMcpServers(deviceId: string, workspaceId: string, userId: string) {
    const isMember = await workspaceService.isUserMember(workspaceId, userId);
    if (!isMember) {
      throw new DeviceManagementError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }

    const device = await prisma.bridgeDevice.findUnique({
      where: { id: deviceId },
    });

    if (!device || device.workspaceId !== workspaceId) {
      throw new DeviceManagementError(404, "DEVICE_NOT_FOUND", "Device not found in this workspace.");
    }

    const servers = await prisma.bridgeLocalMcpServer.findMany({
      where: { deviceId },
      orderBy: { serverName: "asc" },
    });

    return servers;
  }

  /**
   * Registers or updates a local MCP server configuration on the device.
   * Requires OWNER or ADMIN role.
   */
  public async registerLocalMcpServer(
    deviceId: string,
    workspaceId: string,
    userId: string,
    input: {
      serverName: string;
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
    }
  ) {
    const role = await workspaceService.getUserRole(workspaceId, userId);
    if (!role) {
      throw new DeviceManagementError(404, "WORKSPACE_NOT_FOUND", "Workspace not found or access denied.");
    }
    if (role !== "OWNER" && role !== "ADMIN") {
      throw new DeviceManagementError(403, "FORBIDDEN_ROLE", "Only workspace OWNER or ADMIN can register local MCP servers.");
    }

    const device = await prisma.bridgeDevice.findUnique({
      where: { id: deviceId },
    });

    if (!device || device.workspaceId !== workspaceId) {
      throw new DeviceManagementError(404, "DEVICE_NOT_FOUND", "Device not found in this workspace.");
    }

    const server = await prisma.bridgeLocalMcpServer.upsert({
      where: {
        deviceId_serverName: {
          deviceId,
          serverName: input.serverName,
        },
      },
      create: {
        deviceId,
        workspaceId,
        serverName: input.serverName,
        command: input.command,
        args: input.args || [],
        cwd: input.cwd,
        env: input.env as any,
        status: "ACTIVE",
      },
      update: {
        command: input.command,
        args: input.args || [],
        cwd: input.cwd,
        env: input.env as any,
        status: "ACTIVE",
      },
    });

    return server;
  }
}

export const deviceManagementService = new DeviceManagementService();
