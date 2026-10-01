# Builds one Node service of the monorepo (APP=api | worker) into a small runtime image.
# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /repo

FROM base AS build
ARG APP
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter "@neuroflow/${APP}..."
RUN pnpm --filter "@neuroflow/${APP}" build
# Flat (hoisted) production node_modules so the bundled workspace code can resolve every
# transitive third-party dependency.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter "@neuroflow/${APP}" --prod --config.node-linker=hoisted deploy /out \
 && cp -r "apps/${APP}/dist" /out/dist

FROM node:${NODE_VERSION}-alpine AS runtime
ARG APP
ENV NODE_ENV=production MIGRATIONS_DIR=/app/migrations LOG_PRETTY=0
# Code workspaces use the git CLI (API + worker); the worker starts sandbox containers through
# the Docker daemon socket mounted by docker compose (docker CLI only, no daemon in the image).
RUN apk add --no-cache git && if [ "$APP" = "worker" ]; then apk add --no-cache docker-cli; fi
WORKDIR /app
COPY --from=build /out ./
COPY infra/migrations ./migrations
USER node
EXPOSE 8080
# The API listens on PORT; the worker has no HTTP surface.
CMD ["node", "--enable-source-maps", "dist/main.js"]
