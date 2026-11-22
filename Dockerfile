# Multi-stage build for a minimal, production-grade image
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependency definitions
COPY package*.json tsconfig.json ./

# Install dependencies (including devDependencies for TypeScript build)
RUN npm ci

# Copy source code
COPY src/ ./src/
COPY bin/ ./bin/

# Build TypeScript to dist/
RUN npm run build

# Prune development dependencies
RUN npm prune --production

# -------------------------------------------------------------
# Runtime stage
# -------------------------------------------------------------
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

# Copy built artifacts and production node_modules
COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/bin ./bin

# Ensure binary is executable
RUN chmod +x bin/fixmcp.js

# Default entrypoint runs the MCP stdio server (pass CLI flags like `--help` or `--json` to run as CLI)
ENTRYPOINT ["node", "bin/fixmcp.js"]
CMD ["serve"]
