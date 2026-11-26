"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  MessageSquare,
  ShieldAlert,
  GitFork,
  Workflow,
} from "lucide-react";
import { cn } from "@messiah/ui";

interface MobileBottomNavProps {
  pendingApprovalsCount?: number;
}

const ITEMS = [
  { href: "/", label: "Home", icon: LayoutDashboard, match: (p: string) => p === "/" },
  { href: "/chat", label: "Chat", icon: MessageSquare, match: (p: string) => p.startsWith("/chat") },
  {
    href: "/approvals",
    label: "Approvals",
    icon: ShieldAlert,
    match: (p: string) => p.startsWith("/approvals"),
  },
  { href: "/swarms", label: "Swarms", icon: GitFork, match: (p: string) => p.startsWith("/swarms") },
  {
    href: "/workflows",
    label: "Workflows",
    icon: Workflow,
    match: (p: string) => p.startsWith("/workflows"),
  },
];

export function MobileBottomNav({ pendingApprovalsCount = 0 }: MobileBottomNavProps) {
  const pathname = usePathname() || "/";

  return (
    <nav
      aria-label="Mobile quick navigation"
      className="fixed bottom-0 left-0 right-0 z-40 flex items-center justify-around border-t border-[#1E2536] bg-[#090A0F]/95 px-2 pt-1.5 backdrop-blur-xl md:hidden"
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 6px)" }}
    >
      {ITEMS.map((item) => {
        const Icon = item.icon;
        const active = item.match(pathname);
        const isApprovals = item.href === "/approvals";
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "relative flex min-h-[44px] min-w-[56px] flex-col items-center justify-center gap-0.5 rounded-lg px-2 py-1 text-[10px] font-medium transition-colors",
              active
                ? "text-[#00F0FF] bg-[#00F0FF]/10"
                : "text-[#94A3B8] hover:text-[#F0F4FC]"
            )}
          >
            <Icon className="h-4 w-4" />
            <span>{item.label}</span>
            {isApprovals && pendingApprovalsCount > 0 && (
              <span className="absolute top-1 right-2 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#FFB800] px-1 font-mono text-[9px] font-bold text-[#090A0F]">
                {pendingApprovalsCount > 99 ? "99+" : pendingApprovalsCount}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
