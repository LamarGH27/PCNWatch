#!/usr/bin/env bash
# Applies every migration to a scratch database and runs the SQL test suites.
#
# Usage:
#   scripts/db-test.sh                      # uses PGHOST/PGPORT/PGUSER from the env
#   PGPORT=5433 scripts/db-test.sh
#
# Requires PostgreSQL with PostGIS. The Supabase shim in supabase/test provides the
# auth/storage schemas the platform would otherwise supply.

set -euo pipefail

# The SQL suites use psql meta-commands (\set, \echo), so unlike db:setup they
# genuinely need the client. Say so rather than dying on "command not found".
if ! command -v psql >/dev/null 2>&1; then
  echo "✗ psql is not installed, and the SQL test suites need it." >&2
  echo "" >&2
  echo "  Debian/Ubuntu:  sudo apt-get install -y postgresql-client" >&2
  echo "  macOS:          brew install libpq && brew link --force libpq" >&2
  echo "" >&2
  echo "  \`npm run db:setup\` does not need psql — only these tests do." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${PCNWATCH_TEST_DB:-pcnwatch_test}"
PSQL=(psql -v ON_ERROR_STOP=1 -q)

echo "→ recreating database ${DB}"
"${PSQL[@]}" -d postgres -c "drop database if exists ${DB} with (force)" >/dev/null
"${PSQL[@]}" -d postgres -c "create database ${DB}" >/dev/null

echo "→ applying Supabase shim (local only)"
"${PSQL[@]}" -d "${DB}" -f "${ROOT}/supabase/test/00_supabase_shim.sql" >/dev/null

echo "→ applying migrations"
for f in "${ROOT}"/supabase/migrations/*.sql; do
  echo "   $(basename "$f")"
  "${PSQL[@]}" -d "${DB}" -f "$f" >/dev/null
done

echo "→ running SQL test suites"
for f in "${ROOT}"/supabase/test/*.test.sql; do
  echo "   $(basename "$f")"
  "${PSQL[@]}" -d "${DB}" -f "$f"
done

# The ingestion pipeline is TypeScript, so the guarantees that only appear when
# it runs end to end — a failed run recorded as FAILED, a successful one
# published atomically, nothing written to pcn_events — are checked here rather
# than in SQL. They need the same freshly migrated database.
echo "→ running database integration tests"
# psql and node-postgres disagree on the default host: libpq falls back to a
# unix socket, node-postgres to localhost over TCP. Ask the server where its
# socket is so the integration tests connect the same way the suites above did.
if [ -z "${PGHOST:-}" ]; then
  PGHOST="$("${PSQL[@]}" -d postgres -tAc 'show unix_socket_directories' | cut -d, -f1 | tr -d '[:space:]')"
fi

PCNWATCH_TEST_DATABASE_URL="${PCNWATCH_TEST_DATABASE_URL:-$(
  PGHOST="${PGHOST}" node -e '
    const user = process.env.PGUSER || process.env.USER || "postgres";
    const host = process.env.PGHOST || "localhost";
    const port = process.env.PGPORT || "5432";
    const db = process.env.PCNWATCH_TEST_DB || "pcnwatch_test";
    const auth = process.env.PGPASSWORD ? `${user}:${encodeURIComponent(process.env.PGPASSWORD)}` : user;
    // A socket directory cannot go in the authority section of a URL.
    console.log(host.startsWith("/")
      ? `postgres://${auth}@/${db}?host=${encodeURIComponent(host)}`
      : `postgres://${auth}@${host}:${port}/${db}`);
  '
)}" npm run --silent test:db

echo "✓ database tests passed"
