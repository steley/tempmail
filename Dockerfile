FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY scripts ./scripts
COPY public ./public
COPY src ./src

# content-fingerprint the ?v= stamps so immutable CDN caching stays correct
# (zero-dependency script; server host needs no node)
RUN node scripts/hash-assets.mjs

# unprivileged where possible; port 25 still requires root or CAP_NET_BIND_SERVICE
EXPOSE 25 3000
CMD ["node", "src/server.js"]
