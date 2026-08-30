# syntax=docker/dockerfile:1
# CodeFlow worker — the BullMQ analysis worker. No exposed port (it pulls jobs off Redis).
# Build context is the REPO ROOT: `docker build -f apps/worker/Dockerfile -t codeflow-worker .`

FROM node:20-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm -r build
RUN pnpm --filter=@codeflow/worker deploy --prod /prod

FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# `git` is required at runtime: the worker shallow-clones public repos to analyze them.
RUN apt-get update && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --create-home --uid 1001 codeflow
COPY --from=build --chown=codeflow:codeflow /prod ./
USER codeflow
# MONGO_URI / REDIS_URL / provider keys (LLM_PROVIDER, EMBEDDING_PROVIDER, *_API_KEY) injected at RUN.

# The worker has no product HTTP surface -- it pulls jobs off Redis -- which is why it had no
# HEALTHCHECK. It now runs a small liveness/readiness/metrics server, and the IMAGE opts in by
# setting the port: a HEALTHCHECK against a disabled endpoint would mark every container unhealthy.
# See apps/worker/src/health/healthServer.ts for why `pgrep node` was not good enough (a worker
# wedged on a dead Redis connection is a live process with zero capacity).
ENV WORKER_HEALTH_PORT=4100
EXPOSE 4100

# LIVENESS, not readiness. /health stays 200 while the process is cold, because restarting a cold
# worker only restarts the cold start; /ready is the one that gates capacity, and an orchestrator
# should point its readiness probe there.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3   CMD node -e "fetch('http://127.0.0.1:'+(process.env.WORKER_HEALTH_PORT||4100)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# WORKER_CONCURRENCY (default 2, ceiling 8) tunes jobs per instance; scale OUT past that.
# terminationGracePeriodSeconds must be >= 300 -- an analysis job that is SIGKILLed mid-run is
# re-delivered by BullMQ and re-does all of its work, including any provider spend.
CMD ["node", "dist/index.js"]
