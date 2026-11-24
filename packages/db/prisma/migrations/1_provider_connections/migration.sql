-- CreateEnum
CREATE TYPE "ProviderStatus" AS ENUM ('ACTIVE', 'INVALID', 'ERROR');

-- CreateTable
CREATE TABLE "provider_connections" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "display_name" VARCHAR(128) NOT NULL,
    "status" "ProviderStatus" NOT NULL DEFAULT 'ACTIVE',
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "created_by_user_id" UUID,
    "last_validated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "provider_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "encrypted_credentials" (
    "id" UUID NOT NULL,
    "provider_connection_id" UUID NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "initialization_vector" VARCHAR(64) NOT NULL,
    "authentication_tag" VARCHAR(64) NOT NULL,
    "key_version" VARCHAR(32) NOT NULL DEFAULT 'v1',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "encrypted_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "actor_id" UUID,
    "action" VARCHAR(64) NOT NULL,
    "resource_type" VARCHAR(64) NOT NULL,
    "resource_id" VARCHAR(64),
    "details" JSONB NOT NULL DEFAULT '{}',
    "ip_address" VARCHAR(45),
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "provider_connections_workspace_id_idx" ON "provider_connections"("workspace_id");

-- CreateIndex
CREATE INDEX "provider_connections_provider_idx" ON "provider_connections"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "provider_connections_workspace_id_provider_display_name_key" ON "provider_connections"("workspace_id", "provider", "display_name");

-- CreateIndex
CREATE UNIQUE INDEX "encrypted_credentials_provider_connection_id_key" ON "encrypted_credentials"("provider_connection_id");

-- CreateIndex
CREATE INDEX "encrypted_credentials_provider_connection_id_idx" ON "encrypted_credentials"("provider_connection_id");

-- CreateIndex
CREATE INDEX "audit_logs_workspace_id_idx" ON "audit_logs"("workspace_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encrypted_credentials" ADD CONSTRAINT "encrypted_credentials_provider_connection_id_fkey" FOREIGN KEY ("provider_connection_id") REFERENCES "provider_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
