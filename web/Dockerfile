# syntax=docker/dockerfile:1.7
# Build context is the repo ROOT (set by docker-compose.yml: context: ..).
# All paths below are relative to the repo root so we can pull in schema/
# and scripts/ that live outside web/.
#
# Tuned for Unraid 7.1.4 (Docker 28.x with BuildKit). BuildKit cache mounts
# keep the npm cache + apk cache between rebuilds so "Update Stack" is fast.

ARG NODE_IMAGE=node:20.18-alpine

# ─── Build stage: frontend ───────────────────────────────────────────────────
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS frontend-builder
WORKDIR /app
COPY web/package.json web/package-lock.json* ./
COPY web/frontend/package.json frontend/
COPY web/backend/package.json backend/
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY web/frontend/ frontend/
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm --workspace frontend run build

# ─── Build stage: backend ────────────────────────────────────────────────────
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS backend-builder
WORKDIR /app
RUN --mount=type=cache,target=/var/cache/apk,sharing=locked \
    apk add --no-cache python3 make g++
COPY web/package.json web/package-lock.json* ./
COPY web/backend/package.json backend/
COPY web/frontend/package.json frontend/
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY web/backend/ backend/
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm --workspace backend run build

# ─── Runtime ─────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
RUN --mount=type=cache,target=/var/cache/apk,sharing=locked \
    apk add --no-cache git tini ca-certificates wget \
    && addgroup -S app && adduser -S app -G app
ENV NODE_ENV=production
COPY web/package.json ./
COPY web/backend/package.json backend/
COPY web/frontend/package.json frontend/
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    (npm ci --omit=dev --no-audit --no-fund --workspaces \
     || npm install --omit=dev --no-audit --no-fund --workspaces)
COPY --from=backend-builder  /app/backend/dist  backend/dist
COPY --from=frontend-builder /app/frontend/dist frontend/dist
# Bundle schema + scripts from the registry repo so the backend can validate
# and inflate without depending on the cloned working copy being ready.
COPY schema  registry-bundled/schema
COPY scripts registry-bundled/scripts
RUN mkdir -p /data /run/secrets && chown -R app:app /data /app

# OCI labels — surfaced by Unraid's Docker tab.
LABEL org.opencontainers.image.title="BeamNG Mod Registry Web" \
      org.opencontainers.image.source="https://github.com/musanajam11/BeamNG-Mod-Registry" \
      org.opencontainers.image.licenses="MIT"

USER app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null 2>&1 || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "backend/dist/server.js"]
