-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('PENDING', 'STREAMING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('PENDING', 'STREAMING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "threads" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "title" VARCHAR(255) NOT NULL DEFAULT 'New Conversation',
    "preferred_provider_connection_id" UUID,
    "preferred_model_id" VARCHAR(128),
    "last_message_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'COMPLETED',
    "provider_connection_id" UUID,
    "model_id" VARCHAR(128),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_runs" (
    "id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "assistant_message_id" UUID NOT NULL,
    "provider_connection_id" UUID NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "model_id" VARCHAR(128) NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'PENDING',
    "idempotency_key" VARCHAR(128),
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cached_input_tokens" INTEGER NOT NULL DEFAULT 0,
    "provider_response_id" VARCHAR(255),
    "safe_error_code" VARCHAR(64),
    "cancellation_requested_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "generation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "threads_workspace_id_archived_at_last_message_at_idx" ON "threads"("workspace_id", "archived_at", "last_message_at" DESC);

-- CreateIndex
CREATE INDEX "threads_workspace_id_idx" ON "threads"("workspace_id");

-- CreateIndex
CREATE INDEX "threads_created_by_user_id_idx" ON "threads"("created_by_user_id");

-- CreateIndex
CREATE INDEX "messages_thread_id_sequence_idx" ON "messages"("thread_id", "sequence" ASC);

-- CreateIndex
CREATE INDEX "messages_thread_id_created_at_idx" ON "messages"("thread_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "messages_thread_id_sequence_key" ON "messages"("thread_id", "sequence");

-- CreateIndex
CREATE INDEX "generation_runs_thread_id_status_idx" ON "generation_runs"("thread_id", "status");

-- CreateIndex
CREATE INDEX "generation_runs_thread_id_created_at_idx" ON "generation_runs"("thread_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "generation_runs_idempotency_key_idx" ON "generation_runs"("idempotency_key");

-- AddForeignKey
ALTER TABLE "threads" ADD CONSTRAINT "threads_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "threads" ADD CONSTRAINT "threads_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "threads" ADD CONSTRAINT "threads_preferred_provider_connection_id_fkey" FOREIGN KEY ("preferred_provider_connection_id") REFERENCES "provider_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_provider_connection_id_fkey" FOREIGN KEY ("provider_connection_id") REFERENCES "provider_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_assistant_message_id_fkey" FOREIGN KEY ("assistant_message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_provider_connection_id_fkey" FOREIGN KEY ("provider_connection_id") REFERENCES "provider_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
