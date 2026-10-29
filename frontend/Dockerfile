FROM node:20-alpine AS base
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
WORKDIR /app

COPY package.json package-lock.json .npmrc* ./
# The npm download cache and Next's compile cache live in cache mounts, so a
# rebuild reuses them even when a layer above them changes.
RUN --mount=type=cache,id=frontend-npm,target=/root/.npm \
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
# .git is dockerignored, so withSentryConfig (next.config.ts) cannot read the
# commit itself. It reads SENTRY_RELEASE during `npm run build` and bakes it
# into the bundle as the Sentry release name. APP_GIT_SHA names the commit.
ARG APP_GIT_SHA
ENV SENTRY_RELEASE=$APP_GIT_SHA
# The footer's AGPL source link points at this commit (legal-config.ts).
ENV NEXT_PUBLIC_SOURCE_COMMIT=$APP_GIT_SHA
RUN --mount=type=cache,id=frontend-next-cache,target=/app/.next/cache \
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
