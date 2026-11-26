import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { PushNotifications } from "@capacitor/push-notifications";
import { Network } from "@capacitor/network";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { StatusBar, Style } from "@capacitor/status-bar";
import type { ClientPlatform } from "@messiah/shared";

const SAFE_ROUTE_PREFIXES = [
  "/",
  "/approvals",
  "/chat",
  "/agents",
  "/swarms",
  "/workflows",
  "/memory",
  "/audit",
  "/settings",
];

/**
 * Validates incoming deep link URIs (`messiah://...` or Universal/App Links)
 * strictly against an allowlist of in-app paths to prevent open redirects and scheme injection.
 */
export function resolveSafeMobileDeepLink(
  rawUrl: string,
  trustedHosts: string[] = ["app.messiah.local", "localhost"]
): string | null {
  const input = String(rawUrl || "").trim();
  if (!input || /[\0\r\n\\]/.test(input) || input.includes("..")) {
    return null;
  }

  let candidatePath: string;
  try {
    if (input.startsWith("messiah://")) {
      const normalized = `https://messiah.internal/${input.slice("messiah://".length).replace(/^\/+/, "")}`;
      const u = new URL(normalized);
      candidatePath = `${u.pathname}${u.search}`;
    } else if (input.startsWith("https://") || input.startsWith("http://")) {
      const u = new URL(input);
      if (!trustedHosts.includes(u.hostname)) {
        return null;
      }
      candidatePath = `${u.pathname}${u.search}`;
    } else if (input.startsWith("/") && !input.startsWith("//")) {
      const u = new URL(input, "https://messiah.internal");
      candidatePath = `${u.pathname}${u.search}`;
    } else {
      return null;
    }
  } catch {
    return null;
  }

  const cleanPathname = candidatePath.split("?")[0] || "/";
  const allowed = SAFE_ROUTE_PREFIXES.some(
    (prefix) => cleanPathname === prefix || cleanPathname.startsWith(`${prefix}/`)
  );
  return allowed ? candidatePath : null;
}

export function detectNativeClientPlatform(): ClientPlatform {
  const p = Capacitor.getPlatform();
  if (p === "ios") return "IOS_CAPACITOR";
  if (p === "android") return "ANDROID_CAPACITOR";
  return "WEB_PWA";
}

export interface MobileRuntimeHooks {
  apiUrl: string;
  getAuthToken: () => Promise<string | null>;
  getActiveWorkspaceId: () => string | null;
  onNavigate: (safeRelativePath: string) => void;
  onReconnect: () => void;
}

/**
 * Initializes Capacitor native integrations (status bar, deep links, APNs/FCM token registration,
 * and connectivity reconciliation) when running inside iOS or Android builds.
 */
export async function initCapacitorMobileRuntime(hooks: MobileRuntimeHooks): Promise<() => Promise<void>> {
  if (!Capacitor.isNativePlatform()) {
    return async () => {};
  }

  try {
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setBackgroundColor({ color: "#090A0F" });
  } catch {}

  const urlSub = await App.addListener("appUrlOpen", (event) => {
    const safePath = resolveSafeMobileDeepLink(event.url);
    if (safePath) {
      hooks.onNavigate(safePath);
    }
  });

  const stateSub = await App.addListener("appStateChange", ({ isActive }) => {
    if (isActive) {
      // Re-sync authoritative approval & chat state on foreground resume; NEVER auto-approve!
      hooks.onReconnect();
    }
  });

  const netSub = await Network.addListener("networkStatusChange", (status) => {
    if (status.connected) {
      hooks.onReconnect();
    }
  });

  // Push Notification registration & tap deep-link routing
  try {
    const perm = await PushNotifications.requestPermissions();
    if (perm.receive === "granted") {
      await PushNotifications.register();
    }
  } catch {}

  const regSub = await PushNotifications.addListener("registration", async (token) => {
    const jwt = await hooks.getAuthToken();
    if (!jwt) return;
    const platform = detectNativeClientPlatform();
    const pushProvider = platform === "IOS_CAPACITOR" ? "apns" : "fcm";

    await fetch(`${hooks.apiUrl}/api/v1/notifications/devices`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspaceId: hooks.getActiveWorkspaceId(),
        platform,
        deviceLabel: platform === "IOS_CAPACITOR" ? "iPhone / iPad" : "Android Device",
        pushProvider,
        nativePushToken: token.value,
        appVersion: "1.0.0",
      }),
    }).catch(() => {});
  });

  const tapSub = await PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
    const data = (action.notification?.data || {}) as Record<string, unknown>;
    const rawDeepLink = typeof data.deepLink === "string" ? data.deepLink : "/approvals";
    const safePath = resolveSafeMobileDeepLink(rawDeepLink) || "/approvals";
    Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
    hooks.onNavigate(safePath);
  });

  return async () => {
    await Promise.all([
      urlSub.remove(),
      stateSub.remove(),
      netSub.remove(),
      regSub.remove(),
      tapSub.remove(),
    ]);
  };
}
