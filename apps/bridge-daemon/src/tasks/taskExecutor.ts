import crypto from "node:crypto";
import type { DeviceTaskDispatchFrame } from "@messiah/shared";
import { CapabilityRegistry } from "../capabilities/capabilityRegistry.js";
import { LocalDevicePolicyService } from "../security/localDevicePolicy.js";
import { ReplayGuard } from "../security/replayGuard.js";
import { TaskSignatureVerifier } from "../security/taskSignatureVerifier.js";
import { ProcessSandbox } from "../sandbox/processSandbox.js";
import type { ISandboxProvider } from "../sandbox/sandboxInterface.js";

export interface TaskExecutorCallbacks {
  onAccepted(taskId: string): void;
  onStarted(taskId: string, sandboxProfile: string): void;
  onProgress(taskId: string, percent: number, message: string): void;
  onLog(taskId: string, sequence: number, stream: "stdout" | "stderr" | "system", chunk: string): void;
  onCompleted(taskId: string, result: Record<string, unknown>, durationMs: number): void;
  onFailed(taskId: string, code: string, message: string, durationMs: number): void;
}

export class TaskExecutor {
  private readonly capabilityRegistry = new CapabilityRegistry();
  private readonly policyService: LocalDevicePolicyService;
  private readonly sandbox: ISandboxProvider;
  private readonly activeTaskControllers = new Map<string, AbortController>();
  private logSequences = new Map<string, number>();

  constructor(
    customDir?: string,
    sandbox?: ISandboxProvider
  ) {
    this.policyService = new LocalDevicePolicyService(customDir);
    this.sandbox = sandbox || new ProcessSandbox();
  }

  public getPolicyService(): LocalDevicePolicyService {
    return this.policyService;
  }

  public getCapabilityRegistry(): CapabilityRegistry {
    return this.capabilityRegistry;
  }

  /**
   * Executes a signed task received from the server.
   */
  public async executeTask(
    frame: DeviceTaskDispatchFrame,
    serverPublicKeyOrSecret: string,
    callbacks: TaskExecutorCallbacks
  ): Promise<void> {
    const startTime = Date.now();
    const { taskId } = frame;

    // 1. Replay and Expiration Check
    if (Date.now() > frame.expiresAt) {
      callbacks.onFailed(taskId, "TASK_EXPIRED", "Task authorization has expired.", 0);
      return;
    }

    if (!ReplayGuard.checkAndRecordNonce(frame.nonce, frame.expiresAt)) {
      callbacks.onFailed(taskId, "REPLAY_DETECTED", "Task nonce has already been consumed or replayed.", 0);
      return;
    }

    if (ReplayGuard.isDuplicateTask(taskId)) {
      callbacks.onFailed(taskId, "DUPLICATE_TASK", "Task is already executing or has finished.", 0);
      return;
    }

    // 2. Cryptographic Signature Verification
    const canonicalPayload = TaskSignatureVerifier.formatTaskAuthPayload(
      frame.taskId,
      frame.requestId,
      frame.deviceId,
      frame.workspaceId,
      frame.capability,
      frame.resourceScopes,
      frame.argumentsHash,
      frame.issuedAt,
      frame.expiresAt,
      frame.nonce,
      frame.policyVersion,
      frame.approvalReference
    );

    const isSignatureValid =
      TaskSignatureVerifier.verifyTaskSignature(canonicalPayload, frame.serverSignature, serverPublicKeyOrSecret) ||
      TaskSignatureVerifier.verifyHmacSignature(canonicalPayload, frame.serverSignature, serverPublicKeyOrSecret);

    if (!isSignatureValid) {
      callbacks.onFailed(taskId, "INVALID_SIGNATURE", "Task authorization signature verification failed.", 0);
      return;
    }

    // 3. Arguments Hash Verification
    const serializedParams = JSON.stringify(frame.parameters);
    const computedArgsHash = crypto.createHash("sha256").update(serializedParams).digest("hex");
    if (computedArgsHash !== frame.argumentsHash) {
      callbacks.onFailed(
        taskId,
        "ARGUMENTS_HASH_MISMATCH",
        `Parameters hash mismatch (computed: ${computedArgsHash}, expected: ${frame.argumentsHash}).`,
        0
      );
      return;
    }

    // 4. Resolve Capability
    const capability = this.capabilityRegistry.get(frame.capability);
    if (!capability) {
      callbacks.onFailed(taskId, "UNKNOWN_CAPABILITY", `Capability '${frame.capability}' is not registered on this device.`, 0);
      return;
    }

    // 5. Verify Local Policy Permissions (Cloud cannot expand permissions beyond local device policy)
    const allowedRoots = this.policyService.getAllowedRoots();
    if (allowedRoots.length === 0) {
      callbacks.onFailed(taskId, "NO_ALLOWED_ROOTS", "No project directories are approved on this device. Run messiah-bridge policy.", 0);
      return;
    }

    // Notify server: Task accepted
    callbacks.onAccepted(taskId);

    // 6. Notify server: Task started
    callbacks.onStarted(taskId, this.sandbox.name);

    // Setup abort controller and log sequence
    const abortController = new AbortController();
    this.activeTaskControllers.set(taskId, abortController);
    this.logSequences.set(taskId, 1);

    const emitLog = (stream: "stdout" | "stderr" | "system", chunk: string) => {
      const seq = this.logSequences.get(taskId) || 1;
      this.logSequences.set(taskId, seq + 1);
      callbacks.onLog(taskId, seq, stream, chunk);
    };

    try {
      emitLog("system", `[Task] Initializing execution for capability '${frame.capability}'`);

      const executionContext = {
        taskId,
        deviceId: frame.deviceId,
        workspaceId: frame.workspaceId,
        policyService: this.policyService,
        sandbox: this.sandbox,
        allowedRoots,
        onLog: emitLog,
        onProgress: (percent: number, message: string) => callbacks.onProgress(taskId, percent, message),
      };

      const result = await capability.execute(executionContext, frame.parameters);
      const durationMs = Date.now() - startTime;

      emitLog("system", `[Task] Execution completed successfully in ${durationMs}ms`);
      callbacks.onCompleted(taskId, result, durationMs);
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);
      emitLog("system", `[Task] Error during execution: ${errorMsg}`);
      callbacks.onFailed(taskId, "EXECUTION_ERROR", errorMsg, durationMs);
    } finally {
      this.activeTaskControllers.delete(taskId);
      this.logSequences.delete(taskId);
    }
  }

  public cancelTask(taskId: string): boolean {
    const controller = this.activeTaskControllers.get(taskId);
    if (controller) {
      controller.abort();
      this.sandbox.terminate();
      this.activeTaskControllers.delete(taskId);
      return true;
    }
    return false;
  }
}
