# Build context is the repo ROOT (set by docker-compose.yml: context: ..).
# All paths below are relative to the repo root so we can pull in schema/
# and scripts/ that live outside web/.

# ─── Build stage: frontend ───────────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder
WORKDIR /app
COPY web/package.json web/package-lock.json* ./
COPY web/frontend/package.json frontend/
COPY web/backend/package.json backend/
RUN npm install --no-audit --no-fund
COPY web/frontend/ frontend/
RUN npm --workspace frontend run build

# ─── Build stage: backend ────────────────────────────────────────────────────
FROM node:20-alpine AS backend-builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY web/package.json web/package-lock.json* ./
COPY web/backend/package.json backend/
COPY web/frontend/package.json frontend/
RUN npm install --no-audit --no-fund
COPY web/backend/ backend/
RUN npm --workspace backend run build

# ─── Runtime ─────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache git tini ca-certificates \
    && addgroup -S app && adduser -S app -G app
ENV NODE_ENV=production
COPY web/package.json ./
COPY web/backend/package.json backend/
COPY web/frontend/package.json frontend/
RUN npm install --omit=dev --no-audit --no-fund --workspaces
COPY --from=backend-builder  /app/backend/dist  backend/dist
COPY --from=frontend-builder /app/frontend/dist frontend/dist
# Bundle schema + scripts from the registry repo so the backend can validate
# and inflate without depending on the cloned working copy being ready.
COPY schema  registry-bundled/schema
COPY scripts registry-bundled/scripts
RUN mkdir -p /data /run/secrets && chown -R app:app /data /app
USER app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null 2>&1 || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "backend/dist/server.js"]
