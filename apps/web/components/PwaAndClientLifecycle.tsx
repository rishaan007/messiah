"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, WifiOff } from "lucide-react";
import { registerServiceWorker } from "@/lib/pwa";
import { isTauriRuntime, sanitizeClientDeepLink } from "@/lib/desktopBridge";

export function PwaAndClientLifecycle() {
  const router = useRouter();
  const [isOffline, setIsOffline] = useState(false);
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    setIsOffline(typeof navigator !== "undefined" && !navigator.onLine);

    const onOffline = () => setIsOffline(true);
    const onOnline = () => {
      setIsOffline(false);
      window.dispatchEvent(new CustomEvent("messiah:reconnected"));
      router.refresh();
    };

    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);

    // Register Service Worker in non-Tauri browser/PWA contexts
    if (!isTauriRuntime()) {
      registerServiceWorker((reg) => {
        setWaitingWorker(reg);
      });
    }

    // Listen for sanitized deep-link dispatches from Tauri / Capacitor native bridges
    const onDeepLink = (ev: Event) => {
      const detail = (ev as CustomEvent<{ url?: string }>).detail;
      const safePath = detail?.url ? sanitizeClientDeepLink(detail.url) : null;
      if (safePath) {
        router.push(safePath);
      }
    };
    window.addEventListener("messiah:deep-link", onDeepLink);

    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("messiah:deep-link", onDeepLink);
    };
  }, [router]);

  const applySwUpdate = () => {
    if (waitingWorker?.waiting) {
      waitingWorker.waiting.postMessage({ type: "SKIP_WAITING" });
      window.location.reload();
    }
  };

  if (!isOffline && !waitingWorker) {
    return null;
  }

  return (
    <div className="fixed top-16 left-0 right-0 z-50 flex flex-col items-center gap-2 px-4 pt-2 pointer-events-none">
      {isOffline && (
        <div
          role="status"
          className="pointer-events-auto flex items-center gap-2.5 rounded-full border border-[#FFB800]/40 bg-[#12151E]/95 px-4 py-1.5 text-xs text-[#FFB800] shadow-lg backdrop-blur-md"
        >
          <WifiOff className="h-3.5 w-3.5 shrink-0" />
          <span>
            Offline mode — Drafts preserved locally; cloud agents and Local Bridges pause until online.
          </span>
        </div>
      )}

      {waitingWorker && (
        <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-[#00F0FF]/40 bg-[#12151E]/95 px-4 py-1.5 text-xs text-[#F0F4FC] shadow-lg backdrop-blur-md">
          <RefreshCw className="h-3.5 w-3.5 text-[#00F0FF]" />
          <span>New MESSIAH PWA version available</span>
          <button
            type="button"
            onClick={applySwUpdate}
            className="rounded-full bg-[#00F0FF] px-2.5 py-0.5 text-[11px] font-semibold text-[#090A0F] hover:bg-[#00F0FF]/90"
          >
            Update Now
          </button>
        </div>
      )}
    </div>
  );
}
