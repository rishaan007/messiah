import fp from "fastify-plugin";
import cors, { type FastifyCorsOptions } from "@fastify/cors";
import type { FastifyPluginAsync } from "fastify";

export interface CorsPluginOptions {
  origin: string;
  extraOrigins?: string;
}

const corsPlugin: FastifyPluginAsync<CorsPluginOptions> = async (
  fastify,
  opts,
) => {
  const combinedRaw = [opts.origin, opts.extraOrigins || process.env.MESSIAH_ALLOWED_ORIGINS || ""]
    .filter(Boolean)
    .join(",");

  const allowedOrigins = Array.from(
    new Set(
      combinedRaw
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean)
    )
  );

  const isProduction = process.env.NODE_ENV === "production";

  const corsOptions: FastifyCorsOptions = {
    origin: (origin, cb) => {
      // Non-browser tooling, mobile native HTTP clients, or server probes
      if (!origin) {
        cb(null, true);
        return;
      }

      if (allowedOrigins.includes(origin)) {
        cb(null, true);
        return;
      }

      if (!isProduction && allowedOrigins.includes("*")) {
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
      "X-Messiah-Client",
    ],
  };

  await fastify.register(cors, corsOptions);
};

export default fp(corsPlugin, {
  name: "cors-plugin",
});
