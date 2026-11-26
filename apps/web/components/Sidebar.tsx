"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import {
  LayoutDashboard,
  Bot,
  Laptop2,
  Cpu,
  GitFork,
  FileText,
  Sliders,
  ShieldCheck,
  Key,
  MessageSquare,
  Database,
  ShieldAlert,
  Bell,
  Workflow,
} from "lucide-react";
import { cn } from "@messiah/ui";
import { MobileBottomNav } from "@/components/MobileBottomNav";

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  activeTab: string;
  onSelectTab: (tab: string) => void;
}

const navItems = [
  { id: "overview", label: "Command Center", icon: LayoutDashboard, href: "/" },
  { id: "chat", label: "Universal Chat", icon: MessageSquare, href: "/chat", badge: "Live" },
  { id: "approvals", label: "Approval Queue", icon: ShieldAlert, href: "/approvals", badge: "HITL" },
  { id: "agents", label: "Agent Registry", icon: Bot, href: "/agents" },
  { id: "swarms", label: "Swarm Topology", icon: GitFork, href: "/swarms", badge: "3D/2D" },
  { id: "workflows", label: "Workflows", icon: Workflow, href: "/workflows" },
  { id: "memory", label: "Vector Memory", icon: Database, href: "/memory" },
  { id: "integrations", label: "AI Providers", icon: Key, href: "/settings/integrations" },
  { id: "devices", label: "Local Bridges", icon: Laptop2, href: "/settings/devices" },
  { id: "mcp", label: "MCP Servers", icon: Cpu, href: "/settings/mcp" },
  { id: "notifications", label: "Notifications", icon: Bell, href: "/settings/notifications" },
  { id: "audit", label: "Audit Logs", icon: FileText, href: "/audit" },
  { id: "settings", label: "Security & Prefs", icon: Sliders, href: "/settings/notifications" },
];

export function Sidebar({
  isOpen,
  onClose,
  activeTab,
  onSelectTab,
}: SidebarProps) {
  const [pendingApprovalsCount, setPendingApprovalsCount] = useState(0);

  useEffect(() => {
    const onCount = (ev: Event) => {
      const count = (ev as CustomEvent<{ count?: number }>).detail?.count;
      if (typeof count === "number") {
        setPendingApprovalsCount(count);
      }
    };
    window.addEventListener("messiah:approvals-count", onCount);
    return () => {
      window.removeEventListener("messiah:approvals-count", onCount);
    };
  }, []);

  return (
    <>
      {/* Mobile Overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm md:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* Sidebar Panel */}
      <aside
        aria-label="Primary sidebar navigation"
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-[#1E2536] bg-[#090A0F] pt-16 transition-transform duration-300 md:static md:translate-x-0 md:pt-0 overflow-y-auto",
          isOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex flex-1 flex-col justify-between p-4 gap-4">
          <div className="space-y-5">
            {/* Workspace Status Indicator */}
            <div className="rounded-lg border border-[#1E2536] bg-[#12151E]/60 p-3">
              <span className="text-[10px] font-mono uppercase tracking-wider text-[#64748B]">
                Messiah Intelligence Plane
              </span>
              <div className="mt-1 flex items-center justify-between">
                <span className="text-xs font-semibold text-[#F0F4FC]">
                  Cross-Device Ready
                </span>
                <span className="h-2 w-2 rounded-full bg-[#00FFA3]" />
              </div>
            </div>

            {/* Navigation List */}
            <nav className="space-y-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = activeTab === item.id;
                const dynamicBadge =
                  item.id === "approvals" && pendingApprovalsCount > 0
                    ? String(pendingApprovalsCount)
                    : item.badge;

                const content = (
                  <>
                    <div className="flex items-center gap-3 min-w-0">
                      <Icon
                        className={cn(
                          "h-4 w-4 shrink-0 transition-colors",
                          isActive
                            ? "text-[#00F0FF]"
                            : "text-[#64748B] group-hover:text-[#94A3B8]",
                        )}
                      />
                      <span className="truncate">{item.label}</span>
                    </div>
                    {dynamicBadge && (
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] font-mono shrink-0",
                          item.id === "approvals" && pendingApprovalsCount > 0
                            ? "bg-[#FFB800] text-[#090A0F] font-bold"
                            : isActive
                            ? "bg-[#00F0FF]/20 text-[#00F0FF]"
                            : "bg-[#1E2536] text-[#64748B]",
                        )}
                      >
                        {dynamicBadge}
                      </span>
                    )}
                  </>
                );

                const itemClass = cn(
                  "group flex w-full min-h-[38px] items-center justify-between rounded-lg px-3 py-2 text-xs font-medium transition-all duration-200",
                  isActive
                    ? "bg-[#00F0FF]/10 text-[#00F0FF] border border-[#00F0FF]/20 shadow-[0_0_15px_rgba(0,240,255,0.08)]"
                    : "text-[#94A3B8] hover:bg-[#12151E] hover:text-[#F0F4FC]",
                );

                return (
                  <Link
                    key={item.id}
                    href={item.href}
                    onClick={() => {
                      onSelectTab(item.id);
                      onClose();
                    }}
                    className={itemClass}
                  >
                    {content}
                  </Link>
                );
              })}
            </nav>
          </div>

          {/* Footer Info */}
          <div className="rounded-lg border border-[#1E2536]/60 bg-[#0E111A] p-3 text-xs text-[#64748B]">
            <div className="flex items-center gap-2 mb-1 text-[#00FFA3]">
              <ShieldCheck className="h-3.5 w-3.5" />
              <span className="font-semibold text-[11px] text-[#F0F4FC]">
                MESSIAH v1.0.0
              </span>
            </div>
            <p className="text-[10px] leading-relaxed">
              PostgreSQL pgvector · BullMQ Outbox · Signed Bridge Sandbox · Zero-Trust HITL.
            </p>
          </div>
        </div>
      </aside>

      {/* Mobile Sticky Bottom Navigation */}
      <MobileBottomNav pendingApprovalsCount={pendingApprovalsCount} />
    </>
  );
}
