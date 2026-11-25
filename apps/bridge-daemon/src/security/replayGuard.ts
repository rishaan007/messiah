export class ReplayGuard {
  private static readonly seenNonces = new Set<string>();
  private static readonly taskExecutionHistory = new Map<string, number>();

  /**
   * Verifies that the task nonce has not been seen before, preventing replay attacks.
   */
  public static checkAndRecordNonce(nonce: string, expiresAt: number): boolean {
    const now = Date.now();
    if (now > expiresAt) {
      return false; // Already expired
    }

    if (this.seenNonces.has(nonce)) {
      return false; // Replay detected
    }

    this.seenNonces.add(nonce);

    // Auto-clean expired nonces
    const ttl = Math.max(0, expiresAt - now);
    setTimeout(() => {
      this.seenNonces.delete(nonce);
    }, ttl + 10_000);

    return true;
  }

  /**
   * Verifies task deduplication to prevent duplicate concurrent execution.
   */
  public static isDuplicateTask(taskId: string): boolean {
    if (this.taskExecutionHistory.has(taskId)) {
      return true;
    }
    this.taskExecutionHistory.set(taskId, Date.now());

    // Retain in history for 1 hour to prevent duplicate replays
    setTimeout(() => {
      this.taskExecutionHistory.delete(taskId);
    }, 3600_000);

    return false;
  }

  public static clear(): void {
    this.seenNonces.clear();
    this.taskExecutionHistory.clear();
  }
}
