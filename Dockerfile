ARG RUNTIME_IMAGE=ghcr.io/cheftaco/hive-node-runtime:26.13.0-1@sha256:48948514bce59a27f8ee2a3eabaea0a04cbfa87e087297a52f8501c0d465c84f
FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS base
RUN apt-get update && apt-get install --no-install-recommends -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*
FROM base AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
RUN npm ci --ignore-scripts
RUN npm run db:generate && npm run build && npm prune --omit=dev --ignore-scripts

FROM ${RUNTIME_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=1000:1000 /app /app
COPY --chown=1000:1000 healthcheck.mjs LICENSE NOTICE /app/
USER 1000:1000
EXPOSE 4180
ENTRYPOINT ["node", "services/runtime/dist/index.js"]
CMD ["api"]

FROM runtime AS scanner
ENTRYPOINT ["node", "packages/scanner/dist/cli.js"]
