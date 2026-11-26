import fp from "fastify-plugin";
import helmet from "@fastify/helmet";
import type { FastifyPluginAsync } from "fastify";

const helmetPlugin: FastifyPluginAsync = async (fastify) => {
  const isProduction = process.env.NODE_ENV === "production";

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
        connectSrc: isProduction
          ? ["'self'", "https:", "wss:"]
          : ["'self'", "https:", "wss:", "http://localhost:*", "ws://localhost:*"],
      },
    },
    strictTransportSecurity: isProduction
      ? {
          maxAge: 31536000,
          includeSubDomains: true,
        }
      : false,
    crossOriginEmbedderPolicy: false,
  });
};

export default fp(helmetPlugin, {
  name: "helmet-plugin",
});
