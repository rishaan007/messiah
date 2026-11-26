FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@12.21.0 --activate
WORKDIR /app

FROM base AS builder
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages/config/package.json packages/config/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/providers/package.json packages/providers/
COPY packages/mcp/package.json packages/mcp/
COPY packages/agents/package.json packages/agents/
COPY packages/memory/package.json packages/memory/
COPY packages/workflows/package.json packages/workflows/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter @messiah/worker...
COPY . .
RUN pnpm --filter @messiah/db exec prisma generate && pnpm --filter @messiah/worker... build

FROM node:24-alpine AS runner
RUN addgroup -S messiah && adduser -S messiah -G messiah
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app .
USER messiah
CMD ["node", "apps/worker/dist/index.js"]
