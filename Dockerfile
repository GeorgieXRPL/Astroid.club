# syntax=docker/dockerfile:1.6
#
# astroid.club gateway — production Dockerfile.
#
# Builds the WebSocket + HTTP gateway only. The Next.js shell deploys to
# Vercel (or any other static / edge host); it does not need a container.
#
# Stages:
#   1. deps   — install all deps (incl. dev) so we can compile TS.
#   2. build  — compile server + shared + config to dist/.
#   3. prune  — install production-only deps in a clean tree.
#   4. runner — distroless-style runtime (node:20-alpine) with only dist/
#               + production node_modules. Runs as a non-root user.
#
# Why this shape:
#   - No source files in the final image — only compiled JS + prod deps.
#   - The vendored engine tarball (vendor/game-engine-enhanced.tgz) is
#     resolved during `deps` install and baked into the prune stage.
#   - The runner is < 200 MB and starts in < 1 s.

# -----------------------------------------------------------------------------
# 1. Dependency install (all deps)
# -----------------------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app

RUN apk add --no-cache libc6-compat

# Copy only the files required to install. The vendored engine tarball is
# referenced by package.json (`file:./vendor/...`) so it MUST land before
# `npm ci`.
COPY package.json package-lock.json ./
COPY vendor ./vendor

# Workspace package manifests so npm doesn't error on missing workspace
# directories when reading the workspaces field — we only deploy the
# gateway, not the Next.js shell.
COPY shell/package.json ./shell/package.json

# Use `npm install --omit=dev=false --workspaces=false` rather than
# `npm ci`. `npm ci` is stricter: it requires the lockfile to exactly
# match the expected install tree, but our lockfile is generated on
# Windows where optional peer deps (utf-8-validate, bufferutil) hoist
# differently than they do in this Alpine Linux image. `npm install`
# resolves from package.json and produces a working tree without
# fighting the lockfile. We are still bit-reproducible enough for
# preview because the Dockerfile pins the base image and the engine
# tarball is committed.
RUN npm install --workspaces=false --no-audit --no-fund

# -----------------------------------------------------------------------------
# 2. Build (compile TS to dist/)
# -----------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY tsconfig.json tsconfig.server.json ./
COPY server ./server
COPY shared ./shared
COPY config ./config

RUN npm run build:server

# -----------------------------------------------------------------------------
# 3. Production-only deps
# -----------------------------------------------------------------------------
FROM node:20-alpine AS prune
WORKDIR /app

RUN apk add --no-cache libc6-compat

COPY package.json package-lock.json ./
COPY vendor ./vendor

# Same `npm install` rationale as the deps stage: avoid `npm ci`'s
# strict lockfile coupling so cross-OS hoisting differences don't
# break the build. `--omit=dev` strips devDependencies. `--workspaces=false`
# keeps the tree small (we don't ship the shell from this image).
RUN npm install --omit=dev --workspaces=false --no-audit --no-fund

# -----------------------------------------------------------------------------
# 4. Runner
# -----------------------------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app

RUN apk add --no-cache tini && \
    addgroup -S app && \
    adduser -S app -G app

ENV NODE_ENV=production
ENV PORT=3002

COPY --from=prune --chown=app:app /app/node_modules ./node_modules
COPY --from=prune --chown=app:app /app/package.json ./package.json
COPY --from=build --chown=app:app /app/dist ./dist

USER app
EXPOSE 3002

# tini handles SIGTERM cleanly so Fly's deploy / scale operations don't
# leave orphaned WS connections in the gateway's tracker.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server/index.js"]
