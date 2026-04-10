# Build stage
FROM node:22.14.0-slim AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY tsconfig.json esbuild.config.js ./
COPY src/ ./src/
RUN pnpm build

# Production stage
FROM node:22.14.0-slim
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod
COPY --from=builder /app/dist/main.cjs ./dist/main.cjs
HEALTHCHECK --interval=60s --timeout=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/v1/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "dist/main.cjs"]
