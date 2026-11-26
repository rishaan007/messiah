-- Phase 7: Cross-Platform Notifications, Push Devices & Preferences

-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM (
  'TOOL_APPROVAL',
  'BRIDGE_APPROVAL',
  'SWARM_APPROVAL',
  'WORKFLOW_APPROVAL',
  'AGENT_RUN_COMPLETED',
  'AGENT_RUN_FAILED',
  'WORKFLOW_COMPLETED',
  'WORKFLOW_FAILED',
  'DEVICE_STATUS'
);

-- CreateEnum
CREATE TYPE "ClientPlatform" AS ENUM (
  'WEB_PWA',
  'MACOS_DESKTOP',
  'WINDOWS_DESKTOP',
  'LINUX_DESKTOP',
  'IOS_CAPACITOR',
  'ANDROID_CAPACITOR'
);

-- CreateTable
CREATE TABLE "notification_devices" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "workspace_id" UUID,
  "platform" "ClientPlatform" NOT NULL,
  "device_label" VARCHAR(128) NOT NULL,
  "push_provider" VARCHAR(32) NOT NULL,
  "subscription_hash" VARCHAR(64) NOT NULL,
  "push_endpoint" TEXT,
  "push_p256dh" TEXT,
  "push_auth" TEXT,
  "native_push_token" TEXT,
  "app_version" VARCHAR(32),
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "notification_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "in_app_enabled" BOOLEAN NOT NULL DEFAULT true,
  "web_push_enabled" BOOLEAN NOT NULL DEFAULT true,
  "desktop_enabled" BOOLEAN NOT NULL DEFAULT true,
  "mobile_push_enabled" BOOLEAN NOT NULL DEFAULT true,
  "notify_approvals" BOOLEAN NOT NULL DEFAULT true,
  "notify_completions" BOOLEAN NOT NULL DEFAULT true,
  "notify_failures" BOOLEAN NOT NULL DEFAULT true,
  "notify_device_status" BOOLEAN NOT NULL DEFAULT true,
  "quiet_hours_start" VARCHAR(8),
  "quiet_hours_end" VARCHAR(8),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "recipient_user_id" UUID NOT NULL,
  "category" "NotificationCategory" NOT NULL,
  "title" VARCHAR(160) NOT NULL,
  "preview" VARCHAR(280) NOT NULL,
  "resource_type" VARCHAR(48) NOT NULL,
  "resource_id" VARCHAR(128) NOT NULL,
  "deep_link" VARCHAR(255) NOT NULL,
  "dedup_key" VARCHAR(160) NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "expires_at" TIMESTAMPTZ(6),
  "read_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_devices_subscription_hash_key" ON "notification_devices"("subscription_hash");
CREATE INDEX "notification_devices_user_id_is_active_idx" ON "notification_devices"("user_id", "is_active");
CREATE INDEX "notification_devices_workspace_id_is_active_idx" ON "notification_devices"("workspace_id", "is_active");

CREATE UNIQUE INDEX "notification_preferences_user_id_workspace_id_key" ON "notification_preferences"("user_id", "workspace_id");
CREATE INDEX "notification_preferences_workspace_id_idx" ON "notification_preferences"("workspace_id");

CREATE UNIQUE INDEX "notifications_recipient_user_id_dedup_key_key" ON "notifications"("recipient_user_id", "dedup_key");
CREATE INDEX "notifications_recipient_user_id_workspace_id_read_at_create_idx" ON "notifications"("recipient_user_id", "workspace_id", "read_at", "created_at" DESC);
CREATE INDEX "notifications_resource_type_resource_id_idx" ON "notifications"("resource_type", "resource_id");

-- AddForeignKey
ALTER TABLE "notification_devices" ADD CONSTRAINT "notification_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_devices" ADD CONSTRAINT "notification_devices_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
