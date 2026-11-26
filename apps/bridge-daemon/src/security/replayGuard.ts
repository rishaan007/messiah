import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export class ReplayGuardCorruptedError extends Error {
  public readonly code = "REPLAY_STORE_CORRUPTED";

  constructor(message: string) {
    super(message);
    this.name = "ReplayGuardCorruptedError";
  }
}

interface ReplayStateData {
  nonces: Record<string, number>; // nonce -> expiresAt
  consumedApprovals: Record<string, number>; // approvalReference -> recordedAt
  taskStates: Record<string, { state: "ACTIVE" | "AWAITING_APPROVAL" | "TERMINAL"; updatedAt: number }>;
}

interface ReplayStateFileV2 extends ReplayStateData {
  version: 2;
  checksum: string;
}

function isPlainNumberRecord(val: unknown): val is Record<string, number> {
  if (!val || typeof val !== "object" || Array.isArray(val)) return false;
  for (const v of Object.values(val)) {
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
  }
  return true;
}

function isValidTaskStates(
  val: unknown
): val is Record<string, { state: "ACTIVE" | "AWAITING_APPROVAL" | "TERMINAL"; updatedAt: number }> {
  if (!val || typeof val !== "object" || Array.isArray(val)) return false;
  for (const v of Object.values(val)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) return false;
    const entry = v as { state?: unknown; updatedAt?: unknown };
    if (
      entry.state !== "ACTIVE" &&
      entry.state !== "AWAITING_APPROVAL" &&
      entry.state !== "TERMINAL"
    ) {
      return false;
    }
    if (typeof entry.updatedAt !== "number" || !Number.isFinite(entry.updatedAt)) {
      return false;
    }
  }
  return true;
}

/**
 * Persistent Replay & Deduplication Guard.
 * Survives Bridge daemon restarts by atomically persisting nonces, consumed approval references,
 * and terminal task identifiers to disk with 0600 permissions and SHA-256 integrity verification.
 *
 * FAIL-CLOSED INVARIANT:
 * If an existing replay store on disk is corrupted, truncated, or tampered with, ReplayGuard
 * refuses to silently reset to an empty state and blocks all replay/execution checks.
 */
export class ReplayGuard {
  private storagePath: string | null = null;
  private corruptedReason: string | null = null;
  private persistCounter = 0;
  private state: ReplayStateData = {
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

  public isCorrupted(): boolean {
    return this.corruptedReason !== null;
  }

  public getCorruptedReason(): string | null {
    return this.corruptedReason;
  }

  public assertHealthy(): void {
    if (this.corruptedReason !== null) {
      throw new ReplayGuardCorruptedError(
        `Persistent replay guard store is corrupted and failed closed: ${this.corruptedReason}`
      );
    }
  }

  private static computeChecksum(data: ReplayStateData): string {
    // Canonical deterministic ordering for object keys
    const canonical = JSON.stringify({
      version: 2,
      nonces: Object.fromEntries(Object.entries(data.nonces).sort(([a], [b]) => a.localeCompare(b))),
      consumedApprovals: Object.fromEntries(
        Object.entries(data.consumedApprovals).sort(([a], [b]) => a.localeCompare(b))
      ),
      taskStates: Object.fromEntries(Object.entries(data.taskStates).sort(([a], [b]) => a.localeCompare(b))),
    });
    return crypto.createHash("sha256").update(canonical).digest("hex");
  }

  private loadFromDisk(): void {
    if (!this.storagePath || !fs.existsSync(this.storagePath)) {
      return;
    }
    try {
      const raw = fs.readFileSync(this.storagePath, "utf-8");
      if (!raw.trim()) {
        this.corruptedReason = "Replay store file exists but is empty (truncated write).";
        return;
      }

      const parsed = JSON.parse(raw) as Partial<ReplayStateFileV2>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        this.corruptedReason = "Replay store JSON is not an object.";
        return;
      }

      if (
        !isPlainNumberRecord(parsed.nonces) ||
        !isPlainNumberRecord(parsed.consumedApprovals) ||
        !isValidTaskStates(parsed.taskStates)
      ) {
        this.corruptedReason = "Replay store schema validation failed (malformed maps).";
        return;
      }

      const loadedData: ReplayStateData = {
        nonces: parsed.nonces,
        consumedApprovals: parsed.consumedApprovals,
        taskStates: parsed.taskStates,
      };

      // Reject tampered or mismatched checksums on v2 files; if no version/checksum, require exact valid legacy shape ONLY when version === undefined and checksum === undefined
      if (parsed.version !== undefined || parsed.checksum !== undefined) {
        if (parsed.version !== 2 || typeof parsed.checksum !== "string") {
          this.corruptedReason = "Unsupported or malformed replay store version/checksum.";
          return;
        }
        const expected = ReplayGuard.computeChecksum(loadedData);
        if (
          parsed.checksum.length !== expected.length ||
          !crypto.timingSafeEqual(Buffer.from(parsed.checksum, "utf-8"), Buffer.from(expected, "utf-8"))
        ) {
          this.corruptedReason = "Replay store SHA-256 integrity checksum mismatch.";
          return;
        }
      }

      this.state = loadedData;
      this.pruneExpired();
    } catch (err) {
      this.corruptedReason = err instanceof Error ? err.message : "Failed to parse replay store JSON.";
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
    this.assertHealthy();
    if (!this.storagePath) return;

    this.pruneExpired();
    const dir = path.dirname(this.storagePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const checksum = ReplayGuard.computeChecksum(this.state);
    const payload: ReplayStateFileV2 = {
      version: 2,
      checksum,
      nonces: this.state.nonces,
      consumedApprovals: this.state.consumedApprovals,
      taskStates: this.state.taskStates,
    };

    const serialized = JSON.stringify(payload);
    this.persistCounter += 1;
    const tmp = `${this.storagePath}.tmp.${process.pid}.${this.persistCounter}.${crypto.randomBytes(4).toString("hex")}`;
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      fs.writeFileSync(fd, serialized, "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.storagePath);
  }

  public checkAndRecordNonce(nonce: string, expiresAt: number): boolean {
    this.assertHealthy();
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
    this.assertHealthy();
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
    this.assertHealthy();
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
    this.assertHealthy();
    this.state.taskStates[taskId] = { state: "AWAITING_APPROVAL", updatedAt: Date.now() };
    this.persistToDisk();
  }

  public markTaskTerminal(taskId: string): void {
    this.assertHealthy();
    this.state.taskStates[taskId] = { state: "TERMINAL", updatedAt: Date.now() };
    this.persistToDisk();
  }

  public clearState(): void {
    this.corruptedReason = null;
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
