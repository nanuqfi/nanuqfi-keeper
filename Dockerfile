# Build stage
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY tsconfig.json esbuild.config.js ./
COPY src/ ./src/
RUN pnpm build

# Production stage
FROM node:22-slim
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod
COPY --from=builder /app/dist/main.cjs ./dist/main.cjs
CMD ["node", "dist/main.cjs"]
