-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('PENDING_APPROVAL', 'ACTIVE', 'PAUSED', 'REVOKED');

-- CreateEnum
CREATE TYPE "PairingChallengeStatus" AS ENUM ('PENDING', 'CLAIMED', 'CONSUMED', 'EXPIRED', 'REJECTED');

-- CreateTable
CREATE TABLE "bridge_devices" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "display_name" VARCHAR(128) NOT NULL,
    "platform" VARCHAR(32) NOT NULL,
    "architecture" VARCHAR(32) NOT NULL,
    "bridge_version" VARCHAR(64) NOT NULL,
    "public_key" TEXT NOT NULL,
    "public_key_fingerprint" VARCHAR(128) NOT NULL,
    "protocol_version" VARCHAR(32) NOT NULL DEFAULT '2026-08-01',
    "status" "DeviceStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "last_seen_at" TIMESTAMPTZ(6),
    "last_connected_at" TIMESTAMPTZ(6),
    "paired_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bridge_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_pairing_challenges" (
    "id" UUID NOT NULL,
    "challenge_hash" VARCHAR(64) NOT NULL,
    "workspace_id" UUID NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "claimed_device_id" UUID,
    "claimed_device_name" VARCHAR(128),
    "claimed_platform" VARCHAR(32),
    "claimed_architecture" VARCHAR(32),
    "claimed_bridge_version" VARCHAR(64),
    "claimed_public_key" TEXT,
    "claimed_fingerprint" VARCHAR(128),
    "status" "PairingChallengeStatus" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "device_pairing_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_connection_sessions" (
    "id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "ip_address" VARCHAR(64),
    "user_agent" VARCHAR(255),
    "connected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_heartbeat_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnected_at" TIMESTAMPTZ(6),
    "disconnect_reason" VARCHAR(64),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_connection_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "device_pairing_challenges_challenge_hash_key" ON "device_pairing_challenges"("challenge_hash");

-- CreateIndex
CREATE INDEX "bridge_devices_workspace_id_status_idx" ON "bridge_devices"("workspace_id", "status");
CREATE INDEX "bridge_devices_public_key_fingerprint_idx" ON "bridge_devices"("public_key_fingerprint");
CREATE INDEX "bridge_devices_owner_user_id_idx" ON "bridge_devices"("owner_user_id");

-- CreateIndex
CREATE INDEX "device_pairing_challenges_workspace_id_status_idx" ON "device_pairing_challenges"("workspace_id", "status");
CREATE INDEX "device_pairing_challenges_expires_at_idx" ON "device_pairing_challenges"("expires_at");

-- CreateIndex
CREATE INDEX "device_connection_sessions_device_id_disconnected_at_idx" ON "device_connection_sessions"("device_id", "disconnected_at");
CREATE INDEX "device_connection_sessions_expires_at_idx" ON "device_connection_sessions"("expires_at");

-- AddForeignKey
ALTER TABLE "bridge_devices" ADD CONSTRAINT "bridge_devices_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bridge_devices" ADD CONSTRAINT "bridge_devices_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_pairing_challenges" ADD CONSTRAINT "device_pairing_challenges_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_pairing_challenges" ADD CONSTRAINT "device_pairing_challenges_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_pairing_challenges" ADD CONSTRAINT "device_pairing_challenges_claimed_device_id_fkey" FOREIGN KEY ("claimed_device_id") REFERENCES "bridge_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_connection_sessions" ADD CONSTRAINT "device_connection_sessions_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "bridge_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
