// MESSIAH Service Worker v1.0.0
// SECURITY INVARIANT:
// Never cache API responses, auth routes, Supabase sessions, private memory records,
// provider credentials, or execution secrets in CacheStorage or IndexedDB.

const CACHE_NAME = "messiah-shell-v1";
const STATIC_ASSETS = [
  "/offline.html",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/messiah-mark.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

function isCacheablePublicStatic(requestUrl) {
  if (requestUrl.origin !== self.location.origin) return false;
  const p = requestUrl.pathname;
  if (p.startsWith("/api/") || p.startsWith("/auth/")) return false;
  return (
    p.startsWith("/_next/static/") ||
    p.startsWith("/icons/") ||
    p === "/offline.html"
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let parsedUrl;
  try {
    parsedUrl = new URL(req.url);
  } catch {
    return;
  }

  // Never intercept or cache authenticated backend / auth / API calls
  if (parsedUrl.pathname.startsWith("/api/") || parsedUrl.pathname.startsWith("/auth/")) {
    return;
  }

  // Strictly cache-first ONLY for immutable static assets & icons
  if (isCacheablePublicStatic(parsedUrl)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res && res.status === 200 && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return res;
        });
      })
    );
    return;
  }

  // Navigation requests use network-first with offline fallback (never cache dynamic HTML/RSC payloads)
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("/offline.html"))
    );
  }
});

// Web Push Notification handler (human approvals NEVER auto-approve on click!)
self.addEventListener("push", (event) => {
  let payload = {
    title: "MESSIAH Notification",
    body: "Open MESSIAH to inspect the update.",
    deepLink: "/approvals",
  };
  try {
    if (event.data) {
      payload = { ...payload, ...event.data.json() };
    }
  } catch {
    if (event.data) {
      payload.body = event.data.text();
    }
  }

  const deepLink =
    typeof payload.deepLink === "string" && payload.deepLink.startsWith("/")
      ? payload.deepLink
      : "/approvals";

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: payload.resourceId ? `messiah-${payload.resourceId}` : "messiah-alert",
      data: { deepLink },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetPath =
    event.notification?.data?.deepLink && String(event.notification.data.deepLink).startsWith("/")
      ? event.notification.data.deepLink
      : "/approvals";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsArr) => {
      for (const client of clientsArr) {
        if ("focus" in client) {
          client.navigate(targetPath).catch(() => {});
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetPath);
      }
      return undefined;
    })
  );
});
