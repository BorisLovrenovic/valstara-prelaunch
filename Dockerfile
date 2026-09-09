# syntax=docker/dockerfile:1.7

FROM node:22.22.3-bookworm-slim AS dependencies

WORKDIR /app
ENV ASTRO_TELEMETRY_DISABLED=1 \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_MAXSOCKETS=4

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM dependencies AS build

COPY astro.config.mjs tsconfig.json ./
COPY src ./src
RUN npm run build

FROM dependencies AS production-dependencies

RUN npm prune --omit=dev && npm cache clean --force

FROM node:22.22.3-bookworm-slim AS runtime

WORKDIR /app
ENV ASTRO_TELEMETRY_DISABLED=1 \
    HOST=0.0.0.0 \
    NODE_ENV=production \
    PORT=4321

COPY --chown=node:node --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/src/server/config.ts ./src/server/config.ts
COPY --chown=node:node --from=build /app/src/server/db ./src/server/db
COPY --chown=node:node --from=build /app/src/server/subscriber ./src/server/subscriber
COPY --chown=node:node package.json ./package.json

USER node
EXPOSE 4321
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4321/').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"]

CMD ["sh", "-c", "node ./src/server/config.ts && exec node ./dist/server/entry.mjs"]
