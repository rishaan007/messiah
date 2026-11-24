-- AlterEnum
ALTER TYPE "MessageRole" ADD VALUE IF NOT EXISTS 'SYSTEM';
ALTER TYPE "MessageRole" ADD VALUE IF NOT EXISTS 'TOOL';

-- AlterEnum
ALTER TYPE "RunStatus" ADD VALUE IF NOT EXISTS 'AWAITING_APPROVAL';

-- CreateEnum
CREATE TYPE "ToolCallStatus" AS ENUM ('PROPOSED', 'AWAITING_APPROVAL', 'APPROVED', 'EXECUTING', 'SUCCEEDED', 'FAILED', 'DENIED', 'CANCELLED', 'EXPIRED', 'UNKNOWN_OUTCOME');

-- CreateEnum
CREATE TYPE "ToolApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'EXPIRED');

-- CreateTable
CREATE TABLE "mcp_tool_calls" (
    "id" UUID NOT NULL,
    "generation_run_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "tool_definition_id" UUID NOT NULL,
    "provider_call_id" VARCHAR(128) NOT NULL,
    "provider_tool_alias" VARCHAR(128) NOT NULL,
    "connection_id" UUID NOT NULL,
    "tool_name" VARCHAR(128) NOT NULL,
    "schema_hash" VARCHAR(64) NOT NULL,
    "arguments_hash" VARCHAR(64) NOT NULL,
    "encrypted_arguments" TEXT,
    "arguments_preview" JSONB NOT NULL DEFAULT '{}',
    "status" "ToolCallStatus" NOT NULL DEFAULT 'PROPOSED',
    "result" JSONB,
    "is_error" BOOLEAN NOT NULL DEFAULT false,
    "error_message" TEXT,
    "duration_ms" INTEGER,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mcp_tool_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_tool_approvals" (
    "id" UUID NOT NULL,
    "tool_call_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "requested_by_user_id" UUID,
    "decided_by_user_id" UUID,
    "status" "ToolApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "arguments_hash" VARCHAR(64) NOT NULL,
    "schema_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "decided_at" TIMESTAMPTZ(6),
    "rejection_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mcp_tool_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mcp_tool_calls_generation_run_id_idx" ON "mcp_tool_calls"("generation_run_id");

-- CreateIndex
CREATE INDEX "mcp_tool_calls_thread_id_idx" ON "mcp_tool_calls"("thread_id");

-- CreateIndex
CREATE INDEX "mcp_tool_calls_workspace_id_status_idx" ON "mcp_tool_calls"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "mcp_tool_calls_tool_definition_id_idx" ON "mcp_tool_calls"("tool_definition_id");

-- CreateIndex
CREATE INDEX "mcp_tool_calls_connection_id_idx" ON "mcp_tool_calls"("connection_id");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_tool_approvals_tool_call_id_key" ON "mcp_tool_approvals"("tool_call_id");

-- CreateIndex
CREATE INDEX "mcp_tool_approvals_workspace_id_status_idx" ON "mcp_tool_approvals"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "mcp_tool_approvals_expires_at_idx" ON "mcp_tool_approvals"("expires_at");

-- Update Single Active Run Concurrency Index to include AWAITING_APPROVAL
DROP INDEX IF EXISTS "idx_generation_runs_single_active_per_thread";
CREATE UNIQUE INDEX "idx_generation_runs_single_active_per_thread" ON "generation_runs" ("thread_id") WHERE status IN ('PENDING', 'STREAMING', 'AWAITING_APPROVAL');

-- AddForeignKey
ALTER TABLE "mcp_tool_calls" ADD CONSTRAINT "mcp_tool_calls_generation_run_id_fkey" FOREIGN KEY ("generation_run_id") REFERENCES "generation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_tool_calls" ADD CONSTRAINT "mcp_tool_calls_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_tool_calls" ADD CONSTRAINT "mcp_tool_calls_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_tool_calls" ADD CONSTRAINT "mcp_tool_calls_tool_definition_id_fkey" FOREIGN KEY ("tool_definition_id") REFERENCES "mcp_tool_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_tool_calls" ADD CONSTRAINT "mcp_tool_calls_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "mcp_server_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_tool_approvals" ADD CONSTRAINT "mcp_tool_approvals_tool_call_id_fkey" FOREIGN KEY ("tool_call_id") REFERENCES "mcp_tool_calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_tool_approvals" ADD CONSTRAINT "mcp_tool_approvals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_tool_approvals" ADD CONSTRAINT "mcp_tool_approvals_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_tool_approvals" ADD CONSTRAINT "mcp_tool_approvals_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
