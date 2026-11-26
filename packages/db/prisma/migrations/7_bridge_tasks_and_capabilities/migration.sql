-- Migration 7: Bridge Tasks, Capabilities, Local MCP, and Approvals (Phase 4B)

-- AlterTable bridge_devices
ALTER TABLE "bridge_devices" ADD COLUMN IF NOT EXISTS "allowed_roots" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "bridge_devices" ADD COLUMN IF NOT EXISTS "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "bridge_devices" ADD COLUMN IF NOT EXISTS "device_policy" JSONB;

-- CreateEnum LocalMcpServerStatus
DO $$ BEGIN
    CREATE TYPE "LocalMcpServerStatus" AS ENUM ('ACTIVE', 'DISABLED', 'CRASHED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- CreateEnum BridgeTaskStatus
DO $$ BEGIN
    CREATE TYPE "BridgeTaskStatus" AS ENUM ('QUEUED', 'AWAITING_APPROVAL', 'DISPATCHED', 'ACCEPTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED', 'UNKNOWN_OUTCOME', 'DEVICE_OFFLINE', 'EXPIRED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- CreateTable bridge_local_mcp_servers
CREATE TABLE IF NOT EXISTS "bridge_local_mcp_servers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "device_id" UUID NOT NULL REFERENCES "bridge_devices"("id") ON DELETE CASCADE,
    "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
    "server_name" VARCHAR(128) NOT NULL,
    "command" VARCHAR(255) NOT NULL,
    "args" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cwd" TEXT,
    "env" JSONB,
    "status" "LocalMcpServerStatus" NOT NULL DEFAULT 'ACTIVE',
    "schema_hash" VARCHAR(64),
    "tools" JSONB,
    "last_discovered_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("id"),
    CONSTRAINT "bridge_local_mcp_servers_device_name_unique" UNIQUE ("device_id", "server_name")
);

-- CreateTable bridge_tasks
CREATE TABLE IF NOT EXISTS "bridge_tasks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
    "device_id" UUID NOT NULL REFERENCES "bridge_devices"("id") ON DELETE CASCADE,
    "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "thread_id" UUID,
    "generation_run_id" UUID,
    "capability" VARCHAR(64) NOT NULL,
    "resource_scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "parameters" JSONB NOT NULL DEFAULT '{}',
    "arguments_hash" VARCHAR(64) NOT NULL,
    "status" "BridgeTaskStatus" NOT NULL DEFAULT 'QUEUED',
    "result" JSONB,
    "error_message" TEXT,
    "exit_code" INTEGER,
    "duration_ms" INTEGER,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("id")
);

-- CreateTable bridge_task_approvals
CREATE TABLE IF NOT EXISTS "bridge_task_approvals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "task_id" UUID NOT NULL UNIQUE REFERENCES "bridge_tasks"("id") ON DELETE CASCADE,
    "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
    "device_id" UUID NOT NULL REFERENCES "bridge_devices"("id") ON DELETE CASCADE,
    "requested_by_user_id" UUID REFERENCES "users"("id") ON DELETE SET NULL,
    "decided_by_user_id" UUID REFERENCES "users"("id") ON DELETE SET NULL,
    "status" "ToolApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "operation" VARCHAR(128) NOT NULL,
    "summary" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "arguments_hash" VARCHAR(64) NOT NULL,
    "nonce" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "decided_at" TIMESTAMPTZ(6),
    "rejection_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("id")
);

-- CreateTable bridge_task_logs
CREATE TABLE IF NOT EXISTS "bridge_task_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "task_id" UUID NOT NULL REFERENCES "bridge_tasks"("id") ON DELETE CASCADE,
    "sequence" INTEGER NOT NULL,
    "stream" VARCHAR(16) NOT NULL,
    "chunk" TEXT NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "bridge_local_mcp_servers_workspace_status_idx" ON "bridge_local_mcp_servers"("workspace_id", "status");
CREATE INDEX IF NOT EXISTS "bridge_tasks_device_status_idx" ON "bridge_tasks"("device_id", "status");
CREATE INDEX IF NOT EXISTS "bridge_tasks_workspace_status_idx" ON "bridge_tasks"("workspace_id", "status");
CREATE INDEX IF NOT EXISTS "bridge_tasks_thread_idx" ON "bridge_tasks"("thread_id");
CREATE INDEX IF NOT EXISTS "bridge_tasks_expires_idx" ON "bridge_tasks"("expires_at");
CREATE INDEX IF NOT EXISTS "bridge_task_approvals_workspace_status_idx" ON "bridge_task_approvals"("workspace_id", "status");
CREATE INDEX IF NOT EXISTS "bridge_task_approvals_device_status_idx" ON "bridge_task_approvals"("device_id", "status");
CREATE INDEX IF NOT EXISTS "bridge_task_approvals_expires_idx" ON "bridge_task_approvals"("expires_at");
CREATE INDEX IF NOT EXISTS "bridge_task_logs_task_seq_idx" ON "bridge_task_logs"("task_id", "sequence");

-- Phase 4B Security Hardening Extensions (Per-device HMAC keys, MCP pinning, Immutable Approval Bindings)
ALTER TABLE "bridge_devices" ADD COLUMN IF NOT EXISTS "task_signing_key_encrypted" TEXT;
ALTER TABLE "bridge_devices" ADD COLUMN IF NOT EXISTS "task_key_version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "bridge_local_mcp_servers" ADD COLUMN IF NOT EXISTS "approved_schema_hash" VARCHAR(64);
ALTER TABLE "bridge_local_mcp_servers" ADD COLUMN IF NOT EXISTS "pinned_executable_path" TEXT;
ALTER TABLE "bridge_local_mcp_servers" ADD COLUMN IF NOT EXISTS "pinned_executable_sha256" VARCHAR(64);
ALTER TABLE "bridge_local_mcp_servers" ADD COLUMN IF NOT EXISTS "package_name" VARCHAR(128);
ALTER TABLE "bridge_local_mcp_servers" ADD COLUMN IF NOT EXISTS "package_version" VARCHAR(64);
ALTER TABLE "bridge_local_mcp_servers" ADD COLUMN IF NOT EXISTS "user_confirmed_at" TIMESTAMPTZ(6);
ALTER TABLE "bridge_local_mcp_servers" ADD COLUMN IF NOT EXISTS "schema_drift_detected" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "bridge_task_approvals" ADD COLUMN IF NOT EXISTS "capability" VARCHAR(64);
ALTER TABLE "bridge_task_approvals" ADD COLUMN IF NOT EXISTS "resource_scopes" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "bridge_task_approvals" ADD COLUMN IF NOT EXISTS "executable_identity" TEXT;
ALTER TABLE "bridge_task_approvals" ADD COLUMN IF NOT EXISTS "mcp_server_name" VARCHAR(128);
ALTER TABLE "bridge_task_approvals" ADD COLUMN IF NOT EXISTS "mcp_schema_hash" VARCHAR(64);
