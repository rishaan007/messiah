#!/usr/bin/env bash
set -euo pipefail

# MESSIAH PostgreSQL + pgvector Backup Script
# Creates a custom-format compressed dump preserving schemas, HNSW vector indexes, and workflows,
# emits a SHA-256 checksum manifest, and verifies archive integrity cleanly with pg_restore --list.

BACKUP_DIR="${1:-./backups}"
DB_URL="${DATABASE_URL:?DATABASE_URL environment variable is required}"
# Strip Prisma-specific ?schema=... parameter unsupported by libpq pg_dump/psql
PG_URL="$(printf '%s' "${DB_URL}" | sed -E 's/([?&])schema=[^&]*&?/\1/; s/[?&]$//')"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="${BACKUP_DIR}/messiah_${TIMESTAMP}.dump"

mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

echo "[Backup] Creating compressed PostgreSQL + pgvector dump at ${OUT_FILE}..."
pg_dump --format=custom --compress=9 --no-owner --no-acl --file="${OUT_FILE}" "${PG_URL}"

echo "[Backup] Verifying dump archive structure via pg_restore --list..."
pg_restore --list "${OUT_FILE}" > "${OUT_FILE}.toc"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "${OUT_FILE}" > "${OUT_FILE}.sha256"
else
  shasum -a 256 "${OUT_FILE}" > "${OUT_FILE}.sha256"
fi

echo "[Backup] Complete: ${OUT_FILE} ($(wc -c < "${OUT_FILE}") bytes)"
