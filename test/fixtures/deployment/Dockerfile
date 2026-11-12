# Disposable acceptance image with controlled baseline/fixed behavior and no credentials.
FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
ARG SOURCE_COMMIT
ARG REMEDIATION_MODE
ENV SOURCE_COMMIT=$SOURCE_COMMIT REMEDIATION_MODE=$REMEDIATION_MODE
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT
WORKDIR /app
COPY test/fixtures/deployment/server.ts ./server.ts
USER node
EXPOSE 8088
HEALTHCHECK --interval=2s --timeout=2s --retries=15 CMD ["node", "-e", "fetch('http://127.0.0.1:8088/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.ts"]
