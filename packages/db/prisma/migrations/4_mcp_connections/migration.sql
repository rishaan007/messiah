-- CreateEnum
CREATE TYPE "McpTransportType" AS ENUM ('STREAMABLE_HTTP', 'SSE');

-- CreateEnum
CREATE TYPE "McpConnectionStatus" AS ENUM ('CONNECTED', 'DISCONNECTED', 'CONNECTING', 'ERROR');

-- CreateEnum
CREATE TYPE "McpAuthType" AS ENUM ('NONE', 'BEARER', 'OAUTH');

-- CreateEnum
CREATE TYPE "McpAuthStatus" AS ENUM ('NONE', 'CONFIGURED', 'AUTHENTICATED', 'EXPIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "McpPermissionMode" AS ENUM ('DISABLED', 'READ_ONLY', 'REQUIRE_APPROVAL', 'EXPLICITLY_AUTHORIZED');

-- CreateTable
CREATE TABLE "mcp_server_connections" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "endpoint_url" TEXT NOT NULL,
    "transport_type" "McpTransportType" NOT NULL DEFAULT 'STREAMABLE_HTTP',
    "status" "McpConnectionStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "protocol_version" VARCHAR(64),
    "server_name" VARCHAR(128),
    "server_version" VARCHAR(64),
    "server_capabilities" JSONB NOT NULL DEFAULT '{}',
    "authentication_status" "McpAuthStatus" NOT NULL DEFAULT 'NONE',
    "last_connected_at" TIMESTAMPTZ(6),
    "last_validated_at" TIMESTAMPTZ(6),
    "last_error_code" VARCHAR(64),
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mcp_server_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_credentials" (
    "id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "auth_type" "McpAuthType" NOT NULL DEFAULT 'NONE',
    "encrypted_access_token" TEXT,
    "encrypted_refresh_token" TEXT,
    "token_issuer" VARCHAR(255),
    "granted_scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "encryption_key_version" VARCHAR(16) NOT NULL DEFAULT 'v2',
    "token_expires_at" TIMESTAMPTZ(6),
    "client_information" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mcp_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_tool_definitions" (
    "id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "tool_name" VARCHAR(128) NOT NULL,
    "display_name" VARCHAR(255),
    "description" TEXT,
    "input_schema" JSONB NOT NULL,
    "output_schema" JSONB,
    "annotations" JSONB,
    "cache_metadata" JSONB,
    "discovered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "schema_hash" VARCHAR(64) NOT NULL,
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mcp_tool_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_tool_permissions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "tool_definition_id" UUID NOT NULL,
    "permission_mode" "McpPermissionMode" NOT NULL DEFAULT 'REQUIRE_APPROVAL',
    "requires_approval" BOOLEAN NOT NULL DEFAULT true,
    "configured_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mcp_tool_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mcp_server_connections_workspace_id_status_idx" ON "mcp_server_connections"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "mcp_server_connections_workspace_id_name_idx" ON "mcp_server_connections"("workspace_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_credentials_connection_id_key" ON "mcp_credentials"("connection_id");

-- CreateIndex
CREATE INDEX "mcp_tool_definitions_connection_id_is_available_idx" ON "mcp_tool_definitions"("connection_id", "is_available");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_tool_definitions_connection_id_tool_name_key" ON "mcp_tool_definitions"("connection_id", "tool_name");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_tool_permissions_tool_definition_id_key" ON "mcp_tool_permissions"("tool_definition_id");

-- CreateIndex
CREATE INDEX "mcp_tool_permissions_workspace_id_permission_mode_idx" ON "mcp_tool_permissions"("workspace_id", "permission_mode");

-- AddForeignKey
ALTER TABLE "mcp_server_connections" ADD CONSTRAINT "mcp_server_connections_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_server_connections" ADD CONSTRAINT "mcp_server_connections_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_credentials" ADD CONSTRAINT "mcp_credentials_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "mcp_server_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_tool_definitions" ADD CONSTRAINT "mcp_tool_definitions_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "mcp_server_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_tool_permissions" ADD CONSTRAINT "mcp_tool_permissions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_tool_permissions" ADD CONSTRAINT "mcp_tool_permissions_tool_definition_id_fkey" FOREIGN KEY ("tool_definition_id") REFERENCES "mcp_tool_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_tool_permissions" ADD CONSTRAINT "mcp_tool_permissions_configured_by_user_id_fkey" FOREIGN KEY ("configured_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
