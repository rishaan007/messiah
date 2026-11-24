import { pino } from "pino";

export function createLogger(
  nodeEnv: string = "development",
  logLevel: string = "info",
) {
  const isDev = nodeEnv === "development";

  return pino({
    level: logLevel,
    transport: isDev
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss Z",
            ignore: "pid,hostname",
          },
        }
      : undefined,
  });
}
