# Nereus API service + web UI in one image.
#   docker build -t nereus .
FROM node:24-bookworm-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
# The UI shares the search compiler with the server (../server/src/query).
COPY server/src /src/server/src
# The UI, then the browser SDK (dist/sdk/nereus-rum.js); type checks run in CI, not here.
RUN npx vite build && npx vite build -c vite.sdk.config.ts

FROM node:24-bookworm-slim
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server/src ./src
COPY server/migrations ./migrations
COPY --from=web /src/web/dist /app/web/dist
ENV WEB_DIST=/app/web/dist PORT=8090 NODE_ENV=production
EXPOSE 8090
USER node
CMD ["node", "src/server.ts"]
