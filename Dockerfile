# One container for the whole stack (web, worker, watchdog, meme paper, demo simulation); see scripts/railway-start.mjs.
FROM node:24.22.1-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN node --version && npm run build
ENV NODE_ENV=production
CMD ["node", "scripts/railway-start.mjs"]
