import type { HTMLAttributes } from "react";
import { cn } from "../utils/cn.js";

export interface BadgeProps extends HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "outline" | "cyan" | "emerald" | "amber" | "crimson";
}

export function Badge({
  className,
  variant = "default",
  ...props
}: BadgeProps) {
  const variants = {
    default: "bg-[#1E2536] text-[#94A3B8] border-[#2A344D]",
    outline: "border-[#2A344D] text-[#94A3B8]",
    cyan: "bg-[#00F0FF]/10 text-[#00F0FF] border-[#00F0FF]/30",
    emerald: "bg-[#00FFA3]/10 text-[#00FFA3] border-[#00FFA3]/30",
    amber: "bg-[#FFB800]/10 text-[#FFB800] border-[#FFB800]/30",
    crimson: "bg-[#FF3366]/10 text-[#FF3366] border-[#FF3366]/30",
  };

  return (
    <div
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium tracking-wide transition-colors",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
