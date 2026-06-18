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
CMD ["node", "dist/index.js"]
