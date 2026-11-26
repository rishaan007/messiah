import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ServerEnvSchema, type ServerEnv } from "@messiah/shared";

// Load .env from workspace root if available
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
dotenv.config(); // fallback to local directory .env

const KNOWN_DEV_PLACEHOLDER_VAULT_KEYS = new Set([
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "messiah_dev_vault_key_replace_in_production_32_bytes",
]);

/**
 * Fail-closed security validation enforced when NODE_ENV === "production".
 * Ensures servers never boot with missing auth keys, wildcard CORS, or example dev vault keys.
 */
export function validateProductionSecurityConfig(config: ServerEnv): void {
  if (config.NODE_ENV !== "production") {
    return;
  }

  const violations: string[] = [];

  if (!config.VAULT_ENCRYPTION_KEY || KNOWN_DEV_PLACEHOLDER_VAULT_KEYS.has(config.VAULT_ENCRYPTION_KEY)) {
    violations.push(
      "VAULT_ENCRYPTION_KEY must be set to a unique cryptographically random key (never use the dev example placeholder)."
    );
  }

  if (!config.SUPABASE_JWT_SECRET && !config.SUPABASE_URL) {
    violations.push(
      "Authentication verification requires SUPABASE_JWT_SECRET or SUPABASE_URL in production."
    );
  }

  const allowedOriginsRaw = (config.MESSIAH_ALLOWED_ORIGINS || config.CORS_ORIGIN || "").trim();
  if (!allowedOriginsRaw) {
    violations.push(
      "MESSIAH_ALLOWED_ORIGINS (or explicit CORS_ORIGIN) must be configured in production."
    );
  } else {
    const origins = allowedOriginsRaw.split(",").map((s) => s.trim()).filter(Boolean);
    if (origins.includes("*")) {
      violations.push(
        "Wildcard origin '*' is prohibited in production CORS / WebSocket configuration."
      );
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `[FATAL] Production security configuration violation:\n${violations.map((v) => `  - ${v}`).join("\n")}`
    );
  }
}

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

  validateProductionSecurityConfig(parsed.data);

  return parsed.data;
}

export const env = loadAndValidateEnv();
