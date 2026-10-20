# Dockerfile.app — multi-stage; ends on node:22-bookworm-slim, non-root uid 10001 (§3).
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json astro.config.mjs ./
COPY app ./app
COPY tools ./tools
COPY schema ./schema
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    UV_THREADPOOL_SIZE=8
WORKDIR /srv/app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /src/dist ./dist
COPY --from=build /src/build ./build
COPY --from=build /src/schema ./schema
USER 10001:10001
EXPOSE 3000
ENTRYPOINT ["node", "dist/app/main.js"]
