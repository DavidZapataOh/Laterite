# The operator service's image, built from the repository root: `docker build -f services/operator/Dockerfile .`
FROM node:24.14.0-trixie-slim@sha256:8c8f12cedb96c3b59642cf30d713943c2b223990c9919b96a141681f62e6e292 AS build
WORKDIR /repo
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY clients/typescript/package.json clients/typescript/
COPY packages/db/package.json packages/db/
COPY packages/devnet/package.json packages/devnet/
COPY packages/i18n/package.json packages/i18n/
COPY services/operator/package.json services/operator/
RUN pnpm install --frozen-lockfile --filter @laterite/operator...
COPY clients/typescript clients/typescript
COPY packages/db packages/db
COPY packages/devnet packages/devnet
COPY packages/i18n packages/i18n
COPY services/operator services/operator
RUN pnpm --filter @laterite/operator build

FROM node:24.14.0-trixie-slim@sha256:8c8f12cedb96c3b59642cf30d713943c2b223990c9919b96a141681f62e6e292
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/services/operator/dist ./
USER node
CMD ["node", "--enable-source-maps", "main.js"]
