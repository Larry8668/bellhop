# syntax=docker/dockerfile:1
# Multi-target image for the npm workspaces. Targets: provider, server, web.
# `npm run start` is tsx over TypeScript, so the runtime images keep source
# and the root devDependency tsx. shared (and provider) export compiled dist/.

FROM node:24-slim AS deps
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY provider/package.json provider/package.json
COPY server/package.json server/package.json
COPY web/package.json web/package.json
# Root `prepare` is `husky && npm run build`. Sources are not in the image
# yet, and there is no git checkout for husky. Drop prepare for this install
# only; dependency lifecycle scripts (better-sqlite3 compile) still run.
RUN npm pkg delete scripts.prepare && npm ci

FROM deps AS sources
COPY tsconfig.base.json ./
COPY shared shared
COPY provider provider
COPY server server
COPY web web
RUN npm run build -w shared \
    && npm run build -w provider \
    && npm run build -w web

FROM node:24-slim AS provider
WORKDIR /app
COPY --from=sources /app /app
ENV PORT=4010 \
    DB_PATH=/data/provider.db \
    PROVIDER_ADMIN=1
EXPOSE 4010
VOLUME ["/data"]
CMD ["npm", "run", "start", "-w", "provider"]

FROM node:24-slim AS server
WORKDIR /app
COPY --from=sources /app /app
ENV SERVER_PORT=4000 \
    DB_PATH=/data/bellhop.db \
    TRACES_DIR=/traces \
    PROVIDER_URL=http://provider:4010 \
    OLLAMA_BASE_URL=http://host.docker.internal:11434 \
    BETTER_AUTH_SECRET=dev-secret-change-me \
    BETTER_AUTH_URL=http://localhost:8080 \
    WEB_ORIGIN=http://localhost:8080
EXPOSE 4000
VOLUME ["/data", "/traces"]
# Boot already migrates; these scripts are the documented migrate + demo seed,
# and both are idempotent across restarts of the same volume.
CMD ["sh", "-c", "npm run db:migrate -w server && npm run seed:demo -w server && (npm run seed:demo-users -w server || echo personas skipped) && exec npm run start -w server"]

FROM nginx:1.27-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/proxy-bellhop.conf /etc/nginx/proxy-bellhop.conf
COPY --from=sources /app/web/dist /usr/share/nginx/html
EXPOSE 80
