import fp from "fastify-plugin";
import cors, { type FastifyCorsOptions } from "@fastify/cors";
import type { FastifyPluginAsync } from "fastify";

export interface CorsPluginOptions {
  origin: string;
}

const corsPlugin: FastifyPluginAsync<CorsPluginOptions> = async (
  fastify,
  opts,
) => {
  const allowedOrigins = opts.origin.split(",").map((o) => o.trim());

  const corsOptions: FastifyCorsOptions = {
    origin: (origin, cb) => {
      // Allow requests with no origin (like mobile apps, curl, or server-to-server)
      if (!origin) {
        cb(null, true);
        return;
      }
      if (allowedOrigins.includes(origin) || allowedOrigins.includes("*")) {
        cb(null, true);
        return;
      }
      cb(new Error(`CORS origin '${origin}' is not allowed`), false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "Sec-WebSocket-Protocol",
    ],
  };

  await fastify.register(cors, corsOptions);
};

export default fp(corsPlugin, {
  name: "cors-plugin",
});
