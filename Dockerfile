# syntax=docker/dockerfile:1

###############################################################################
# AI Podcast Producer Assistant
#
# Built for a self-hosted single-operator deployment.
#
# Two decisions worth knowing about:
#
#  1. Debian slim, not Alpine. `better-sqlite3` is a native module and is
#     compiled from source here - a prebuilt binary was not available for this
#     Node version, so the build stage carries a toolchain. glibc keeps that
#     compile straightforward; musl would add its own problems on top. The
#     toolchain stays in the build stage only: the runtime image receives the
#     already-compiled `.node` binary and nothing else.
#
#  2. yt-dlp is baked in. It is the free transcript path, and from a residential
#     connection it is often all you need - the blocking that makes it unreliable
#     is specific to datacenter IPs. It ships as the self-contained binary so the
#     image needs no Python.
###############################################################################

FROM node:22-bookworm-slim AS deps
WORKDIR /app

# node-gyp needs these to compile better-sqlite3. Build stage only.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund


FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build


FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    DATABASE_PATH=/data/content-miner.db

# yt-dlp releases often, and a stale copy is the most common cause of caption
# extraction breaking. Pin it here so builds are reproducible, and rebuild (or
# run `yt-dlp -U` in the container) when extraction starts failing.
ARG YTDLP_VERSION=2025.10.14

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl sqlite3 \
 && curl -fsSL -o /usr/local/bin/yt-dlp \
      "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux" \
 && chmod +x /usr/local/bin/yt-dlp \
 && yt-dlp --version \
 && apt-get purge -y curl \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

# The full dependency tree is kept deliberately. `tsx` and the TypeScript
# toolchain are needed at runtime by the CLI scripts - `npm run pipeline` is how
# scheduled discovery runs - so pruning dev dependencies would break the cron
# workflow this deployment depends on.
# Ownership is set during COPY rather than with a later `chown -R`. A recursive
# chown rewrites every file it touches into a new layer, which duplicated the
# entire 650 MB node_modules and doubled the image.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --chown=node:node package.json next.config.ts tsconfig.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts

# The database lives on a mounted volume, never in an image layer. It holds the
# clip library and the editor feedback dataset - the asset worth backing up.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]
