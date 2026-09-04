#!/usr/bin/env bash
# Creates a local PCNWatch database ready for real ingestion.
#
#   scripts/db-setup.sh                    # creates database "pcnwatch"
#   PCNWATCH_DB=mydb scripts/db-setup.sh
#
# Requires PostgreSQL with PostGIS and a superuser-capable psql connection
# (PGHOST/PGPORT/PGUSER from your environment).
#
# Applies: the local Supabase shim, every migration in order, and the reference
# seed. Safe to re-run; it drops and recreates the database.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${PCNWATCH_DB:-pcnwatch}"
PSQL=(psql -v ON_ERROR_STOP=1 -q)

echo "→ recreating database ${DB}"
"${PSQL[@]}" -d postgres -c "drop database if exists ${DB} with (force)" >/dev/null
"${PSQL[@]}" -d postgres -c "create database ${DB}" >/dev/null

echo "→ applying Supabase shim (local only — a hosted Supabase project supplies this itself)"
"${PSQL[@]}" -d "${DB}" -f "${ROOT}/supabase/test/00_supabase_shim.sql" >/dev/null

echo "→ applying migrations"
for f in "${ROOT}"/supabase/migrations/*.sql; do
  echo "   $(basename "$f")"
  "${PSQL[@]}" -d "${DB}" -f "$f" >/dev/null
done

echo "→ seeding authorities, products and the Camden source"
"${PSQL[@]}" -d "${DB}" -f "${ROOT}/supabase/seed/001_reference.sql" >/dev/null

echo ""
echo "✓ Database ${DB} is ready."
echo ""
echo "  export DATABASE_URL=\"postgres://\${PGUSER:-\${USER:-postgres}}@\${PGHOST:-localhost}:\${PGPORT:-5432}/${DB}\""
echo ""
