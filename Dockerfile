# Build stage: typecheck + build the React client
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# packages/shared (@p2f/shared) is a `file:` dependency — npm needs the real
# directory present before `npm ci` can resolve/symlink it into node_modules.
COPY packages ./packages
RUN npm ci
COPY tsconfig.json tsconfig.client.json tsconfig.worker.json vite.config.ts ./
COPY src ./src
COPY client ./client
RUN npm run check && npm run build

# Runtime stage
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

# gosu: drop from root to the `node` user after the entrypoint fixes
# ownership of a bind-mounted /config (see docker-entrypoint.sh). The same
# well-established pattern the official postgres/mysql images use.
RUN apt-get update && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY --from=build /app/client/dist ./client/dist
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# /config holds the SQLite auth database (users, sessions, API tokens)
RUN mkdir /config && chown node:node /config

# Inside a container 0.0.0.0 is fine — restrict exposure at the compose level
# (host networking + VPN bind IP, or publish ports on the VPN IP only).
ENV P2F_ROOT=/data \
    P2F_HOST=0.0.0.0 \
    P2F_PORT=8000 \
    P2F_TRACKER_PORT=8001 \
    P2F_DB=/config/p2f.db

EXPOSE 8000 8001
VOLUME /config
# GET /api/health is unauthenticated and just confirms the HTTP server is up
# and answering — node's built-in fetch avoids adding curl/wget to the image.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.P2F_PORT||8000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Stays root here: the entrypoint fixes /config ownership, then execs the
# actual server as `node` — the app process itself never runs as root.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server/index.ts"]
