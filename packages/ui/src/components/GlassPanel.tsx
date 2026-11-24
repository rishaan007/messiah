import type { HTMLAttributes } from "react";
import { cn } from "../utils/cn.js";

export interface GlassPanelProps extends HTMLAttributes<HTMLDivElement> {
  glowBorder?: boolean;
}

export function GlassPanel({
  className,
  glowBorder = false,
  children,
  ...props
}: GlassPanelProps) {
  return (
    <div
      className={cn(
        "relative rounded-xl border border-white/[0.08] bg-[#12151E]/75 backdrop-blur-xl transition-all duration-300",
        glowBorder &&
          "hover:border-[#00F0FF]/30 hover:shadow-[0_0_30px_rgba(0,240,255,0.08)]",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
