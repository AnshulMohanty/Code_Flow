#!/usr/bin/env bash
# LOAD TEST — build and boot the shipped stack, then run scripts/load-test.mjs with 1, 2 and 4 worker
# replicas. Each run gets its own ANALYZER_VERSION (a fresh result-cache namespace), so every job is
# a real clone + analysis. No real key is needed: with the placeholder the AI stages fail fast and
# the deterministic pipeline is what is measured. Results: $LOADTEST_OUT/workers-N.json.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="$(mktemp)"
echo "GEMINI_API_KEY=${GEMINI_API_KEY:-loadtest-placeholder-not-a-real-key}" > "$ENV_FILE"
DC=(docker compose --env-file "$ENV_FILE" -f docker-compose.app.yml -f docker-compose.loadtest.yml)
OUT="${LOADTEST_OUT:-loadtest-results}"
mkdir -p "$OUT"
trap '"${DC[@]}" down -v > /dev/null 2>&1 || true; rm -f "$ENV_FILE"' EXIT

"${DC[@]}" build
for workers in ${WORKER_COUNTS:-1 2 4}; do
  export ANALYZER_VERSION="loadtest-$(date +%s)-w${workers}"
  "${DC[@]}" up -d --wait --wait-timeout 300 --scale "worker=${workers}"
  node scripts/load-test.mjs --label "workers=${workers}" --users "${LOADTEST_USERS:-20}" --out "$OUT/workers-${workers}.json"
done
