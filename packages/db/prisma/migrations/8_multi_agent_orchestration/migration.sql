-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('PENDING', 'PLANNING', 'AWAITING_PLAN_APPROVAL', 'RUNNING', 'AWAITING_APPROVAL', 'SYNTHESIZING', 'COMPLETED', 'PARTIAL_COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AgentTaskStatus" AS ENUM ('PENDING', 'QUEUED', 'RUNNING', 'AWAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED', 'SKIPPED', 'UNKNOWN_OUTCOME');

-- CreateEnum
CREATE TYPE "AgentExecutionStatus" AS ENUM ('RUNNING', 'AWAITING_APPROVAL', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN_OUTCOME');

-- AlterTable
ALTER TABLE "bridge_tasks" ADD COLUMN     "agent_run_id" UUID,
ADD COLUMN     "agent_task_id" UUID;

-- AlterTable
ALTER TABLE "mcp_tool_calls" ADD COLUMN     "agent_run_id" UUID,
ADD COLUMN     "agent_task_id" UUID,
ALTER COLUMN "generation_run_id" DROP NOT NULL,
ALTER COLUMN "thread_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "agent_definitions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "created_by_user_id" UUID,
    "name" VARCHAR(128) NOT NULL,
    "slug" VARCHAR(128) NOT NULL,
    "role_title" VARCHAR(128) NOT NULL,
    "category" VARCHAR(64) NOT NULL DEFAULT 'custom',
    "description" TEXT,
    "avatar_accent" VARCHAR(32),
    "is_template" BOOLEAN NOT NULL DEFAULT false,
    "can_supervise" BOOLEAN NOT NULL DEFAULT false,
    "status" "AgentStatus" NOT NULL DEFAULT 'ACTIVE',
    "active_version" INTEGER NOT NULL DEFAULT 1,
    "provider_connection_id" UUID,
    "model_id" VARCHAR(128),
    "system_prompt" TEXT NOT NULL,
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    "max_output_tokens" INTEGER NOT NULL DEFAULT 4096,
    "allowed_mcp_tool_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowed_bridge_capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "preferred_bridge_device_id" UUID,
    "default_execution_budget" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "agent_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_configuration_versions" (
    "id" UUID NOT NULL,
    "agent_definition_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "role_title" VARCHAR(128) NOT NULL,
    "can_supervise" BOOLEAN NOT NULL DEFAULT false,
    "provider_connection_id" UUID,
    "model_id" VARCHAR(128),
    "system_prompt" TEXT NOT NULL,
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    "max_output_tokens" INTEGER NOT NULL DEFAULT 4096,
    "allowed_mcp_tool_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowed_bridge_capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "preferred_bridge_device_id" UUID,
    "execution_budget" JSONB NOT NULL DEFAULT '{}',
    "config_hash" VARCHAR(64) NOT NULL,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_configuration_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "created_by_user_id" UUID,
    "thread_id" UUID,
    "assistant_message_id" UUID,
    "supervisor_agent_id" UUID NOT NULL,
    "supervisor_version_id" UUID,
    "worker_agent_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "objective" TEXT NOT NULL,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'PENDING',
    "require_plan_approval" BOOLEAN NOT NULL DEFAULT false,
    "plan_approved_at" TIMESTAMPTZ(6),
    "plan_json" JSONB,
    "max_total_tokens" INTEGER NOT NULL DEFAULT 120000,
    "max_cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "max_duration_ms" INTEGER NOT NULL DEFAULT 300000,
    "max_concurrency" INTEGER NOT NULL DEFAULT 3,
    "max_delegation_depth" INTEGER NOT NULL DEFAULT 2,
    "max_replan_rounds" INTEGER NOT NULL DEFAULT 1,
    "replan_count" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "estimated_cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "final_summary" TEXT,
    "safe_error_code" VARCHAR(64),
    "error_message" TEXT,
    "cancellation_requested_at" TIMESTAMPTZ(6),
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_tasks" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "task_key" VARCHAR(64) NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "instructions" TEXT NOT NULL,
    "assigned_agent_id" UUID NOT NULL,
    "assigned_version_id" UUID,
    "depends_on_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "input_task_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "delegation_depth" INTEGER NOT NULL DEFAULT 1,
    "fingerprint" VARCHAR(64) NOT NULL,
    "status" "AgentTaskStatus" NOT NULL DEFAULT 'PENDING',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "max_iterations" INTEGER NOT NULL DEFAULT 4,
    "target_bridge_device_id" UUID,
    "output_summary" TEXT,
    "output_data" JSONB,
    "error_code" VARCHAR(64),
    "error_message" TEXT,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "agent_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_executions" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "task_id" UUID,
    "workspace_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "version_id" UUID,
    "phase" VARCHAR(32) NOT NULL,
    "status" "AgentExecutionStatus" NOT NULL DEFAULT 'RUNNING',
    "provider_connection_id" UUID,
    "model_id" VARCHAR(128),
    "iterations_used" INTEGER NOT NULL DEFAULT 0,
    "tool_call_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bridge_task_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "duration_ms" INTEGER,
    "result_summary" TEXT,
    "error_message" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "agent_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_communications" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "task_id" UUID,
    "workspace_id" UUID NOT NULL,
    "from_agent_id" UUID,
    "to_agent_id" UUID,
    "message_type" VARCHAR(32) NOT NULL,
    "summary" TEXT NOT NULL,
    "payload_digest" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_communications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_artifacts" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "task_id" UUID,
    "workspace_id" UUID NOT NULL,
    "agent_id" UUID,
    "artifact_type" VARCHAR(48) NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_run_events" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "event_type" VARCHAR(64) NOT NULL,
    "task_id" UUID,
    "agent_id" UUID,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_run_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_definitions_workspace_id_status_idx" ON "agent_definitions"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "agent_definitions_workspace_id_can_supervise_idx" ON "agent_definitions"("workspace_id", "can_supervise");

-- CreateIndex
CREATE UNIQUE INDEX "agent_definitions_workspace_id_slug_key" ON "agent_definitions"("workspace_id", "slug");

-- CreateIndex
CREATE INDEX "agent_configuration_versions_workspace_id_agent_definition__idx" ON "agent_configuration_versions"("workspace_id", "agent_definition_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_configuration_versions_agent_definition_id_version_nu_key" ON "agent_configuration_versions"("agent_definition_id", "version_number");

-- CreateIndex
CREATE INDEX "agent_runs_workspace_id_status_idx" ON "agent_runs"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "agent_runs_workspace_id_created_at_idx" ON "agent_runs"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "agent_runs_thread_id_idx" ON "agent_runs"("thread_id");

-- CreateIndex
CREATE INDEX "agent_tasks_run_id_status_idx" ON "agent_tasks"("run_id", "status");

-- CreateIndex
CREATE INDEX "agent_tasks_run_id_fingerprint_idx" ON "agent_tasks"("run_id", "fingerprint");

-- CreateIndex
CREATE INDEX "agent_tasks_workspace_id_assigned_agent_id_idx" ON "agent_tasks"("workspace_id", "assigned_agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_tasks_run_id_task_key_key" ON "agent_tasks"("run_id", "task_key");

-- CreateIndex
CREATE INDEX "agent_executions_run_id_started_at_idx" ON "agent_executions"("run_id", "started_at");

-- CreateIndex
CREATE INDEX "agent_executions_task_id_idx" ON "agent_executions"("task_id");

-- CreateIndex
CREATE INDEX "agent_executions_workspace_id_agent_id_idx" ON "agent_executions"("workspace_id", "agent_id");

-- CreateIndex
CREATE INDEX "agent_communications_run_id_created_at_idx" ON "agent_communications"("run_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_communications_workspace_id_idx" ON "agent_communications"("workspace_id");

-- CreateIndex
CREATE INDEX "agent_artifacts_run_id_created_at_idx" ON "agent_artifacts"("run_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_artifacts_workspace_id_idx" ON "agent_artifacts"("workspace_id");

-- CreateIndex
CREATE INDEX "agent_run_events_run_id_created_at_idx" ON "agent_run_events"("run_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_run_events_workspace_id_idx" ON "agent_run_events"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_run_events_run_id_sequence_key" ON "agent_run_events"("run_id", "sequence");

-- CreateIndex
CREATE INDEX "bridge_tasks_agent_run_id_idx" ON "bridge_tasks"("agent_run_id");

-- CreateIndex
CREATE INDEX "bridge_tasks_agent_task_id_idx" ON "bridge_tasks"("agent_task_id");

-- CreateIndex
CREATE INDEX "mcp_tool_calls_agent_run_id_idx" ON "mcp_tool_calls"("agent_run_id");

-- CreateIndex
CREATE INDEX "mcp_tool_calls_agent_task_id_idx" ON "mcp_tool_calls"("agent_task_id");

-- AddForeignKey
ALTER TABLE "mcp_tool_calls" ADD CONSTRAINT "mcp_tool_calls_agent_run_id_fkey" FOREIGN KEY ("agent_run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_tool_calls" ADD CONSTRAINT "mcp_tool_calls_agent_task_id_fkey" FOREIGN KEY ("agent_task_id") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bridge_tasks" ADD CONSTRAINT "bridge_tasks_agent_run_id_fkey" FOREIGN KEY ("agent_run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bridge_tasks" ADD CONSTRAINT "bridge_tasks_agent_task_id_fkey" FOREIGN KEY ("agent_task_id") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_definitions" ADD CONSTRAINT "agent_definitions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_definitions" ADD CONSTRAINT "agent_definitions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_definitions" ADD CONSTRAINT "agent_definitions_provider_connection_id_fkey" FOREIGN KEY ("provider_connection_id") REFERENCES "provider_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_definitions" ADD CONSTRAINT "agent_definitions_preferred_bridge_device_id_fkey" FOREIGN KEY ("preferred_bridge_device_id") REFERENCES "bridge_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_configuration_versions" ADD CONSTRAINT "agent_configuration_versions_agent_definition_id_fkey" FOREIGN KEY ("agent_definition_id") REFERENCES "agent_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_configuration_versions" ADD CONSTRAINT "agent_configuration_versions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_configuration_versions" ADD CONSTRAINT "agent_configuration_versions_provider_connection_id_fkey" FOREIGN KEY ("provider_connection_id") REFERENCES "provider_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_configuration_versions" ADD CONSTRAINT "agent_configuration_versions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_supervisor_agent_id_fkey" FOREIGN KEY ("supervisor_agent_id") REFERENCES "agent_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_supervisor_version_id_fkey" FOREIGN KEY ("supervisor_version_id") REFERENCES "agent_configuration_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_assigned_agent_id_fkey" FOREIGN KEY ("assigned_agent_id") REFERENCES "agent_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_assigned_version_id_fkey" FOREIGN KEY ("assigned_version_id") REFERENCES "agent_configuration_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_target_bridge_device_id_fkey" FOREIGN KEY ("target_bridge_device_id") REFERENCES "bridge_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_executions" ADD CONSTRAINT "agent_executions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_executions" ADD CONSTRAINT "agent_executions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_executions" ADD CONSTRAINT "agent_executions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_executions" ADD CONSTRAINT "agent_executions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_executions" ADD CONSTRAINT "agent_executions_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "agent_configuration_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_communications" ADD CONSTRAINT "agent_communications_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_communications" ADD CONSTRAINT "agent_communications_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "agent_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_communications" ADD CONSTRAINT "agent_communications_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_artifacts" ADD CONSTRAINT "agent_artifacts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_artifacts" ADD CONSTRAINT "agent_artifacts_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "agent_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_artifacts" ADD CONSTRAINT "agent_artifacts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

