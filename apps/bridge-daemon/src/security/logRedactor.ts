/**
 * Redacts sensitive tokens, credentials, API keys, private key material,
 * and database connection strings from task stdout, stderr, and system logs.
 */
export class LogRedactor {
  private static readonly SECRET_PATTERNS: Array<{ regex: RegExp; replacement: string }> = [
    // PEM Private Keys
    {
      regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
      replacement: "[REDACTED_PRIVATE_KEY]",
    },
    // Bearer / Basic Authorization headers
    {
      regex: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
      replacement: "$1 [REDACTED_TOKEN]",
    },
    // OpenAI / Anthropic API keys
    {
      regex: /\bsk-(?:proj-|ant-[a-z0-9-]+-)?[A-Za-z0-9_-]{20,}\b/g,
      replacement: "[REDACTED_API_KEY]",
    },
    // Google / Gemini API keys
    {
      regex: /\bAIza[0-9A-Za-z_-]{30,}\b/g,
      replacement: "[REDACTED_GOOGLE_API_KEY]",
    },
    // GitHub Tokens
    {
      regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
      replacement: "[REDACTED_GITHUB_TOKEN]",
    },
    {
      regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
      replacement: "[REDACTED_GITHUB_PAT]",
    },
    // AWS Access Key ID
    {
      regex: /\bAKIA[0-9A-Z]{16}\b/g,
      replacement: "[REDACTED_AWS_KEY_ID]",
    },
    // Postgres / Redis / Mongo URLs with embedded credentials
    {
      regex: /\b(postgres(?:ql)?|rediss?|mongodb(?:\+srv)?|mysql):\/\/[^:\s]+:[^@\s]+@[^\s"']+/gi,
      replacement: "$1://[REDACTED_CREDENTIALS]@[REDACTED_HOST]",
    },
    // Messiah Pairing Token & Auth Prefix
    {
      regex: /\bMSH_[A-Za-z0-9_-]{20,}\b/g,
      replacement: "[REDACTED_PAIRING_SECRET]",
    },
    // Generic key=value credential lines
    {
      regex: /\b([A-Z0-9_]*(?:API_KEY|SECRET_KEY|ACCESS_KEY|AUTH_TOKEN|PASSWORD|PASSPHRASE|SERVICE_ROLE_KEY|HMAC_SECRET)[A-Z0-9_]*)\s*[:=]\s*["']?[^\s"']{6,}["']?/gi,
      replacement: "$1=[REDACTED]",
    },
  ];

  public static redact(input: string): string {
    if (!input) return input;
    let output = input;
    for (const { regex, replacement } of this.SECRET_PATTERNS) {
      output = output.replace(regex, replacement);
    }
    return output;
  }
}
