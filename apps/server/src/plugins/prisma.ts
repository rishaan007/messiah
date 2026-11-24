import fp from "fastify-plugin";
import { prisma, checkDatabaseHealth, type PrismaClient } from "@messiah/db";
import type { FastifyPluginAsync } from "fastify";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
    checkDbHealth: typeof checkDatabaseHealth;
  }
}

const prismaPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorate("prisma", prisma);
  fastify.decorate("checkDbHealth", checkDatabaseHealth);

  fastify.addHook("onClose", async (instance) => {
    instance.log.info("Closing Prisma database connection pool...");
    await instance.prisma.$disconnect();
  });
};

export default fp(prismaPlugin, {
  name: "prisma-plugin",
});
