export const DESKTOP_ALLOWED_DEEP_LINK_PREFIXES = [
  "/",
  "/chat",
  "/agents",
  "/swarms",
  "/memory",
  "/workflows",
  "/approvals",
  "/audit",
  "/settings",
] as const;

/**
 * Validates Tauri `messiah://` deep links to prevent path traversal, scheme abuse,
 * or open redirects. Mirrors the Rust handler's strict allowlist validation.
 */
export function validateDesktopDeepLink(rawUri: string): string | null {
  const trimmed = String(rawUri || "").trim();
  if (!trimmed.startsWith("messiah://")) return null;
  const remainder = "/" + trimmed.slice("messiah://".length).replace(/^\/+/, "");
  if (/[\0\r\n\\]/.test(remainder) || remainder.includes("..")) {
    return null;
  }
  try {
    const u = new URL(remainder, "https://messiah.local");
    if (u.origin !== "https://messiah.local") return null;
    const isAllowed = DESKTOP_ALLOWED_DEEP_LINK_PREFIXES.some(
      (prefix) => u.pathname === prefix || u.pathname.startsWith(`${prefix}/`)
    );
    return isAllowed ? `${u.pathname}${u.search}` : null;
  } catch {
    return null;
  }
}

export function validateExternalDesktopUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === "https:") return true;
    if (
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
