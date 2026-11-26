import os from "node:os";

/**
 * Strict Environment Allowlist Builder.
 * NEVER copies process.env directly and relies on a blocklist.
 * Constructs an isolated minimal environment from scratch and rejects secret-like keys.
 */
export class EnvAllowlist {
  private static readonly BASE_SAFE_PATH =
    os.platform() === "win32"
      ? "C:\\Windows\\System32;C:\\Windows;C:\\Program Files\\nodejs"
      : "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

  private static readonly SECRET_KEY_PATTERN =
    /(TOKEN|SECRET|KEY|PASSWORD|PASSPHRASE|AUTH|CREDENTIAL|DATABASE_URL|REDIS_URL|VAULT|SUPABASE|PRIVATE|COOKIE|SESSION|JWT|BEARER)/i;

  private static readonly ALLOWED_CUSTOM_KEYS = new Set([
    "NODE_ENV",
    "LANG",
    "LC_ALL",
    "TERM",
    "TZ",
    "CI",
    "NO_COLOR",
    "FORCE_COLOR",
    "PYTHONUNBUFFERED",
    "PYTHONPATH",
    "CARGO_HOME",
    "GOPATH",
    "NPM_CONFIG_CACHE",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
  ]);

  public static build(options: {
    isolatedHome: string;
    isolatedTmp: string;
    customEnv?: Record<string, string>;
    explicitAllowedKeys?: string[];
  }): Record<string, string> {
    const safePath = process.env.PATH
      ? process.env.PATH.split(os.platform() === "win32" ? ";" : ":")
          .filter((p) => {
            // Only preserve system/toolchain directories, never user desktop/secret dirs
            const lower = p.toLowerCase();
            return (
              lower.startsWith("/usr/") ||
              lower.startsWith("/bin") ||
              lower.startsWith("/sbin") ||
              lower.startsWith("/opt/homebrew") ||
              lower.startsWith("/library") ||
              lower.includes("nodejs") ||
              lower.includes(".nvm") ||
              lower.includes("c:\\windows") ||
              lower.includes("program files")
            );
          })
          .join(os.platform() === "win32" ? ";" : ":") || this.BASE_SAFE_PATH
      : this.BASE_SAFE_PATH;

    const env: Record<string, string> = {
      PATH: safePath,
      HOME: options.isolatedHome,
      TMPDIR: options.isolatedTmp,
      TEMP: options.isolatedTmp,
      TMP: options.isolatedTmp,
      USER: "messiah-sandbox",
      LOGNAME: "messiah-sandbox",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TERM: "xterm-256color",
      NODE_ENV: "production",
    };

    if (options.customEnv) {
      const explicitAllow = new Set(options.explicitAllowedKeys || []);
      for (const [key, value] of Object.entries(options.customEnv)) {
        if (typeof value !== "string") continue;
        // Reject any credential-like key unless explicitly listed by administrator
        if (this.SECRET_KEY_PATTERN.test(key) && !explicitAllow.has(key)) {
          continue;
        }
        if (this.ALLOWED_CUSTOM_KEYS.has(key) || explicitAllow.has(key)) {
          env[key] = value;
        }
      }
    }

    return env;
  }
}
