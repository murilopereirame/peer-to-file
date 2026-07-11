# Build stage: typecheck + compile the browser client
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.client.json ./
COPY src ./src
COPY public ./public
RUN npm run check && npm run build

# Runtime stage
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY --from=build /app/public ./public

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
USER node
VOLUME /config
CMD ["node", "src/server/index.ts"]
