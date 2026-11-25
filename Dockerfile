# syntax=docker/dockerfile:1.7

FROM node:22.23.5-bookworm-slim AS dependencies

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
COPY public ./public
COPY scripts/ci/provider-showcase-check.ts ./scripts/ci/provider-showcase-check.ts
COPY scripts/ci/seo-build-check.ts ./scripts/ci/seo-build-check.ts
# E11.7-11: the partner kit's content and folder checks run before the build.
COPY scripts/ci/partner-kit-check.ts ./scripts/ci/partner-kit-check.ts
# E11.6-10: the price pages bundle the price data and the price-index
# package's two site-importable parts (ADR-033); scripts/ci/app-build.mjs
# lists the same inputs. E11.6-11 adds the Valstara prices.
COPY config/catalogue.json config/markets.json config/valstara-prices.json config/partner-code-blocklist.json ./config/
COPY data/price-index ./data/price-index
COPY packages/price-index/src/publish ./packages/price-index/src/publish
COPY packages/price-index/src/schema ./packages/price-index/src/schema
RUN npm run build

FROM dependencies AS production-dependencies

RUN npm prune --omit=dev && npm cache clean --force

FROM node:22.23.5-bookworm-slim AS runtime

WORKDIR /app
ENV ASTRO_TELEMETRY_DISABLED=1 \
    HOST=0.0.0.0 \
    NODE_ENV=production \
    PORT=4321

COPY --chown=node:node --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/src/server/config.ts ./src/server/config.ts
COPY --chown=node:node --from=build /app/src/server/db ./src/server/db
COPY --chown=node:node --from=build /app/src/server/email ./src/server/email
COPY --chown=node:node --from=build /app/src/server/subscriber ./src/server/subscriber
COPY --chown=node:node --from=build /app/src/server/giveaway ./src/server/giveaway
COPY --chown=node:node --from=build /app/src/server/flags ./src/server/flags
COPY --chown=node:node --from=build /app/src/server/audit ./src/server/audit
COPY --chown=node:node --from=build /app/src/server/referral ./src/server/referral
COPY --chown=node:node --from=build /app/src/server/fraud ./src/server/fraud
COPY --chown=node:node --from=build /app/src/server/ratelimit ./src/server/ratelimit
COPY --chown=node:node --from=build /app/src/server/verification ./src/server/verification
COPY --chown=node:node --from=build /app/src/server/verification-rate ./src/server/verification-rate
COPY --chown=node:node --from=build /app/src/server/analytics ./src/server/analytics
COPY --chown=node:node --from=build /app/src/server/dsr ./src/server/dsr
COPY --chown=node:node --from=build /app/src/server/leaderboard ./src/server/leaderboard
COPY --chown=node:node --from=build /app/src/server/partner ./src/server/partner
COPY --chown=node:node --from=build /app/src/copy ./src/copy
COPY --chown=node:node --from=build /app/src/styles/tokens.css ./src/styles/tokens.css
COPY --chown=node:node --from=build /app/src/content/giveaway-rules ./src/content/giveaway-rules
COPY --chown=node:node --from=build /app/src/content/giveaway-award-catalog.json ./src/content/giveaway-award-catalog.json
COPY --chown=node:node --from=build /app/src/content/partner-countries.json ./src/content/partner-countries.json
# E11.7-11: the welcome email, rendered by the maintenance worker, reads the kit.
COPY --chown=node:node --from=build /app/src/content/partner-kit.json ./src/content/partner-kit.json
COPY --chown=node:node --from=build /app/src/content/partner-message-templates.json ./src/content/partner-message-templates.json
# E11.7-13: the partner digest, rendered by the maintenance worker, reads the
# founder's note and the survey version its category counts use.
COPY --chown=node:node --from=build /app/src/content/partner-digest-note.json ./src/content/partner-digest-note.json
COPY --chown=node:node --from=build /app/src/server/survey/questions.ts ./src/server/survey/questions.ts
# E11.7-15 (D-074): the partner digest formats its rank line's snapshot time
# with the public leaderboard's formatter.
COPY --chown=node:node --from=build /app/src/islands/leaderboard.ts ./src/islands/leaderboard.ts
COPY --chown=node:node package.json ./package.json

USER node
EXPOSE 4321
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4321/').then(async (response) => { if (!response.ok) process.exit(1); await response.body?.cancel(); }).catch(() => process.exit(1))"]

CMD ["sh", "-c", "node ./src/server/config.ts && exec node ./dist/server/entry.mjs"]
