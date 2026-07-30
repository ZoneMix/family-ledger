# ─── Builder stage ────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Need python + build tools for @actual-app/api native deps
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --ignore-scripts && \
    npm rebuild && \
    npm cache clean --force

# ─── Runtime stage ────────────────────────────────────────
FROM node:22-alpine

RUN apk add --no-cache tini wget

WORKDIR /app

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node server.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node public ./public

# Optional user config, hand-edited after setup (goals, category-mapped
# net worth, misc app config). None of these are required — the
# relevant panel just hides when a file is absent. The wildcard glob
# (`.jso[n]`) only matches when a real file exists, so the build never
# fails on a fresh checkout where these are still gitignored.
COPY --chown=node:node config.jso[n] ./
COPY --chown=node:node goals.jso[n] ./
COPY --chown=node:node networth.jso[n] ./

RUN mkdir -p /cache /state && chown -R node:node /cache /state

USER node

ENV NODE_ENV=production \
    PORT=3000 \
    ACTUAL_DATA_DIR=/cache \
    STATE_DIR=/state

EXPOSE 3000

HEALTHCHECK --interval=60s --timeout=10s --start-period=90s --retries=3 \
  CMD wget -q -O- http://localhost:3000/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
