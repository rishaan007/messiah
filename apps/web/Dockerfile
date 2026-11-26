FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@12.21.0 --activate
WORKDIR /app

FROM base AS builder
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages/config/package.json packages/config/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @messiah/web...
COPY . .
ENV MESSIAH_NEXT_OUTPUT=standalone
RUN pnpm --filter @messiah/web... build

FROM node:24-alpine AS runner
RUN addgroup -S messiah && adduser -S messiah -G messiah
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=builder --chown=messiah:messiah /app/apps/web/.next/standalone ./
COPY --from=builder --chown=messiah:messiah /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=messiah:messiah /app/apps/web/public ./apps/web/public
USER messiah
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
