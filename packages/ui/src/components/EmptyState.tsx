import type { ReactNode } from "react";
import { cn } from "../utils/cn.js";
import { Button } from "./Button.js";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
  badge?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  onAction,
  className,
  badge,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center p-8 text-center rounded-xl border border-dashed border-[#1E2536] bg-[#0E111A]/50 backdrop-blur-sm",
        className,
      )}
    >
      {badge && (
        <span className="mb-4 inline-flex items-center rounded-full border border-[#00F0FF]/20 bg-[#00F0FF]/5 px-2.5 py-0.5 text-xs font-mono text-[#00F0FF]">
          {badge}
        </span>
      )}
      {icon && (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-[#1E2536] bg-[#12151E] text-[#64748B] shadow-inner">
          {icon}
        </div>
      )}
      <h4 className="text-sm font-semibold text-[#F0F4FC] tracking-tight mb-1.5">
        {title}
      </h4>
      <p className="max-w-xs text-xs text-[#94A3B8] leading-relaxed mb-5">
        {description}
      </p>
      {actionLabel && (
        <Button variant="secondary" size="sm" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
