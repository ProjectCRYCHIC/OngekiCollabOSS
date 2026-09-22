# OngekiCollab self-hosted image: builds the web board and the compiled
# self-hosted server, then ships them with production dependencies only.
# Start order (migration, then server) is protected against concurrent
# container starts by the GET_LOCK in scripts/migrate-mysql.mjs.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps
COPY frontend/ frontend/
COPY scripts/ scripts/
RUN npm run build:web
COPY src/ src/
COPY tsconfig.selfhost.json ./
RUN npx tsc -p tsconfig.selfhost.json

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps --omit=dev
COPY --from=build /app/web/ web/
COPY --from=build /app/dist-selfhost/ dist-selfhost/
COPY migrations/ migrations/
COPY scripts/migrate-selfhost.mjs scripts/migrate-mysql.mjs scripts/migrate-sqlite.mjs scripts/admin-reset-password.mjs scripts/
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8787}/api/v1/health" >/dev/null 2>&1 || exit 1
CMD ["sh", "-c", "node scripts/migrate-selfhost.mjs && node dist-selfhost/runtimes/selfhost/server.js"]
