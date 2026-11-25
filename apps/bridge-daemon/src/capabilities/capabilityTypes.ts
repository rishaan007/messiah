import type { LocalDevicePolicyService } from "../security/localDevicePolicy.js";
import type { ISandboxProvider } from "../sandbox/sandboxInterface.js";

export type CapabilityPermission = "read" | "write" | "exec" | "admin";

export interface CapabilityExecutionContext {
  taskId: string;
  deviceId: string;
  workspaceId: string;
  policyService: LocalDevicePolicyService;
  sandbox: ISandboxProvider;
  allowedRoots: string[];
  onLog?: (stream: "stdout" | "stderr" | "system", chunk: string) => void;
  onProgress?: (percent: number, message: string) => void;
}

export interface CapabilityDefinition {
  name: string;
  description: string;
  permission: CapabilityPermission;
  supportedPlatforms: string[];
  requiresSandbox: boolean;
  requiresApproval: boolean;
  defaultTimeoutMs: number;
  execute(
    context: CapabilityExecutionContext,
    parameters: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
}
