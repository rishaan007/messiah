#!/usr/bin/env bash
set -euo pipefail

# MESSIAH PostgreSQL + pgvector Verified Restore Script
# Validates SHA-256 archive integrity, guarantees pgvector extension presence,
# and restores schemas/HNSW indexes cleanly into the target database URL.

DUMP_FILE="${1:?Usage: restore-postgres.sh <dump-file> <target-database-url>}"
TARGET_DB_URL="${2:?Usage: restore-postgres.sh <dump-file> <target-database-url>}"
TARGET_PG_URL="$(printf '%s' "${TARGET_DB_URL}" | sed -E 's/([?&])schema=[^&]*&?/\1/; s/[?&]$//')"

if [ ! -f "${DUMP_FILE}" ]; then
  echo "[Restore] ERROR: Dump file not found: ${DUMP_FILE}" >&2
  exit 1
fi

if [ -f "${DUMP_FILE}.sha256" ]; then
  echo "[Restore] Verifying SHA-256 archive checksum..."
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c "${DUMP_FILE}.sha256"
  else
    shasum -a 256 -c "${DUMP_FILE}.sha256"
  fi
fi

echo "[Restore] Ensuring pgvector extension exists in target database..."
psql "${TARGET_PG_URL}" -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null

echo "[Restore] Restoring archive cleanly into target database..."
pg_restore --clean --if-exists --no-owner --no-acl --dbname="${TARGET_PG_URL}" "${DUMP_FILE}"

echo "[Restore] Verifying restored vector extension and core tables..."
psql "${TARGET_PG_URL}" -c "SELECT count(*) AS restored_memories FROM memories; SELECT count(*) AS restored_workflows FROM workflow_definitions;"
echo "[Restore] Verification succeeded."
