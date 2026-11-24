export const PRODUCT_IDENTITY = {
  name: "MESSIAH",
  fullName: "MESSIAH — The Universal AI Agent Workspace",
  tagline: "One intelligence layer. Every agent. Every device.",
  version: "0.1.0",
} as const;

export const DEFAULT_PORTS = {
  web: 3000,
  server: 3001,
  postgres: 5432,
  redis: 6380,
} as const;

export const API_ROUTES = {
  healthLive: "/health/live",
  healthReady: "/health/ready",
  systemInfo: "/api/v1/system",
} as const;
