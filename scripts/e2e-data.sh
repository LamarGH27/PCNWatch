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

# Refuse to run against a server this script did not start.
#
# `next start` fails with EADDRINUSE when something already holds the port, but
# it fails into a background job nobody reads, and the suite then tests whatever
# that other process is serving. This has produced two separate false results:
# a suite that passed against a stale build, and later the same stale server
# failing a test for a regression that did not exist — the browser was asking
# for a stylesheet hash that build had never produced. Both cost far more to
# diagnose than this check costs to run.
#
# `ss` is not used to detect it: in some sandboxes it returns nothing at all,
# which reads as "port free" and is exactly how the orphan survived. An HTTP
# request cannot be wrong about whether something is answering.
if curl -sf --noproxy '*' -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null; then
  echo "✗ Something is already serving port ${PORT}." >&2
  echo "" >&2
  echo "  This script must own the server it tests, or the results describe" >&2
  echo "  someone else's build. Stop it and re-run:" >&2
  echo "" >&2
  echo "    ps -eo pid,args | grep '[n]ext-server'" >&2
  echo "    kill <pid>" >&2
  echo "" >&2
  echo "  Or run against a different port with E2E_DATA_PORT." >&2
  exit 2
fi

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
ready=""
for _ in $(seq 1 60); do
  # A server that died leaves the loop immediately rather than burning 60
  # seconds and then running the suite against nothing.
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "✗ The server exited before it was ready. Its output:" >&2
    cat /tmp/pcnwatch-e2e-data.log >&2
    exit 1
  fi
  if curl -sf --noproxy '*' "http://127.0.0.1:${PORT}/map" >/dev/null 2>&1; then
    ready="yes"
    break
  fi
  sleep 1
done

if [ -z "$ready" ]; then
  echo "✗ The app never became ready on port ${PORT}. Its output:" >&2
  cat /tmp/pcnwatch-e2e-data.log >&2
  exit 1
fi

E2E_BASE_URL="http://127.0.0.1:${PORT}" npx playwright test --config playwright.data.config.ts "$@"
