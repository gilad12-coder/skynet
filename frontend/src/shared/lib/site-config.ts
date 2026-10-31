/**
 * Single source of truth for the public site URL used in metadata, OG tags,
 * the JSON-LD payload, robots.txt, and sitemap.xml.
 *
 * `NEXT_PUBLIC_SITE_URL` names the deployment's own origin (a preview
 * environment sets its own); the public `https://skynetml.com` is the fallback
 * when it is unset or empty. Centralising the lookup here keeps a future
 * "fail-closed when unset in production" tweak to one place.
 */
const FALLBACK_SITE_URL = "https://skynetml.com";

export function getSiteUrl(): string {
  // The Dockerfile copies an unset build arg into ENV as "", so treat empty as unset.
  return process.env.NEXT_PUBLIC_SITE_URL || FALLBACK_SITE_URL;
}
