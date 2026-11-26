import { pino } from "pino";

export const LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-supabase-auth']",
  "*.apiKey",
  "*.password",
  "*.secret",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.ciphertext",
  "*.privateKey",
  "*.pairingCode",
  "*.bearerToken",
  "*.nativePushToken",
  "*.pushP256dh",
  "*.pushAuth",
];

export function createLogger(
  nodeEnv: string = "development",
  logLevel: string = "info",
) {
  const isDev = nodeEnv === "development";

  return pino({
    level: logLevel,
    redact: {
      paths: LOG_REDACT_PATHS,
      censor: "[REDACTED]",
    },
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
