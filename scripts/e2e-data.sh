#!/usr/bin/env bash
# Browser tests for behaviour that needs real data behind it.
#
#   npm run test:e2e:data
#
# The main Playwright suite runs against a build with no credentials, on
# purpose: it proves what an unconfigured deployment says. The map hides itself
# there, so anything that interacts with the map cannot be tested by it.
#
# This starts the app against a migrated database holding Camden locations and
# runs the map-search suite against it.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${E2E_DATA_PORT:-3211}"

if [ -z "${PCNWATCH_E2E_DATABASE_URL:-}" ]; then
  echo "✗ PCNWATCH_E2E_DATABASE_URL is not set." >&2
  echo "" >&2
  echo "  It must point at a migrated PostGIS database containing Camden" >&2
  echo "  locations with geometry — the map has nothing to search otherwise." >&2
  echo "" >&2
  echo "  These tests are not skipped when it is missing: a browser suite that" >&2
  echo "  quietly passes without a browser proves nothing." >&2
  exit 2
fi

cd "$ROOT"
# Always rebuilt. Reusing whatever `.next` happens to be lying around means
# testing code that is not the code in the working tree, and the suite passes
# or fails for reasons unrelated to the change being made.
npm run build >/dev/null

DATABASE_URL="$PCNWATCH_E2E_DATABASE_URL" \
NEXT_PUBLIC_MAP_STYLE_URL="${NEXT_PUBLIC_MAP_STYLE_URL:-https://tiles.openfreemap.org/styles/liberty}" \
  npx next start --port "$PORT" > /tmp/pcnwatch-e2e-data.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

echo "→ waiting for the app on port ${PORT}"
for _ in $(seq 1 60); do
  if curl -sf --noproxy '*' "http://127.0.0.1:${PORT}/map" >/dev/null 2>&1; then break; fi
  sleep 1
done

E2E_BASE_URL="http://127.0.0.1:${PORT}" npx playwright test --config playwright.data.config.ts "$@"
