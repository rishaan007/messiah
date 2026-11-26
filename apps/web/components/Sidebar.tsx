"use client";

import React from "react";
import Link from "next/link";
import {
  LayoutDashboard,
  Bot,
  Laptop2,
  Cpu,
  GitFork,
  FileText,
  Sliders,
  HelpCircle,
  Key,
  MessageSquare,
} from "lucide-react";
import { cn } from "@messiah/ui";

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  activeTab: string;
  onSelectTab: (tab: string) => void;
}

const navItems = [
  { id: "overview", label: "Command Overview", icon: LayoutDashboard, href: "/" },
  { id: "chat", label: "Universal Chat", icon: MessageSquare, href: "/chat", badge: "Live" },
  { id: "agents", label: "Agent Registry", icon: Bot, href: "/agents", badge: "Phase 5" },
  { id: "swarms", label: "Swarm Topology", icon: GitFork, href: "/swarms", badge: "3D" },
  { id: "integrations", label: "AI Integrations", icon: Key, href: "/settings/integrations", badge: "Phase 2A" },
  { id: "devices", label: "Local Bridges", icon: Laptop2, href: "/settings/devices", badge: "Phase 4B" },
  { id: "mcp", label: "MCP Tools", icon: Cpu, href: "/settings/mcp", badge: "Phase 3A" },
  { id: "workflows", label: "Workflows", icon: GitFork, badge: "Phase 6" },
  { id: "audit", label: "Audit Logs", icon: FileText },
  { id: "settings", label: "Settings", icon: Sliders, href: "/settings/integrations" },
];

export function Sidebar({
  isOpen,
  onClose,
  activeTab,
  onSelectTab,
}: SidebarProps) {
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
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-[#1E2536] bg-[#090A0F] pt-16 transition-transform duration-300 md:static md:translate-x-0 md:pt-0",
          isOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex flex-1 flex-col justify-between p-4">
          <div className="space-y-6">
            {/* Workspace Header Indicator */}
            <div className="rounded-lg border border-[#1E2536] bg-[#12151E]/60 p-3">
              <span className="text-[10px] font-mono uppercase tracking-wider text-[#64748B]">
                Active Workspace
              </span>
              <div className="mt-1 flex items-center justify-between">
                <span className="text-xs font-semibold text-[#F0F4FC]">
                  Development Node
                </span>
                <span className="h-2 w-2 rounded-full bg-[#00FFA3]" />
              </div>
            </div>

            {/* Navigation List */}
            <nav className="space-y-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = activeTab === item.id;
                const content = (
                  <>
                    <div className="flex items-center gap-3">
                      <Icon
                        className={cn(
                          "h-4 w-4 transition-colors",
                          isActive
                            ? "text-[#00F0FF]"
                            : "text-[#64748B] group-hover:text-[#94A3B8]",
                        )}
                      />
                      <span>{item.label}</span>
                    </div>
                    {item.badge && (
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] font-mono",
                          isActive
                            ? "bg-[#00F0FF]/20 text-[#00F0FF]"
                            : "bg-[#1E2536] text-[#64748B]",
                        )}
                      >
                        {item.badge}
                      </span>
                    )}
                  </>
                );

                const itemClass = cn(
                  "group flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-xs font-medium transition-all duration-200",
                  isActive
                    ? "bg-[#00F0FF]/10 text-[#00F0FF] border border-[#00F0FF]/20 shadow-[0_0_15px_rgba(0,240,255,0.08)]"
                    : "text-[#94A3B8] hover:bg-[#12151E] hover:text-[#F0F4FC]",
                );

                if (item.href) {
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
                }

                return (
                  <button
                    key={item.id}
                    onClick={() => {
                      onSelectTab(item.id);
                      onClose();
                    }}
                    className={itemClass}
                  >
                    {content}
                  </button>
                );
              })}
            </nav>
          </div>

          {/* Footer Info */}
          <div className="rounded-lg border border-[#1E2536]/60 bg-[#0E111A] p-3 text-xs text-[#64748B]">
            <div className="flex items-center gap-2 mb-1 text-[#94A3B8]">
              <HelpCircle className="h-3.5 w-3.5 text-[#00F0FF]" />
              <span className="font-semibold text-[11px]">
                Messiah Core System
              </span>
            </div>
            <p className="text-[10px] leading-relaxed">
              Phase 1A Scaffolding active. Real empty states active with 0
              simulated entities.
            </p>
          </div>
        </div>
      </aside>
    </>
  );
}
