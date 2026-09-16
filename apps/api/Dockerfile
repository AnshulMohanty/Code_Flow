# syntax=docker/dockerfile:1
# CodeFlow API — pnpm-workspace-aware multi-stage build.
# Build context is the REPO ROOT: `docker build -f apps/api/Dockerfile -t codeflow-api .`

# ── Build stage: install the whole workspace, build all @codeflow/* + the app ──
FROM node:20-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm -r build
# `pnpm deploy` produces a self-contained, prod-pruned folder with the internal @codeflow/*
# packages copied in (the pnpm-native way to ship one workspace app).
RUN pnpm --filter=@codeflow/api deploy --prod /prod

# ── Runtime stage: minimal, non-root, built output only ──
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# `git` is required at runtime: in embedded-worker mode (RUN_WORKER_IN_PROCESS=true, which is how
# render.free.yaml deploys this image) the BullMQ consumer runs IN THIS PROCESS and shallow-clones
# the repositories it analyses. The clone spawns the `git` binary directly (shell:false), so a
# missing binary is an ENOENT that fails Ingest before any parsing or provider call. Installed
# identically to apps/worker/Dockerfile so the two runtime images cannot drift.
RUN apt-get update && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --create-home --uid 1001 codeflow
COPY --from=build --chown=codeflow:codeflow /prod ./
USER codeflow
# API_PORT (default 4000) + MONGO_URI / REDIS_URL / provider keys are injected at RUN, never baked.
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
