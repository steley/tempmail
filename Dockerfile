FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY public ./public
COPY src ./src

# unprivileged where possible; port 25 still requires root or CAP_NET_BIND_SERVICE
EXPOSE 25 3000
CMD ["node", "src/server.js"]
