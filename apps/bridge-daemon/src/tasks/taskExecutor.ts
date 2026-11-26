import crypto from "node:crypto";
import type { DeviceTaskDispatchFrame } from "@messiah/shared";
import { CapabilityRegistry } from "../capabilities/capabilityRegistry.js";
import { LocalDevicePolicyService } from "../security/localDevicePolicy.js";
import { ReplayGuard } from "../security/replayGuard.js";
import { TaskSignatureVerifier } from "../security/taskSignatureVerifier.js";
import { LogRedactor } from "../security/logRedactor.js";
import { ProcessSandbox } from "../sandbox/processSandbox.js";
import { SandboxUnavailableError, type ISandboxProvider } from "../sandbox/sandboxInterface.js";

export interface TaskVerificationContext {
  hmacSecret: string;
  expectedDeviceId: string;
  expectedWorkspaceId?: string;
  expectedProtocolVersion?: string;
  expectedAudience?: string;
}

export interface TaskExecutorCallbacks {
  onAccepted(taskId: string): void;
  onStarted(taskId: string, sandboxProfile: string): void;
  onProgress(taskId: string, percent: number, message: string): void;
  onLog(taskId: string, sequence: number, stream: "stdout" | "stderr" | "system", chunk: string): void;
  onApprovalRequired?(
    taskId: string,
    approval: {
      operation: string;
      summary: string;
      details: Record<string, unknown>;
      argumentsHash: string;
      nonce: string;
      expiresAt: number;
    }
  ): void;
  onCompleted(taskId: string, result: Record<string, unknown>, durationMs: number): void;
  onFailed(taskId: string, code: string, message: string, durationMs: number): void;
  onCancelled?(taskId: string, reason: string): void;
  onUnknownOutcome?(taskId: string, reason: string): void;
}

export class TaskExecutor {
  private readonly capabilityRegistry: CapabilityRegistry;
  private readonly policyService: LocalDevicePolicyService;
  private readonly sandbox: ISandboxProvider;
  private readonly replayGuard: ReplayGuard;
  private readonly activeTaskIds = new Set<string>();
  private readonly cancelledTasks = new Set<string>();
  private logSequences = new Map<string, number>();

  constructor(customDir?: string, sandbox?: ISandboxProvider) {
    this.policyService = new LocalDevicePolicyService(customDir);
    this.sandbox = sandbox || new ProcessSandbox();
    this.replayGuard = new ReplayGuard(customDir);
    this.capabilityRegistry = new CapabilityRegistry(customDir);
  }

  public getPolicyService(): LocalDevicePolicyService {
    return this.policyService;
  }

  public getCapabilityRegistry(): CapabilityRegistry {
    return this.capabilityRegistry;
  }

  public getReplayGuard(): ReplayGuard {
    return this.replayGuard;
  }

  private buildApprovalPreview(frame: DeviceTaskDispatchFrame): {
    operation: string;
    summary: string;
    details: Record<string, unknown>;
  } {
    const params = frame.parameters || {};
    if (frame.capability === "process.run") {
      return {
        operation: frame.capability,
        summary: `Execute sandboxed command '${String(params.executable || "")}' in '${String(params.cwd || frame.resourceScopes[0] || "")}'`,
        details: {
          executable: params.executable,
          args: params.args || [],
          cwd: params.cwd || frame.resourceScopes[0] || "",
          resourceScopes: frame.resourceScopes,
          networkAllowed: Boolean(this.policyService.getPolicy().networkAllowed),
        },
      };
    }

    if (frame.capability === "filesystem.modify" || frame.capability === "filesystem.delete") {
      return {
        operation: frame.capability,
        summary: `${frame.capability === "filesystem.delete" ? "Delete" : "Modify"} local file '${String(params.relativePath || "")}'`,
        details: {
          rootPath: params.rootPath || frame.resourceScopes[0] || "",
          relativePath: params.relativePath,
          expectedPreviousHash: params.expectedPreviousHash || null,
          proposedLength: typeof params.newContent === "string" ? params.newContent.length : undefined,
        },
      };
    }

    if (frame.capability === "mcp.invoke") {
      return {
        operation: frame.capability,
        summary: `Invoke local MCP tool '${String(params.serverName || "")}.${String(params.toolName || "")}'`,
        details: {
          mcpServerName: frame.mcpServerName || params.serverName,
          mcpSchemaHash: frame.mcpSchemaHash || null,
          toolName: params.toolName,
          arguments: params.arguments || {},
          resourceScopes: frame.resourceScopes,
        },
      };
    }

    return {
      operation: frame.capability,
      summary: `Authorize workstation capability '${frame.capability}'`,
      details: {
        resourceScopes: frame.resourceScopes,
        parameters: params,
      },
    };
  }

  /**
   * Executes a per-device HMAC-authenticated task received from Messiah Cloud.
   */
  public async executeTask(
    frame: DeviceTaskDispatchFrame,
    verificationCtx: TaskVerificationContext | string,
    callbacks: TaskExecutorCallbacks
  ): Promise<void> {
    const startTime = Date.now();
    const { taskId } = frame;

    const ctx: TaskVerificationContext =
      typeof verificationCtx === "string"
        ? { hmacSecret: verificationCtx, expectedDeviceId: frame.deviceId }
        : verificationCtx;

    // 1. Validate Per-Device Identity, Workspace, Protocol Version & Audience
    if (!ctx.hmacSecret) {
      callbacks.onFailed(taskId, "MISSING_SIGNING_KEY", "Per-device HMAC signing key is not provisioned.", 0);
      return;
    }

    if (frame.deviceId !== ctx.expectedDeviceId) {
      callbacks.onFailed(
        taskId,
        "DEVICE_ID_MISMATCH",
        `Authorization target device '${frame.deviceId}' does not match this workstation '${ctx.expectedDeviceId}'.`,
        0
      );
      return;
    }

    if (ctx.expectedWorkspaceId && frame.workspaceId !== ctx.expectedWorkspaceId) {
      callbacks.onFailed(taskId, "WORKSPACE_ID_MISMATCH", "Workspace authorization mismatch.", 0);
      return;
    }

    if (ctx.expectedProtocolVersion && frame.protocolVersion && frame.protocolVersion !== ctx.expectedProtocolVersion) {
      callbacks.onFailed(taskId, "PROTOCOL_VERSION_MISMATCH", "Task protocol version mismatch.", 0);
      return;
    }

    if (ctx.expectedAudience && frame.serverAudience && frame.serverAudience !== ctx.expectedAudience) {
      callbacks.onFailed(taskId, "AUDIENCE_MISMATCH", "Task server audience mismatch.", 0);
      return;
    }

    // 2. Expiration & Clock Skew Validation
    const now = Date.now();
    if (now > frame.expiresAt) {
      callbacks.onFailed(taskId, "TASK_EXPIRED", "Task authorization envelope has expired.", 0);
      return;
    }
    if (frame.issuedAt > now + 60_000) {
      callbacks.onFailed(taskId, "INVALID_ISSUED_AT", "Task issuedAt timestamp is unreasonably in the future.", 0);
      return;
    }

    // 3. Persistent Nonce & Approval Reference Replay Checks
    if (!this.replayGuard.checkAndRecordNonce(frame.nonce, frame.expiresAt)) {
      callbacks.onFailed(taskId, "REPLAY_DETECTED", "Task nonce has already been consumed or replayed.", 0);
      return;
    }

    // 4. Cryptographic Per-Device HMAC-SHA256 Verification
    const canonicalPayload = TaskSignatureVerifier.formatCanonicalPayloadV2({
      taskId: frame.taskId,
      requestId: frame.requestId,
      deviceId: frame.deviceId,
      workspaceId: frame.workspaceId,
      capability: frame.capability,
      resourceScopes: frame.resourceScopes,
      argumentsHash: frame.argumentsHash,
      issuedAt: frame.issuedAt,
      expiresAt: frame.expiresAt,
      nonce: frame.nonce,
      policyVersion: frame.policyVersion,
      approvalReference: frame.approvalReference,
      protocolVersion: frame.protocolVersion,
      serverAudience: frame.serverAudience,
      mcpServerName: frame.mcpServerName,
      mcpSchemaHash: frame.mcpSchemaHash,
      executableIdentity: frame.executableIdentity,
    });

    if (!TaskSignatureVerifier.verifyHmacSignature(canonicalPayload, frame.serverSignature, ctx.hmacSecret)) {
      callbacks.onFailed(taskId, "INVALID_SIGNATURE", "Per-device HMAC-SHA256 authorization signature verification failed.", 0);
      return;
    }

    // 5. Arguments Hash Integrity Verification
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

    // 6. Task State & Single-Use Approval Reference Verification
    if (frame.approvalReference) {
      if (!this.replayGuard.checkAndConsumeApprovalReference(frame.approvalReference)) {
        callbacks.onFailed(taskId, "APPROVAL_ALREADY_CONSUMED", "Single-use approval reference has already been consumed.", 0);
        return;
      }
    }

    if (!this.replayGuard.beginTaskExecution(taskId, Boolean(frame.approvalReference))) {
      callbacks.onFailed(taskId, "DUPLICATE_TASK", "Task is already executing or has already terminated.", 0);
      return;
    }

    // 7. Resolve Capability
    const capability = this.capabilityRegistry.get(frame.capability);
    if (!capability) {
      this.replayGuard.markTaskTerminal(taskId);
      callbacks.onFailed(taskId, "UNKNOWN_CAPABILITY", `Capability '${frame.capability}' is not registered on this device.`, 0);
      return;
    }

    // 8. Verify Local Policy Allowed Roots
    const allowedRoots = this.policyService.getAllowedRoots();
    if (allowedRoots.length === 0) {
      this.replayGuard.markTaskTerminal(taskId);
      callbacks.onFailed(taskId, "NO_ALLOWED_ROOTS", "No project directories are approved on this device.", 0);
      return;
    }

    // 9. Enforce Human Approval Gating (enabling capability in settings NEVER bypasses approval!)
    if (capability.requiresApproval && !frame.approvalReference) {
      this.replayGuard.markTaskAwaitingApproval(taskId);
      const preview = this.buildApprovalPreview(frame);
      if (callbacks.onApprovalRequired) {
        callbacks.onApprovalRequired(taskId, {
          ...preview,
          argumentsHash: frame.argumentsHash,
          nonce: crypto.randomBytes(16).toString("hex"),
          expiresAt: Date.now() + 300_000,
        });
      } else {
        callbacks.onFailed(
          taskId,
          "APPROVAL_REQUIRED",
          `Sensitive capability '${frame.capability}' requires explicit human approval.`,
          0
        );
      }
      return;
    }

    // 10. Fail-Closed OS Sandbox Check BEFORE Execution
    if (capability.requiresSandbox) {
      const avail = await this.sandbox.checkAvailability();
      if (!avail.available) {
        this.replayGuard.markTaskTerminal(taskId);
        callbacks.onLog(
          taskId,
          1,
          "system",
          LogRedactor.redact(`[Security] SANDBOX_UNAVAILABLE: ${avail.reason || "OS-enforced sandbox could not be initialized."}`)
        );
        callbacks.onFailed(
          taskId,
          "SANDBOX_UNAVAILABLE",
          avail.reason || "OS-enforced sandbox unavailable. Failing closed.",
          Date.now() - startTime
        );
        return;
      }
    }

    callbacks.onAccepted(taskId);
    callbacks.onStarted(taskId, this.sandbox.getCapabilities().providerName);

    this.activeTaskIds.add(taskId);
    this.logSequences.set(taskId, 1);

    const emitLog = (stream: "stdout" | "stderr" | "system", chunk: string) => {
      const seq = this.logSequences.get(taskId) || 1;
      this.logSequences.set(taskId, seq + 1);
      callbacks.onLog(taskId, seq, stream, LogRedactor.redact(chunk));
    };

    try {
      emitLog("system", `[Task] Executing capability '${frame.capability}' under OS sandbox '${this.sandbox.getCapabilities().providerName}'`);

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

      const paramsWithMeta = {
        ...frame.parameters,
        ...(frame.mcpSchemaHash ? { expectedSchemaHash: frame.mcpSchemaHash } : {}),
      };

      const result = await capability.execute(executionContext, paramsWithMeta);
      const durationMs = Date.now() - startTime;

      if (this.cancelledTasks.has(taskId)) {
        this.replayGuard.markTaskTerminal(taskId);
        callbacks.onCancelled?.(taskId, "Cancelled during execution.");
        return;
      }

      this.replayGuard.markTaskTerminal(taskId);
      emitLog("system", `[Task] Execution completed in ${durationMs}ms`);
      callbacks.onCompleted(taskId, result, durationMs);
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
      this.replayGuard.markTaskTerminal(taskId);

      if (this.cancelledTasks.has(taskId)) {
        callbacks.onCancelled?.(taskId, "Process tree terminated after cancellation.");
        return;
      }

      const errorMsg = LogRedactor.redact(err instanceof Error ? err.message : String(err));
      if (err instanceof SandboxUnavailableError) {
        emitLog("system", `[Security] SANDBOX_UNAVAILABLE: ${errorMsg}`);
        callbacks.onFailed(taskId, "SANDBOX_UNAVAILABLE", errorMsg, durationMs);
        return;
      }

      emitLog("system", `[Task] Error during execution: ${errorMsg}`);
      callbacks.onFailed(taskId, "EXECUTION_ERROR", errorMsg, durationMs);
    } finally {
      this.activeTaskIds.delete(taskId);
      this.cancelledTasks.delete(taskId);
      this.logSequences.delete(taskId);
    }
  }

  /**
   * Cancels a specific task, terminating ONLY its sandboxed process tree and awaiting exit confirmation.
   */
  public async cancelTask(taskId: string): Promise<{ terminated: boolean; confirmed: boolean }> {
    this.cancelledTasks.add(taskId);
    const terminated = await this.sandbox.terminate(taskId);
    this.replayGuard.markTaskTerminal(taskId);
    return { terminated, confirmed: terminated || !this.activeTaskIds.has(taskId) };
  }
}
