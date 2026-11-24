import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env["NODE_ENV"] === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env["NODE_ENV"] !== "production") {
  globalForPrisma.prisma = prisma;
}

export async function checkDatabaseHealth(): Promise<{
  isHealthy: boolean;
  latencyMs: number;
  error?: string;
}> {
  const start = performance.now();
  try {
    // Standard SELECT 1 query to verify connection pool and responsiveness
    await prisma.$queryRawUnsafe("SELECT 1");
    const latencyMs = Math.round(performance.now() - start);
    return {
      isHealthy: true,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    const errorMessage =
      err instanceof Error ? err.message : "Unknown database error";
    return {
      isHealthy: false,
      latencyMs,
      error: errorMessage,
    };
  }
}
