# syntax=docker/dockerfile:1
#
# faceslop in one container: the TanStack Start server (Node) and the headless Chromium it drives.
#
#   docker compose up --build -d      (see compose.yaml: publishes the port on 127.0.0.1 only)
#
# Also what Dokploy builds (Build Type "Dockerfile"; see README.md, "Deploy on Dokploy"): set
# APP_PASSWORD, FACESLOP_PUBLIC_URL and FACESLOP_TRUST_PROXY=1 there, route the domain to
# container port 3000, mount a named volume at /app/.data, and set the Swarm Update/Rollback
# Config Order to "Stop First": one faceslop process per data volume (it keeps browser sessions in
# memory and owns the SQLite database and fb-sessions/), never an old and a new one side by side.
#
# Stages: deps (npm ci) -> build (vite build -> .output) -> runtime (Node + Playwright's Chromium
# and its system libraries + tini + .output). The runtime image has no source, no node_modules
# beyond the few packages Nitro traced into .output/server/node_modules, and runs as the
# unprivileged "node" user.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------- deps: install exactly what package-lock.json pins ----------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# ---------- build: the production server bundle (.output) ----------
FROM deps AS build
COPY . .
RUN npm run build

# ---------- runtime ----------
FROM ${NODE_IMAGE} AS runtime

# The server binds every interface inside the container; compose publishes it on the host's
# loopback only. FACESLOP_DOCKER=1 is what allows that bind without APP_PASSWORD (the Host-header
# loopback check still applies; with FACESLOP_PUBLIC_URL set, APP_PASSWORD is required anyway).
# Only Playwright's full Chromium is installed, so ask for it.
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HOST=0.0.0.0 \
    PORT=3000 \
    FACESLOP_DOCKER=1 \
    FACESLOP_DATA_DIR=/app/.data \
    FACESLOP_CHROME_CHANNEL=chromium

# tini (PID 1: forwards SIGTERM to Node, which closes Chrome and SQLite, and reaps Chromium's
# orphaned child processes; platforms like Dokploy don't add an init process of their own), then
# Chromium and the system libraries/fonts it needs, installed with the exact playwright-core
# version the app was built against (bind-mounted from the deps stage, so it leaves no layer).
# This layer only changes when package-lock.json does.
RUN --mount=type=bind,from=deps,source=/app/node_modules/playwright-core,target=/tmp/playwright-core \
    apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && node /tmp/playwright-core/cli.js install --with-deps --no-shell chromium \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

WORKDIR /app
# The data dir (SQLite database; fb-sessions/, one Facebook cookie file per account) belongs to
# the runtime user, mode 0700. A named volume mounted here starts out with this ownership and mode
# (a bind mount would not: use a named volume).
RUN mkdir -p /app/.data && chown node:node /app/.data && chmod 0700 /app/.data

COPY --from=build /app/.output /app/.output

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# -s: also reap zombies when something else is PID 1 (e.g. `docker run --init`).
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["node", ".output/server/index.mjs"]
