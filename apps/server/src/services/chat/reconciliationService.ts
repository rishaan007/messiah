import { prisma } from "@messiah/db";

export class ReconciliationService {
  /**
   * Scans the database for any active runs or messages that were left in STREAMING
   * or PENDING status due to unexpected process termination or server restart.
   *
   * In a distributed cluster, healthy worker instances periodically update the
   * message/run checkpoint (every 1.5s). To ensure we do NOT terminate healthy jobs
   * actively running on another worker instance, we only reconcile runs that have
   * ceased heartbeat/checkpoint updates for longer than staleThresholdMs.
   */
  public static async reconcileOrphanedRuns(
    staleThresholdMs: number = process.env.NODE_ENV === "test" ? 0 : 60_000
  ): Promise<{ reconciledRuns: number; reconciledMessages: number }> {
    try {
      const now = new Date();
      const staleDate = new Date(now.getTime() - staleThresholdMs);

      // 1. Reconcile unfinished GenerationRuns that have exceeded the stale threshold
      const updatedRuns = await prisma.generationRun.updateMany({
        where: {
          status: { in: ["PENDING", "STREAMING"] },
          updatedAt: { lte: staleDate },
        },
        data: {
          status: "FAILED",
          safeErrorCode: "SERVER_RESTARTED_DURING_EXECUTION",
          completedAt: now,
        },
      });

      // 2. Reconcile unfinished Assistant Messages that have exceeded the stale threshold
      const updatedMessages = await prisma.message.updateMany({
        where: {
          status: { in: ["PENDING", "STREAMING"] },
          role: "ASSISTANT",
          updatedAt: { lte: staleDate },
        },
        data: {
          status: "FAILED",
          completedAt: now,
        },
      });

      // 3. Reconcile unfinished Swarm AgentRuns & active tasks/executions left running across restart
      const updatedSwarms = await prisma.agentRun.updateMany({
        where: {
          status: { in: ["PENDING", "PLANNING", "RUNNING", "SYNTHESIZING"] },
          updatedAt: { lte: staleDate },
        },
        data: {
          status: "FAILED",
          safeErrorCode: "SERVER_RESTARTED_DURING_EXECUTION",
          errorMessage: "Worker or server restarted while swarm orchestration was in progress.",
          completedAt: now,
        },
      });

      if (updatedSwarms.count > 0) {
        await prisma.agentTask.updateMany({
          where: {
            status: { in: ["QUEUED", "RUNNING"] },
            updatedAt: { lte: staleDate },
          },
          data: {
            status: "UNKNOWN_OUTCOME",
            errorCode: "SERVER_RESTARTED_DURING_EXECUTION",
            completedAt: now,
          },
        });
        await prisma.agentExecution.updateMany({
          where: {
            status: "RUNNING",
            startedAt: { lte: staleDate },
          },
          data: {
            status: "UNKNOWN_OUTCOME",
            errorMessage: "Server restarted during execution.",
            completedAt: now,
          },
        });
      }

      if (updatedRuns.count > 0 || updatedMessages.count > 0 || updatedSwarms.count > 0) {
        console.warn(
          `[ReconciliationService] Reconciled ${updatedRuns.count} orphaned generation runs, ${updatedMessages.count} messages, and ${updatedSwarms.count} swarm runs after restart.`
        );
      }

      return {
        reconciledRuns: updatedRuns.count,
        reconciledMessages: updatedMessages.count,
      };
    } catch (err) {
      console.error("[ReconciliationService] Error during startup run reconciliation:", err);
      return { reconciledRuns: 0, reconciledMessages: 0 };
    }
  }
}
