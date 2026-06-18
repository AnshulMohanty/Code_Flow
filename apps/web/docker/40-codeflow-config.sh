#!/bin/sh
# Runtime API-URL injection. Rewrites /config.js from $API_BASE_URL at container start so the
# SAME built image works across environments (the URL is NOT baked at build time). Runs via the
# nginx image's /docker-entrypoint.d/ hook before nginx starts.
set -eu

API_BASE_URL="${API_BASE_URL:-}"
cat > /usr/share/nginx/html/config.js <<EOF
window.__CODEFLOW_CONFIG__ = { apiBaseUrl: "${API_BASE_URL}" };
EOF
echo "codeflow: wrote /config.js (apiBaseUrl='${API_BASE_URL}')"
