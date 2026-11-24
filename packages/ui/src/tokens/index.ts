/**
 * MESSIAH Centralized Design Tokens
 * Premium Obsidian Command Center Aesthetic
 */

export const TOKENS = {
  colors: {
    bg: {
      obsidian: "#090A0F",
      card: "#12151E",
      cardHover: "#181C28",
      glass: "rgba(18, 21, 30, 0.75)",
      glassBorder: "rgba(255, 255, 255, 0.08)",
    },
    accent: {
      cyan: "#00F0FF",
      cyanGlow: "rgba(0, 240, 255, 0.15)",
      cyanBorder: "rgba(0, 240, 255, 0.3)",
      emerald: "#00FFA3",
      emeraldGlow: "rgba(0, 255, 163, 0.15)",
      amber: "#FFB800",
      amberGlow: "rgba(255, 184, 0, 0.15)",
      crimson: "#FF3366",
      crimsonGlow: "rgba(255, 51, 102, 0.15)",
      violet: "#8B5CF6",
    },
    text: {
      primary: "#F0F4FC",
      secondary: "#94A3B8",
      muted: "#64748B",
      dim: "#475569",
    },
    border: {
      subtle: "#1E2536",
      active: "#2A344D",
      highlight: "#384566",
    },
  },
  typography: {
    fontSans:
      'var(--font-geist-sans), -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontMono: 'var(--font-geist-mono), "JetBrains Mono", Consolas, monospace',
  },
  glass: {
    backdropFilter: "blur(16px)",
    border: "1px solid rgba(255, 255, 255, 0.08)",
  },
} as const;
