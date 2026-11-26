import fs from "node:fs";
import path from "node:path";
import os from "node:os";

interface ReplayStateFile {
  nonces: Record<string, number>; // nonce -> expiresAt
  consumedApprovals: Record<string, number>; // approvalReference -> recordedAt
  taskStates: Record<string, { state: "ACTIVE" | "AWAITING_APPROVAL" | "TERMINAL"; updatedAt: number }>;
}

/**
 * Persistent Replay & Deduplication Guard.
 * Survives Bridge daemon restarts by atomically persisting nonces, consumed approval references,
 * and terminal task identifiers to disk with 0600 permissions.
 */
export class ReplayGuard {
  private storagePath: string | null = null;
  private state: ReplayStateFile = {
    nonces: {},
    consumedApprovals: {},
    taskStates: {},
  };

  private static defaultInstance: ReplayGuard | null = null;

  constructor(customDir?: string) {
    if (customDir) {
      this.storagePath = path.join(customDir, "replay_guard.json");
      this.loadFromDisk();
    } else {
      const dir = path.join(os.homedir(), ".messiah", "bridge");
      this.storagePath = path.join(dir, "replay_guard.json");
      this.loadFromDisk();
    }
  }

  private static getDefault(): ReplayGuard {
    if (!this.defaultInstance) {
      this.defaultInstance = new ReplayGuard();
    }
    return this.defaultInstance;
  }

  private loadFromDisk(): void {
    if (!this.storagePath || !fs.existsSync(this.storagePath)) {
      return;
    }
    try {
      const raw = fs.readFileSync(this.storagePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<ReplayStateFile>;
      this.state = {
        nonces: parsed.nonces || {},
        consumedApprovals: parsed.consumedApprovals || {},
        taskStates: parsed.taskStates || {},
      };
      this.pruneExpired();
    } catch {
      this.state = { nonces: {}, consumedApprovals: {}, taskStates: {} };
    }
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [nonce, exp] of Object.entries(this.state.nonces)) {
      // Keep nonces slightly past expiry for clock skew defense
      if (now > exp + 60_000) {
        delete this.state.nonces[nonce];
      }
    }
    // Prune taskStates older than 24h
    for (const [tid, entry] of Object.entries(this.state.taskStates)) {
      if (now - entry.updatedAt > 24 * 60 * 60 * 1000) {
        delete this.state.taskStates[tid];
      }
    }
    // Prune consumedApprovals older than 24h
    for (const [aid, ts] of Object.entries(this.state.consumedApprovals)) {
      if (now - ts > 24 * 60 * 60 * 1000) {
        delete this.state.consumedApprovals[aid];
      }
    }
  }

  private persistToDisk(): void {
    if (!this.storagePath) return;
    try {
      this.pruneExpired();
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      const tmp = `${this.storagePath}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
      fs.renameSync(tmp, this.storagePath);
    } catch {}
  }

  public checkAndRecordNonce(nonce: string, expiresAt: number): boolean {
    const now = Date.now();
    if (now > expiresAt) {
      return false;
    }
    if (Object.prototype.hasOwnProperty.call(this.state.nonces, nonce)) {
      return false;
    }
    this.state.nonces[nonce] = expiresAt;
    this.persistToDisk();
    return true;
  }

  public checkAndConsumeApprovalReference(approvalReference: string): boolean {
    if (!approvalReference) return false;
    if (Object.prototype.hasOwnProperty.call(this.state.consumedApprovals, approvalReference)) {
      return false;
    }
    this.state.consumedApprovals[approvalReference] = Date.now();
    this.persistToDisk();
    return true;
  }

  /**
   * Validates whether a taskId may enter execution.
   * Allows initial execution or resumption from AWAITING_APPROVAL with a valid approvalReference.
   * Rejects duplicate active execution or replay of TERMINAL tasks.
   */
  public beginTaskExecution(taskId: string, hasApprovalReference: boolean): boolean {
    const existing = this.state.taskStates[taskId];
    if (existing) {
      if (existing.state === "TERMINAL" || existing.state === "ACTIVE") {
        return false;
      }
      if (existing.state === "AWAITING_APPROVAL" && !hasApprovalReference) {
        return false;
      }
    }
    this.state.taskStates[taskId] = { state: "ACTIVE", updatedAt: Date.now() };
    this.persistToDisk();
    return true;
  }

  public markTaskAwaitingApproval(taskId: string): void {
    this.state.taskStates[taskId] = { state: "AWAITING_APPROVAL", updatedAt: Date.now() };
    this.persistToDisk();
  }

  public markTaskTerminal(taskId: string): void {
    this.state.taskStates[taskId] = { state: "TERMINAL", updatedAt: Date.now() };
    this.persistToDisk();
  }

  public clearState(): void {
    this.state = { nonces: {}, consumedApprovals: {}, taskStates: {} };
    this.persistToDisk();
  }

  // Static compatibility helpers backed by default persistent instance
  public static checkAndRecordNonce(nonce: string, expiresAt: number): boolean {
    return this.getDefault().checkAndRecordNonce(nonce, expiresAt);
  }

  public static isDuplicateTask(taskId: string, hasApprovalReference = false): boolean {
    return !this.getDefault().beginTaskExecution(taskId, hasApprovalReference);
  }

  public static clear(): void {
    this.getDefault().clearState();
  }
}
