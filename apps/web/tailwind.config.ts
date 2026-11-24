import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        obsidian: {
          950: "#06070A",
          900: "#090A0F",
          800: "#12151E",
          700: "#181C28",
          600: "#1E2536",
          500: "#2A344D",
          400: "#384566",
        },
        cyan: {
          DEFAULT: "#00F0FF",
          glow: "rgba(0, 240, 255, 0.15)",
          border: "rgba(0, 240, 255, 0.3)",
        },
        emerald: {
          DEFAULT: "#00FFA3",
          glow: "rgba(0, 255, 163, 0.15)",
        },
        amber: {
          DEFAULT: "#FFB800",
          glow: "rgba(255, 184, 0, 0.15)",
        },
        crimson: {
          DEFAULT: "#FF3366",
          glow: "rgba(255, 51, 102, 0.15)",
        },
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "monospace"],
      },
      animation: {
        "pulse-subtle": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        radar: "radar 2s ease-out infinite",
      },
      keyframes: {
        radar: {
          "0%": { transform: "scale(1)", opacity: "0.8" },
          "100%": { transform: "scale(2.5)", opacity: "0" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
