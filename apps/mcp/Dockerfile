# syntax=docker/dockerfile:1
# CodeFlow MCP server — pnpm-workspace-aware multi-stage build.
# Build context is the REPO ROOT: `docker build -f apps/mcp/Dockerfile -t codeflow-mcp .`
#
# NOTE ON WHY THERE IS NO HEALTHCHECK HERE, unlike the api and worker images. An MCP stdio server
# has no port and no loop of its own: it reads a client's requests from stdin and writes to stdout,
# and it exits when the client closes the pipe. A HEALTHCHECK would have nothing to probe, and a
# failing one would restart a server whose client had simply gone away. Liveness for a stdio server
# IS the pipe.
#
# It also means this image is normally run by a CLIENT (`docker run -i`), not by an orchestrator —
# see GO_LIVE.md for the Cursor / Claude Code / Windsurf configuration.

# ── Build stage: install the whole workspace, build all @codeflow/* + the app ──
FROM node:20-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm -r build
RUN pnpm --filter=@codeflow/mcp deploy --prod /prod

# ── Runtime stage: minimal, non-root, built output only ──
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN useradd --system --create-home --uid 1001 codeflow
COPY --from=build --chown=codeflow:codeflow /prod ./
USER codeflow
# CODEFLOW_MCP_SCOPES is DEFAULT-DENY: with nothing set, every tool is hidden and the server starts
# but exposes no surface. That is deliberate — see apps/mcp/src/scope.ts.
# CODEFLOW_MCP_RESULT (a saved AnalysisResult path, usually a mounted volume) or
# CODEFLOW_MCP_API + CODEFLOW_MCP_JOB tell it which analysis to operate on.
CMD ["node", "dist/index.js"]
