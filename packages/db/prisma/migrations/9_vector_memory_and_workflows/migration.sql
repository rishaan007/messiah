-- Enable pgvector extension (idempotent)
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "MemoryScope" AS ENUM ('PERSONAL', 'WORKSPACE', 'AGENT');

-- CreateEnum
CREATE TYPE "MemorySourceType" AS ENUM ('MANUAL', 'CONVERSATION_SUMMARY', 'PREFERENCE', 'WORKSPACE_DECISION', 'AGENT_FINDING', 'WORKFLOW_OUTPUT', 'ARTIFACT');

-- CreateEnum
CREATE TYPE "MemorySensitivity" AS ENUM ('PUBLIC_WORKSPACE', 'PERSONAL_PRIVATE', 'AGENT_RESTRICTED', 'SENSITIVE_REDACTED');

-- CreateEnum
CREATE TYPE "WorkflowStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "WorkflowTriggerType" AS ENUM ('MANUAL', 'SCHEDULE', 'EVENT');

-- CreateEnum
CREATE TYPE "WorkflowMisfirePolicy" AS ENUM ('SKIP', 'FIRE_ONCE', 'CATCH_UP_BOUNDED');

-- CreateEnum
CREATE TYPE "WorkflowConcurrencyPolicy" AS ENUM ('SKIP_IF_RUNNING', 'ALLOW_CONCURRENT', 'REPLACE_QUEUED');

-- CreateEnum
CREATE TYPE "WorkflowRunStatus" AS ENUM ('PENDING', 'RUNNING', 'AWAITING_APPROVAL', 'COMPLETED', 'PARTIAL_COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WorkflowNodeStatus" AS ENUM ('PENDING', 'QUEUED', 'RUNNING', 'AWAITING_APPROVAL', 'COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED', 'UNKNOWN_OUTCOME');

-- AlterTable
ALTER TABLE "bridge_tasks" ADD COLUMN     "workflow_node_exec_id" UUID,
ADD COLUMN     "workflow_run_id" UUID;

-- AlterTable
ALTER TABLE "mcp_tool_calls" ADD COLUMN     "workflow_node_exec_id" UUID,
ADD COLUMN     "workflow_run_id" UUID;

-- CreateTable
CREATE TABLE "memory_settings" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "embedding_provider" VARCHAR(64),
    "embedding_model" VARCHAR(128),
    "embedding_dimensions" INTEGER NOT NULL DEFAULT 1536,
    "provider_connection_id" UUID,
    "enable_auto_capture" BOOLEAN NOT NULL DEFAULT false,
    "enable_chat_injection" BOOLEAN NOT NULL DEFAULT true,
    "enable_swarm_injection" BOOLEAN NOT NULL DEFAULT true,
    "default_top_k" INTEGER NOT NULL DEFAULT 6,
    "min_similarity_score" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "retention_days" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "memory_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_collections" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "scope" "MemoryScope" NOT NULL DEFAULT 'WORKSPACE',
    "owner_user_id" UUID,
    "agent_id" UUID,
    "name" VARCHAR(128) NOT NULL,
    "slug" VARCHAR(128) NOT NULL,
    "description" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "memory_collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memories" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "scope" "MemoryScope" NOT NULL,
    "owner_user_id" UUID,
    "agent_id" UUID,
    "collection_id" UUID,
    "source_type" "MemorySourceType" NOT NULL DEFAULT 'MANUAL',
    "source_thread_id" UUID,
    "source_message_id" UUID,
    "source_agent_run_id" UUID,
    "source_workflow_run_id" UUID,
    "title" VARCHAR(200) NOT NULL,
    "content" TEXT NOT NULL,
    "summary" TEXT,
    "content_hash" VARCHAR(64) NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "importance" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "sensitivity" "MemorySensitivity" NOT NULL DEFAULT 'PUBLIC_WORKSPACE',
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "access_count" INTEGER NOT NULL DEFAULT 0,
    "last_accessed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_embeddings" (
    "id" UUID NOT NULL,
    "memory_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "embedding_model" VARCHAR(128) NOT NULL,
    "embedding_provider" VARCHAR(64) NOT NULL,
    "embedding_dimensions" INTEGER NOT NULL,
    "embedding" vector,
    "content_hash" VARCHAR(64) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'READY',
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "memory_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_versions" (
    "id" UUID NOT NULL,
    "memory_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "content" TEXT NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "change_reason" VARCHAR(255),
    "edited_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_access_policies" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "memory_id" UUID,
    "collection_id" UUID,
    "principal_type" VARCHAR(32) NOT NULL,
    "principal_id" VARCHAR(128) NOT NULL,
    "can_read" BOOLEAN NOT NULL DEFAULT true,
    "can_write" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_access_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_definitions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "slug" VARCHAR(128) NOT NULL,
    "description" TEXT,
    "category" VARCHAR(64) NOT NULL DEFAULT 'automation',
    "status" "WorkflowStatus" NOT NULL DEFAULT 'DRAFT',
    "active_version_number" INTEGER,
    "draft_graph" JSONB NOT NULL,
    "default_input_schema" JSONB,
    "is_template" BOOLEAN NOT NULL DEFAULT false,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workflow_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_versions" (
    "id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "definition_json" JSONB NOT NULL,
    "graph_hash" VARCHAR(64) NOT NULL,
    "published_by_user_id" UUID,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_schedules" (
    "id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "version_id" UUID,
    "cron_expression" VARCHAR(128) NOT NULL,
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "misfire_policy" "WorkflowMisfirePolicy" NOT NULL DEFAULT 'FIRE_ONCE',
    "concurrency_policy" "WorkflowConcurrencyPolicy" NOT NULL DEFAULT 'SKIP_IF_RUNNING',
    "static_input" JSONB NOT NULL DEFAULT '{}',
    "last_triggered_at" TIMESTAMPTZ(6),
    "next_run_at" TIMESTAMPTZ(6),
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workflow_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_event_triggers" (
    "id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "version_id" UUID,
    "event_type" VARCHAR(96) NOT NULL,
    "filter_rules" JSONB NOT NULL DEFAULT '{}',
    "cooldown_seconds" INTEGER NOT NULL DEFAULT 5,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_triggered_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workflow_event_triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_runs" (
    "id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "triggered_by_user_id" UUID,
    "trigger_type" "WorkflowTriggerType" NOT NULL,
    "trigger_event_id" VARCHAR(128),
    "correlation_id" VARCHAR(128),
    "source_workflow_id" UUID,
    "recursion_depth" INTEGER NOT NULL DEFAULT 0,
    "status" "WorkflowRunStatus" NOT NULL DEFAULT 'PENDING',
    "trigger_payload" JSONB NOT NULL DEFAULT '{}',
    "final_output" JSONB,
    "final_summary" TEXT,
    "safe_error_code" VARCHAR(64),
    "error_message" TEXT,
    "cancellation_requested_at" TIMESTAMPTZ(6),
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_node_executions" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "node_id" VARCHAR(64) NOT NULL,
    "node_type" VARCHAR(48) NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "status" "WorkflowNodeStatus" NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "input_data" JSONB,
    "output_data" JSONB,
    "error_code" VARCHAR(64),
    "error_message" TEXT,
    "duration_ms" INTEGER,
    "agent_run_id" UUID,
    "tool_call_id" UUID,
    "bridge_task_id" UUID,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workflow_node_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_approvals" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "node_execution_id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "node_id" VARCHAR(64) NOT NULL,
    "requested_by_user_id" UUID,
    "decided_by_user_id" UUID,
    "status" "ToolApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "title" VARCHAR(160) NOT NULL,
    "summary" TEXT NOT NULL,
    "context_preview" JSONB NOT NULL DEFAULT '{}',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "decided_at" TIMESTAMPTZ(6),
    "rejection_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workflow_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_run_events" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "event_type" VARCHAR(64) NOT NULL,
    "node_id" VARCHAR(64),
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_run_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_event_logs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "trigger_id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "event_type" VARCHAR(96) NOT NULL,
    "dedup_key" VARCHAR(160) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "run_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_event_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "memory_settings_workspace_id_key" ON "memory_settings"("workspace_id");

-- CreateIndex
CREATE INDEX "memory_collections_workspace_id_scope_idx" ON "memory_collections"("workspace_id", "scope");

-- CreateIndex
CREATE INDEX "memory_collections_workspace_id_owner_user_id_idx" ON "memory_collections"("workspace_id", "owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_collections_workspace_id_slug_key" ON "memory_collections"("workspace_id", "slug");

-- CreateIndex
CREATE INDEX "memories_workspace_id_scope_owner_user_id_is_archived_idx" ON "memories"("workspace_id", "scope", "owner_user_id", "is_archived");

-- CreateIndex
CREATE INDEX "memories_workspace_id_scope_agent_id_is_archived_idx" ON "memories"("workspace_id", "scope", "agent_id", "is_archived");

-- CreateIndex
CREATE INDEX "memories_workspace_id_content_hash_idx" ON "memories"("workspace_id", "content_hash");

-- CreateIndex
CREATE INDEX "memories_collection_id_idx" ON "memories"("collection_id");

-- CreateIndex
CREATE INDEX "memories_expires_at_idx" ON "memories"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "memory_embeddings_memory_id_key" ON "memory_embeddings"("memory_id");

-- CreateIndex
CREATE INDEX "memory_embeddings_workspace_id_embedding_model_embedding_di_idx" ON "memory_embeddings"("workspace_id", "embedding_model", "embedding_dimensions");

-- CreateIndex
CREATE INDEX "memory_embeddings_workspace_id_status_idx" ON "memory_embeddings"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "memory_versions_workspace_id_memory_id_idx" ON "memory_versions"("workspace_id", "memory_id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_versions_memory_id_version_number_key" ON "memory_versions"("memory_id", "version_number");

-- CreateIndex
CREATE INDEX "memory_access_policies_workspace_id_memory_id_idx" ON "memory_access_policies"("workspace_id", "memory_id");

-- CreateIndex
CREATE INDEX "memory_access_policies_workspace_id_collection_id_idx" ON "memory_access_policies"("workspace_id", "collection_id");

-- CreateIndex
CREATE INDEX "memory_access_policies_workspace_id_principal_type_principa_idx" ON "memory_access_policies"("workspace_id", "principal_type", "principal_id");

-- CreateIndex
CREATE INDEX "workflow_definitions_workspace_id_status_idx" ON "workflow_definitions"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_definitions_workspace_id_slug_key" ON "workflow_definitions"("workspace_id", "slug");

-- CreateIndex
CREATE INDEX "workflow_versions_workspace_id_workflow_id_idx" ON "workflow_versions"("workspace_id", "workflow_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_versions_workflow_id_version_number_key" ON "workflow_versions"("workflow_id", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_schedules_workflow_id_key" ON "workflow_schedules"("workflow_id");

-- CreateIndex
CREATE INDEX "workflow_schedules_enabled_next_run_at_idx" ON "workflow_schedules"("enabled", "next_run_at");

-- CreateIndex
CREATE INDEX "workflow_schedules_workspace_id_idx" ON "workflow_schedules"("workspace_id");

-- CreateIndex
CREATE INDEX "workflow_event_triggers_workspace_id_event_type_enabled_idx" ON "workflow_event_triggers"("workspace_id", "event_type", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_event_triggers_workflow_id_event_type_key" ON "workflow_event_triggers"("workflow_id", "event_type");

-- CreateIndex
CREATE INDEX "workflow_runs_workspace_id_status_idx" ON "workflow_runs"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "workflow_runs_workflow_id_created_at_idx" ON "workflow_runs"("workflow_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "workflow_runs_trigger_event_id_idx" ON "workflow_runs"("trigger_event_id");

-- CreateIndex
CREATE INDEX "workflow_node_executions_run_id_status_idx" ON "workflow_node_executions"("run_id", "status");

-- CreateIndex
CREATE INDEX "workflow_node_executions_workspace_id_idx" ON "workflow_node_executions"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_node_executions_run_id_node_id_key" ON "workflow_node_executions"("run_id", "node_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_approvals_node_execution_id_key" ON "workflow_approvals"("node_execution_id");

-- CreateIndex
CREATE INDEX "workflow_approvals_workspace_id_status_idx" ON "workflow_approvals"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "workflow_approvals_run_id_status_idx" ON "workflow_approvals"("run_id", "status");

-- CreateIndex
CREATE INDEX "workflow_approvals_expires_at_idx" ON "workflow_approvals"("expires_at");

-- CreateIndex
CREATE INDEX "workflow_run_events_run_id_created_at_idx" ON "workflow_run_events"("run_id", "created_at");

-- CreateIndex
CREATE INDEX "workflow_run_events_workspace_id_idx" ON "workflow_run_events"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_run_events_run_id_sequence_key" ON "workflow_run_events"("run_id", "sequence");

-- CreateIndex
CREATE INDEX "workflow_event_logs_workspace_id_created_at_idx" ON "workflow_event_logs"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_event_logs_trigger_id_dedup_key_key" ON "workflow_event_logs"("trigger_id", "dedup_key");

-- CreateIndex
CREATE INDEX "bridge_tasks_workflow_run_id_idx" ON "bridge_tasks"("workflow_run_id");

-- CreateIndex
CREATE INDEX "bridge_tasks_workflow_node_exec_id_idx" ON "bridge_tasks"("workflow_node_exec_id");

-- CreateIndex
CREATE INDEX "mcp_tool_calls_workflow_run_id_idx" ON "mcp_tool_calls"("workflow_run_id");

-- CreateIndex
CREATE INDEX "mcp_tool_calls_workflow_node_exec_id_idx" ON "mcp_tool_calls"("workflow_node_exec_id");

-- AddForeignKey
ALTER TABLE "memory_settings" ADD CONSTRAINT "memory_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_collections" ADD CONSTRAINT "memory_collections_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_collections" ADD CONSTRAINT "memory_collections_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_collections" ADD CONSTRAINT "memory_collections_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agent_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "memory_collections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_versions" ADD CONSTRAINT "memory_versions_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_versions" ADD CONSTRAINT "memory_versions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_versions" ADD CONSTRAINT "memory_versions_edited_by_user_id_fkey" FOREIGN KEY ("edited_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_access_policies" ADD CONSTRAINT "memory_access_policies_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_access_policies" ADD CONSTRAINT "memory_access_policies_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_access_policies" ADD CONSTRAINT "memory_access_policies_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "memory_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_definitions" ADD CONSTRAINT "workflow_definitions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_definitions" ADD CONSTRAINT "workflow_definitions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflow_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_published_by_user_id_fkey" FOREIGN KEY ("published_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_schedules" ADD CONSTRAINT "workflow_schedules_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflow_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_schedules" ADD CONSTRAINT "workflow_schedules_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_event_triggers" ADD CONSTRAINT "workflow_event_triggers_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflow_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_event_triggers" ADD CONSTRAINT "workflow_event_triggers_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflow_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "workflow_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_triggered_by_user_id_fkey" FOREIGN KEY ("triggered_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_node_executions" ADD CONSTRAINT "workflow_node_executions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_node_executions" ADD CONSTRAINT "workflow_node_executions_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflow_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_node_executions" ADD CONSTRAINT "workflow_node_executions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_approvals" ADD CONSTRAINT "workflow_approvals_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_approvals" ADD CONSTRAINT "workflow_approvals_node_execution_id_fkey" FOREIGN KEY ("node_execution_id") REFERENCES "workflow_node_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_approvals" ADD CONSTRAINT "workflow_approvals_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflow_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_approvals" ADD CONSTRAINT "workflow_approvals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_approvals" ADD CONSTRAINT "workflow_approvals_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_approvals" ADD CONSTRAINT "workflow_approvals_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_run_events" ADD CONSTRAINT "workflow_run_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_run_events" ADD CONSTRAINT "workflow_run_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_event_logs" ADD CONSTRAINT "workflow_event_logs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_event_logs" ADD CONSTRAINT "workflow_event_logs_trigger_id_fkey" FOREIGN KEY ("trigger_id") REFERENCES "workflow_event_triggers"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Vector HNSW cosine indexes partitioned by dimension for fast ANN search without locking out alternative dimensions
CREATE INDEX IF NOT EXISTS "idx_memory_embeddings_hnsw_1536" ON "memory_embeddings" USING hnsw (("embedding"::vector(1536)) vector_cosine_ops) WHERE "embedding_dimensions" = 1536;
CREATE INDEX IF NOT EXISTS "idx_memory_embeddings_hnsw_768" ON "memory_embeddings" USING hnsw (("embedding"::vector(768)) vector_cosine_ops) WHERE "embedding_dimensions" = 768;
CREATE INDEX IF NOT EXISTS "idx_memories_lexical_tsv" ON "memories" USING gin (to_tsvector('english', coalesce("title", '') || ' ' || coalesce("content", '')));
