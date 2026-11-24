import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ServerEnvSchema, type ServerEnv } from "@messiah/shared";

// Load .env from workspace root if available
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
dotenv.config(); // fallback to local directory .env

export function loadAndValidateEnv(
  overrides?: Partial<Record<string, unknown>>,
): ServerEnv {
  const merged = { ...process.env, ...overrides };
  const parsed = ServerEnvSchema.safeParse(merged);

  if (!parsed.success) {
    const errorDetails = parsed.error.issues
      .map((issue) => `  - [${issue.path.join(".")}]: ${issue.message}`)
      .join("\n");
    throw new Error(
      `[FATAL] Invalid server environment configuration:\n${errorDetails}\n\nPlease check your .env file against .env.example.`,
    );
  }

  return parsed.data;
}

export const env = loadAndValidateEnv();
