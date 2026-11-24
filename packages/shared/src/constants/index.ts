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

export const DEVICE_CONSTANTS = {
  PROTOCOL_VERSION: "2026-08-01",
  HEARTBEAT_INTERVAL_MS: 15000,
  HEARTBEAT_TIMEOUT_MS: 45000,
  WSS_CHALLENGE_TTL_MS: 30000,
  PAIRING_CHALLENGE_TTL_SECONDS: 300, // 5 minutes
  MAX_PAIRING_FAILED_ATTEMPTS: 5,
  MAX_FRAME_SIZE_BYTES: 65536, // 64KB frame limit for device messages
  KEY_ALGORITHM: "ed25519",
  SIGNING_PREFIX: "MESSIAH_DEVICE_AUTH",
} as const;

export const DEVICE_API_ROUTES = {
  connect: "/api/v1/devices/connect",
  list: "/api/v1/devices",
  createPairingChallenge: "/api/v1/devices/pair/challenge",
  claimPairingChallenge: "/api/v1/devices/pair/claim",
  pendingChallenges: "/api/v1/devices/pair/pending",
  approvePairing: "/api/v1/devices/pair/:challengeId/approve",
  rejectPairing: "/api/v1/devices/pair/:challengeId/reject",
  deviceDetail: "/api/v1/devices/:deviceId",
  renameDevice: "/api/v1/devices/:deviceId/rename",
  pauseDevice: "/api/v1/devices/:deviceId/pause",
  resumeDevice: "/api/v1/devices/:deviceId/resume",
  revokeDevice: "/api/v1/devices/:deviceId/revoke",
} as const;
