"use client";

export interface WebPushSubscribeResult {
  supported: boolean;
  permission: NotificationPermission | "unsupported";
  registered: boolean;
  reason?: string;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const buffer = new ArrayBuffer(rawData.length);
  const outputArray = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export async function registerServiceWorker(
  onUpdateReady?: (reg: ServiceWorkerRegistration) => void
): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }

  try {
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    if (reg.waiting && onUpdateReady) {
      onUpdateReady(reg);
    }
    reg.addEventListener("updatefound", () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller && onUpdateReady) {
          onUpdateReady(reg);
        }
      });
    });
    return reg;
  } catch {
    return null;
  }
}

export async function subscribeToWebPush(params: {
  apiUrl: string;
  authToken: string;
  workspaceId: string;
  deviceLabel?: string;
}): Promise<WebPushSubscribeResult> {
  if (
    typeof window === "undefined" ||
    !("Notification" in window) ||
    !("serviceWorker" in navigator) ||
    !("PushManager" in window)
  ) {
    return {
      supported: false,
      permission: "unsupported",
      registered: false,
      reason: "This browser does not support Web Push notifications.",
    };
  }

  const permission = await window.Notification.requestPermission();
  if (permission !== "granted") {
    return {
      supported: true,
      permission,
      registered: false,
      reason: "Notification permission was denied or dismissed.",
    };
  }

  const vapidRes = await fetch(`${params.apiUrl}/api/v1/notifications/vapid-public-key`, {
    headers: { Authorization: `Bearer ${params.authToken}` },
  });
  const vapidBody = vapidRes.ok ? await vapidRes.json() : null;
  const publicKey = vapidBody?.data?.publicKey as string | null;

  if (!publicKey) {
    return {
      supported: true,
      permission,
      registered: false,
      reason: "Server VAPID Web Push keys are not configured yet. In-app realtime alerts remain active.",
    };
  }

  const reg = await navigator.serviceWorker.ready;
  let subscription = await reg.pushManager.getSubscription();
  if (!subscription) {
    subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }

  const json = subscription.toJSON();
  const res = await fetch(`${params.apiUrl}/api/v1/notifications/devices`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      workspaceId: params.workspaceId,
      platform: "WEB_PWA",
      deviceLabel: params.deviceLabel || `${navigator.platform || "Web"} PWA`,
      pushProvider: "webpush",
      pushEndpoint: json.endpoint,
      pushP256dh: json.keys?.p256dh,
      pushAuth: json.keys?.auth,
      appVersion: "1.0.0",
    }),
  });

  return {
    supported: true,
    permission,
    registered: res.ok,
    ...(res.ok ? {} : { reason: "Failed to persist push subscription on server." }),
  };
}
