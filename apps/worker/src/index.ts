import dotenv from "dotenv";
dotenv.config();

import { WorkflowSchedulerEngine } from "@messiah/workflows";
import { ChatGenerationWorker } from "./worker.js";
import { OutboxDispatcher } from "./dispatcher.js";

async function main() {
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6380";
  const concurrency = Number(process.env.WORKER_CONCURRENCY) || 5;

  console.log(`[Messiah Worker] Initializing with Redis at ${redisUrl} (concurrency: ${concurrency})...`);

  const worker = new ChatGenerationWorker(redisUrl, concurrency);
  await worker.start();

  const dispatcher = new OutboxDispatcher(redisUrl);
  dispatcher.startPeriodicSweep(5000);
  console.log(`[Messiah Worker] Outbox dispatcher running periodic sweep every 5000ms.`);

  const workflowScheduler = new WorkflowSchedulerEngine(async () => {
    await dispatcher.sweep();
  });
  workflowScheduler.startPeriodicSweep(15_000);
  console.log(`[Messiah Worker] Durable Workflow cron scheduler running every 15000ms.`);

  const shutdown = async (signal: string) => {
    console.log(`[Messiah Worker] Received ${signal}. Shutting down worker gracefully...`);
    workflowScheduler.stop();
    await dispatcher.close();
    await worker.close();
    console.log(`[Messiah Worker] Shutdown complete.`);
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[Messiah Worker] Fatal error starting worker service:", err);
  process.exit(1);
});
