import { cn } from "../utils/cn.js";

export interface StatusDotProps {
  status: "online" | "offline" | "busy" | "error";
  pulse?: boolean;
  className?: string;
}

export function StatusDot({
  status,
  pulse = false,
  className,
}: StatusDotProps) {
  const colors = {
    online: "bg-[#00FFA3] shadow-[0_0_8px_#00FFA3]",
    offline: "bg-[#64748B]",
    busy: "bg-[#FFB800] shadow-[0_0_8px_#FFB800]",
    error: "bg-[#FF3366] shadow-[0_0_8px_#FF3366]",
  };

  return (
    <span className={cn("relative inline-flex h-2.5 w-2.5", className)}>
      {pulse && status === "online" && (
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#00FFA3] opacity-75" />
      )}
      <span
        className={cn(
          "relative inline-flex rounded-full h-2.5 w-2.5",
          colors[status],
        )}
      />
    </span>
  );
}
