# check=skip=SecretsUsedInArgOrEnv
# ^ SENTRY_AUTH_TOKEN is deliberately a build ARG: Railway exposes variables to
#   Dockerfile builds only through ARG (no BuildKit secret mounts). It lives in
#   the discarded build stage only, so the lint rule does not apply here.

FROM node:20-alpine AS base
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
WORKDIR /app

COPY package.json package-lock.json .npmrc* ./
# Railway keeps no image layers between builds, so the npm download cache and
# Next's compile cache live in cache mounts instead. Railway requires the
# s/<service id>- prefix on the id; plain Docker treats it as any other id.
RUN --mount=type=cache,id=s/8ebabb79-21cd-4026-b57b-7abc5e1d612c-/root/.npm,target=/root/.npm \
    npm ci --prefer-offline

FROM base AS build
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Next.js inlines these NEXT_PUBLIC_* values at `npm run build`, so they must be
# build args; they cannot be overridden on a prebuilt image.
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_FEATURE_GENERALIST_AGENT
ARG NEXT_PUBLIC_SENTRY_DSN
ARG NEXT_PUBLIC_SENTRY_ENVIRONMENT
ARG NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_FEATURE_GENERALIST_AGENT=$NEXT_PUBLIC_FEATURE_GENERALIST_AGENT
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN
ENV NEXT_PUBLIC_SENTRY_ENVIRONMENT=$NEXT_PUBLIC_SENTRY_ENVIRONMENT
ENV NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE=$NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE
# Sentry source-map upload (withSentryConfig in next.config.ts) runs inside
# `npm run build`, so it only sees these when they are declared as build args.
# Railway passes service variables into a Dockerfile build solely via ARG.
# Build-stage only: nothing here is copied into the runner image.
# .git is dockerignored, so the plugin cannot read the commit itself; it does
# read RAILWAY_GIT_COMMIT_SHA, which keeps the uploaded release equal to the
# one sentry.server.config.ts / sentry.edge.config.ts report at runtime.
ARG SENTRY_ORG
ARG SENTRY_PROJECT
ARG SENTRY_AUTH_TOKEN
ARG RAILWAY_GIT_COMMIT_SHA
# next.config.ts skips the source-map upload when this names a `*-pr-<n>`
# preview environment.
ARG RAILWAY_ENVIRONMENT_NAME
# The footer's AGPL source link points at this commit (legal-config.ts).
ENV NEXT_PUBLIC_SOURCE_COMMIT=$RAILWAY_GIT_COMMIT_SHA
RUN --mount=type=cache,id=s/8ebabb79-21cd-4026-b57b-7abc5e1d612c-/app/.next/cache,target=/app/.next/cache \
    node scripts/generate-third-party-licenses.mjs && npm run build

FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

# Run as a non-root user. Alpine uses busybox addgroup/adduser syntax.
RUN addgroup -g 1001 appuser 2>/dev/null || true \
    && adduser -u 1001 -G root -h /home/appuser -s /sbin/nologin -D appuser

COPY --from=build --chown=1001:0 /app/public ./public
COPY --from=build --chown=1001:0 /app/.next/standalone ./
COPY --from=build --chown=1001:0 /app/.next/static ./.next/static

RUN chgrp -R 0 /app && chmod -R g=u /app

USER 1001

EXPOSE 3001

CMD ["node", "server.js"]
