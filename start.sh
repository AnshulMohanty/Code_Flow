#!/usr/bin/env bash
# CodeFlow one-command launcher (macOS/Linux). Requires Docker Desktop running.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f codeflow.env ]; then
  echo "First run: create codeflow.env with your Gemini key, e.g."
  echo "    echo 'GEMINI_API_KEY=your-key-here' > codeflow.env"
  echo "(Get a free key at https://aistudio.google.com/apikey)"
  exit 1
fi

echo "Building + starting CodeFlow (first build takes a few minutes)…"
docker compose --env-file codeflow.env -f docker-compose.app.yml up -d --build

echo ""
echo "CodeFlow is starting → open http://localhost:5173"
echo "Logs:  docker compose -f docker-compose.app.yml logs -f"
echo "Stop:  docker compose -f docker-compose.app.yml down   (add -v to also wipe the database)"
