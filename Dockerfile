# syntax=docker/dockerfile:1
# Production image for self-hosting (see docs/self-hosting.md). Vercel does not use this file.
#
#   docker build -t webhook-relay:dev .                       # app (runner, default target)
#   docker build -t webhook-relay-migrate:dev --target migrator .   # one-shot migration job
ARG NODE_IMAGE=node:22-alpine

# ---- deps: full install (dev deps are needed by `next build`) ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# npm install instead of npm ci: the lockfile is generated on Windows and lacks the
# Linux/musl optional native packages (same reason as in .github/workflows/ci.yml).
RUN --mount=type=cache,target=/root/.npm npm install --no-audit --no-fund

# ---- build: standalone output (server.js + traced node_modules) ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT=standalone
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Optional. Server code reads NEXT_PUBLIC_APP_URL at runtime, so one image serves any domain;
# the build value only lands in the statically prerendered pages (Open Graph URLs on "/").
# Left empty it must stay *unset*: an empty string would be inlined and shadow the runtime value.
ARG NEXT_PUBLIC_APP_URL=
RUN if [ -z "$NEXT_PUBLIC_APP_URL" ]; then unset NEXT_PUBLIC_APP_URL; fi && npm run build

# ---- migrator: drizzle migrations only (drizzle-orm + pg, same versions as the app) ----
FROM ${NODE_IMAGE} AS migrator
WORKDIR /migrate
COPY package-lock.json /tmp/package-lock.json
RUN --mount=type=cache,target=/root/.npm \
    DRIZZLE=$(node -p "require('/tmp/package-lock.json').packages['node_modules/drizzle-orm'].version") && \
    PG=$(node -p "require('/tmp/package-lock.json').packages['node_modules/pg'].version") && \
    npm init -y >/dev/null && \
    npm install --no-audit --no-fund --omit=dev "drizzle-orm@${DRIZZLE}" "pg@${PG}" && \
    rm /tmp/package-lock.json
COPY drizzle ./drizzle
COPY deploy/migrate/migrate.mjs ./migrate.mjs
USER node
CMD ["node", "migrate.mjs"]

# ---- runner: the app ----
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    APP_VERSION=${APP_VERSION}
# Code is owned by root and read-only for the app user; only the Next cache dir is writable.
COPY --from=build /app/public ./public
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
RUN mkdir -p .next/cache && chown node:node .next/cache
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>r.json().then(b=>process.exit(r.ok&&b.ok?0:1))).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
