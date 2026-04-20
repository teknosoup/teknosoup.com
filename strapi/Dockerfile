FROM node:20-alpine AS base
WORKDIR /app

# ── Install dependencies ──────────────────────────────────────────────────────
FROM base AS deps
COPY package.json ./
COPY scripts ./scripts
RUN npm install

# ── Build ─────────────────────────────────────────────────────────────────────
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN NODE_OPTIONS="--max-old-space-size=2048" npm run build

# ── Production runner ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Copy built output and required files
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/build ./build
COPY --from=builder /app/public ./public
COPY --from=builder /app/src ./src
COPY --from=builder /app/config ./config
COPY --from=builder /app/database ./database
COPY --from=builder /app/package.json ./

# Uploads dir (mounted as volume in production)
RUN mkdir -p ./public/uploads

EXPOSE 1337

CMD ["npm", "run", "start"]
