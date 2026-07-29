# syntax=docker/dockerfile:1.7

FROM oven/bun:1.2.20 AS bun

FROM node:24-trixie AS builder

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@10.11.0 --activate

WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY scripts ./scripts
COPY patches ./patches

RUN mkdir -p \
    packages/happy-app \
    packages/happy-server \
    packages/happy-cli \
    packages/happy-agent \
    packages/happy-wire \
    packages/happy-app-logs \
    packages/codium

COPY packages/happy-app/package.json packages/happy-app/
COPY packages/happy-server/package.json packages/happy-server/
COPY packages/happy-cli/package.json packages/happy-cli/
COPY packages/happy-agent/package.json packages/happy-agent/
COPY packages/happy-wire/package.json packages/happy-wire/
COPY packages/happy-app-logs/package.json packages/happy-app-logs/
COPY packages/codium/package.json packages/codium/

# Workspace lifecycle scripts require these paths during a frozen install.
COPY packages/happy-app/patches packages/happy-app/patches
COPY packages/happy-server/prisma packages/happy-server/prisma
COPY packages/happy-cli/scripts packages/happy-cli/scripts
COPY packages/happy-cli/tools packages/happy-cli/tools

RUN SKIP_HAPPY_WIRE_BUILD=1 pnpm install --frozen-lockfile

COPY packages/happy-wire packages/happy-wire
COPY packages/happy-server packages/happy-server

# A Server contract spec typechecks against these App-owned pure Zod schemas.
# They remain in the builder and are not copied into the relay runtime image.
COPY packages/happy-app/sources/sync/apiTypes.ts \
    packages/happy-app/sources/sync/profile.ts \
    packages/happy-app/sources/sync/friendTypes.ts \
    packages/happy-app/sources/sync/feedTypes.ts \
    packages/happy-app/sources/sync/

RUN pnpm --filter @slopus/happy-wire build \
    && pnpm --filter happy-server-self-host generate \
    && pnpm --filter happy-server-self-host build \
    && pnpm --filter happy-server-self-host deploy --prod --legacy /opt/happy-server \
    && test -f /opt/happy-server/dist/standalone.mjs \
    && test -d /opt/happy-server/prisma/migrations \
    && test ! -e /opt/happy-server/webapp/index.html

FROM node:24-trixie-slim AS runtime

ARG HAPPY_SERVER_VERSION=dev
ARG VCS_REF=unknown
ARG SOURCE_URL=https://github.com/slopus/happy

LABEL org.opencontainers.image.title="Happy Relay Server" \
      org.opencontainers.image.description="Happy encrypted relay server with embedded PGlite storage" \
      org.opencontainers.image.version="${HAPPY_SERVER_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data \
    && chown node:node /data

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PGLITE_DIR=/data/pglite \
    HOST=0.0.0.0 \
    PORT=3005 \
    METRICS_ENABLED=false \
    HAPPY_CODEX_SYNC_V4_ENABLED=false

WORKDIR /opt/happy-server

COPY --from=builder --chown=node:node /opt/happy-server/ ./
COPY --chmod=0755 packages/happy-server/deploy/debian13-amd64/entrypoint.sh /usr/local/bin/happy-relay-entrypoint

USER node

VOLUME ["/data"]
EXPOSE 3005

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=12 \
    CMD curl --fail --silent --show-error http://127.0.0.1:3005/health >/dev/null || exit 1

ENTRYPOINT ["happy-relay-entrypoint"]
