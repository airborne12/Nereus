# DorisStack API service + web UI in one image.
#   docker build -t dorisstack .
FROM node:24-bookworm-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npx vite build

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
