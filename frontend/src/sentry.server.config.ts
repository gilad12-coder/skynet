/** Initialize Sentry for the Next.js Node runtime when a DSN is set. */

import * as Sentry from "@sentry/nextjs";

import { deployGitSha } from "@/shared/lib/deploy-env";
import { scrubSentryEvent, sentryTraceSampleRate } from "@/shared/lib/sentry-privacy";

const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment:
    process.env.SENTRY_ENVIRONMENT ?? process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? "development",
  release: deployGitSha() ?? process.env.NEXT_PUBLIC_APP_VERSION,
  sendDefaultPii: false,
  tracesSampleRate: sentryTraceSampleRate(
    process.env.SENTRY_TRACES_SAMPLE_RATE ?? process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
  ),
  beforeSend: scrubSentryEvent,
});
