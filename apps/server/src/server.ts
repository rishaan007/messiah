import { env } from "./config/env.js";
import { buildApp } from "./app.js";

async function start() {
  const app = await buildApp({ env });

  try {
    await app.listen({
      port: env.PORT,
      host: env.HOST,
    });
    app.log.info(
      `🚀 MESSIAH Backend running on http://${env.HOST}:${env.PORT} [${env.NODE_ENV}]`,
    );
  } catch (err) {
    app.log.fatal({ err }, "Failed to start Messiah Backend server");
    process.exit(1);
  }

  // Graceful shutdown handling
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  for (const signal of signals) {
    process.on(signal, async () => {
      app.log.info(`Received ${signal}. Initiating graceful shutdown...`);
      try {
        await app.close();
        app.log.info("Server and background connections closed cleanly.");
        process.exit(0);
      } catch (closeErr) {
        app.log.error({ err: closeErr }, "Error during graceful shutdown");
        process.exit(1);
      }
    });
  }
}

start();
