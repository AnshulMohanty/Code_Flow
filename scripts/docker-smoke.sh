#!/usr/bin/env bash
# DOCKER SMOKE — the shipped stack, end to end: build, boot, analyse a real public repo, assert.
#
# `docker build` succeeding proved the images exist; it did not prove the worker CONSUMES a job.
# The worker once exited 0 on boot inside its image (an entrypoint guard keyed on a path shape the
# image does not have), so every job sat in "queued" forever while CI was green. This runs the job.
#
# No real key is used: the AI stages fail on a placeholder and the run must end "partial" with the
# deterministic analysis intact — which is itself the degradation contract under test.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="$(mktemp)"
echo "GEMINI_API_KEY=ci-placeholder-not-a-real-key" > "$ENV_FILE"
DC=(docker compose --env-file "$ENV_FILE" -f docker-compose.app.yml)
REPO_URL="${SMOKE_REPO_URL:-https://github.com/jamiebuilds/the-super-tiny-compiler}"

cleanup() {
  status=$?
  if [ $status -ne 0 ]; then
    echo "── smoke failed; service logs ──"
    "${DC[@]}" logs --tail 80 worker api || true
  fi
  "${DC[@]}" down -v > /dev/null 2>&1 || true
  rm -f "$ENV_FILE"
  exit $status
}
trap cleanup EXIT

"${DC[@]}" up -d --build --wait --wait-timeout 300

job=$(curl -fsS -X POST localhost:4000/api/analyze -H 'content-type: application/json' \
  -d "{\"mode\":\"public_hosted\",\"repoUrl\":\"$REPO_URL\"}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).jobId))')
echo "job $job queued for $REPO_URL"

for _ in $(seq 1 90); do
  status=$(curl -fsS "localhost:4000/api/job/$job" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).status))')
  case "$status" in completed|failed) break ;; esac
  sleep 2
done
echo "job status: $status"
[ "$status" = "completed" ] || { echo "job did not complete (status: $status)"; exit 1; }

curl -fsS "localhost:4000/api/result/$job" | node -e '
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const body = JSON.parse(s); const r = body.result ?? body;
  const stages = Object.fromEntries((r.pipeline?.stages ?? []).map((st) => [st.stage ?? st.id, st.status]));
  const checks = {
    "graph has nodes": (r.graph?.nodes?.length ?? 0) > 0,
    "deterministic stages completed": ["ingest", "orient", "map-structure", "inventory", "connect", "analyze"].every((id) => stages[id] === "completed"),
    "entry points derived": Array.isArray(r.entryPoints),
    "no unresolved imports": (r.graph?.resolution?.unresolved ?? 1) === 0,
  };
  console.log(JSON.stringify({ stages, checks }, null, 2));
  if (!Object.values(checks).every(Boolean)) process.exit(1);
});'
echo "docker smoke: OK"
