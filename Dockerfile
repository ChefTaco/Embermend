ARG RUNTIME_IMAGE=ghcr.io/cheftaco/hive-node-runtime:26.13.1-1@sha256:7671ab0a702c273c37a84d089ba6fe821c6d85cbeab888e7e43522a057da5e6d
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS base
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
