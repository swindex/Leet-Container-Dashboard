FROM oven/bun:1-alpine AS base
WORKDIR /app

RUN apk add --no-cache docker-cli

COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile

COPY src ./src
COPY data ./data

ENV NODE_ENV=production
EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
