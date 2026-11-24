import fp from "fastify-plugin";
import helmet from "@fastify/helmet";
import type { FastifyPluginAsync } from "fastify";

const helmetPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        fontSrc: ["'self'", "https:", "data:"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:", "https:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "https:", "'unsafe-inline'"],
      },
    },
    crossOriginEmbedderPolicy: false, // Allows cross-origin asset sharing for web clients
  });
};

export default fp(helmetPlugin, {
  name: "helmet-plugin",
});
