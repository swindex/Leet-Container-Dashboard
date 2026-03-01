FROM oven/bun:1-alpine AS base
WORKDIR /app

# Install docker CLI for container management
RUN apk add --no-cache docker-cli

# Copy package files and install production dependencies
COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile

# Copy scripts and run copy-vendor to prepare frontend assets
COPY scripts ./scripts
RUN bun run copy-vendor

# Copy source code
COPY src ./src

# Copy starter data files to seed directory
COPY data-seed/dashboardSettings.json ./data-seed/
COPY data-seed/remoteServers.json ./data-seed/
COPY data-seed/users.json ./data-seed/
COPY data-seed/uploads ./data-seed/uploads

# Set environment
ENV NODE_ENV=production
EXPOSE 3000


# Run the application
CMD ["bun", "run", "src/index.ts"]
