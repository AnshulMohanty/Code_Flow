# syntax=docker/dockerfile:1
# CodeFlow web — build the Vite SPA, serve as static files via nginx. The API base URL is
# injected at RUNTIME (not baked), so ONE image works across environments.
# Build context is the REPO ROOT: `docker build -f apps/web/Dockerfile -t codeflow-web .`

FROM node:20-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm -r build
# → apps/web/dist (static SPA, incl. the default public/config.js)

FROM nginx:1.27-alpine AS runtime
# SPA-fallback nginx config + the built assets.
COPY apps/web/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
# Runtime config injector: rewrites /config.js from $API_BASE_URL on container start. The
# official nginx image runs /docker-entrypoint.d/*.sh before starting nginx.
COPY apps/web/docker/40-codeflow-config.sh /docker-entrypoint.d/40-codeflow-config.sh
RUN chmod +x /docker-entrypoint.d/40-codeflow-config.sh
# API_BASE_URL is injected at RUN (e.g. -e API_BASE_URL=https://api.codeflow.example).
EXPOSE 80
# HEALTHCHECK against nginx's OWN /healthz, not against `/`. The SPA fallback returns index.html
# for any unmatched path, so probing `/` would report healthy even with the asset directory
# missing entirely. `wget` is busybox's, already in the alpine base -- no added layer.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3   CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
