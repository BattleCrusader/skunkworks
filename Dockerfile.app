# Dockerfile.app — multi-stage; ends on node:22-bookworm-slim, non-root uid 10001 (§3).
#
# S4d: the image had never been built. `better-sqlite3` has no prebuild for this Node on
# linux/arm64, so `npm ci` compiles it, and `node:22-bookworm-slim` ships no toolchain —
# both stages failed at `npm ci` with gyp's "not ok". The build stage now installs
# python3/make/g++, and the runtime **copies** the pruned tree instead of re-running
# `npm ci`: a second compile in the shipping image would put a compiler in the container
# for no reason, and it was the second failure in the same build.
FROM node:22-bookworm-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json astro.config.mjs ./
COPY app ./app
COPY tools ./tools
COPY schema ./schema
COPY snippets ./snippets
# `tsconfig.json` includes `tools/`, and `tools/regen_conf.ts` imports the fixture
# helper — a build-stage-only copy: nothing under test/ reaches the runtime image.
COPY test ./test
RUN npm run build
# `--omit=dev` in the build stage, then copied: the runtime image gets no compiler and no
# second resolution of the lockfile.
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    UV_THREADPOOL_SIZE=8
WORKDIR /srv/app
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/dist ./dist
COPY --from=build /src/build ./build
COPY --from=build /src/schema ./schema
COPY --from=build /src/snippets ./snippets
USER 10001:10001
EXPOSE 3000
ENTRYPOINT ["node", "dist/app/main.js"]
