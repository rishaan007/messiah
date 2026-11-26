"use client";

export const ALLOWED_DEEP_LINK_PREFIXES = [
  "/",
  "/chat",
  "/agents",
  "/swarms",
  "/memory",
  "/workflows",
  "/approvals",
  "/audit",
  "/settings",
];

/**
 * Validates and sanitizes custom scheme (`messiah://...`) or relative paths into a safe
 * in-app relative path. Prevents open-redirect and arbitrary scheme injection.
 */
export function sanitizeClientDeepLink(rawUrl: string): string | null {
  const trimmed = String(rawUrl || "").trim();
  if (!trimmed) return null;

  let pathCandidate = trimmed;
  if (trimmed.startsWith("messiah://")) {
    pathCandidate = "/" + trimmed.slice("messiah://".length).replace(/^\/+/, "");
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) || trimmed.startsWith("//")) {
    return null;
  }

  if (!pathCandidate.startsWith("/")) {
    pathCandidate = `/${pathCandidate}`;
  }

  // Strip control characters and traversal sequences
  if (/[\0\r\n\\]/.test(pathCandidate) || pathCandidate.includes("..")) {
    return null;
  }

  try {
    const parsed = new URL(pathCandidate, "https://messiah.local");
    if (parsed.origin !== "https://messiah.local") return null;
    const matched = ALLOWED_DEEP_LINK_PREFIXES.some(
      (prefix) => parsed.pathname === prefix || parsed.pathname.startsWith(`${prefix}/`)
    );
    if (!matched) return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

const ACTIVE_WORKSPACE_KEY = "messiah:active_workspace_id";

export function getSavedActiveWorkspaceId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(ACTIVE_WORKSPACE_KEY);
  } catch {
    return null;
  }
}

export function setSavedActiveWorkspaceId(workspaceId: string): void {
  if (typeof window === "undefined" || !workspaceId) return;
  try {
    window.localStorage.setItem(ACTIVE_WORKSPACE_KEY, workspaceId);
    window.dispatchEvent(
      new CustomEvent("messiah:workspace-changed", { detail: { workspaceId } })
    );
  } catch {}
}

export function pickPreferredWorkspace<T extends { id: string }>(workspaces: T[]): T | null {
  if (!workspaces || workspaces.length === 0) return null;
  const saved = getSavedActiveWorkspaceId();
  if (saved) {
    const found = workspaces.find((w) => w.id === saved);
    if (found) return found;
  }
  return workspaces[0] || null;
}

export interface DesktopBridgeDiagnostics {
  runtime: "tauri" | "web";
  osPlatform?: string;
  osArch?: string;
  bridgeRunning?: boolean;
  bridgePid?: number | null;
  bridgeStatusOutput?: string;
  autostartEnabled?: boolean;
  appVersion?: string;
}

interface TauriInternals {
  invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
}

export function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__
      ?.invoke === "function"
  );
}

export async function invokeDesktopCommand<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T | null> {
  if (!isTauriRuntime()) return null;
  const tauri = (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
  return await tauri.invoke<T>(cmd, args);
}
