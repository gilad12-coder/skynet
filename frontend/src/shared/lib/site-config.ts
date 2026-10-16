/**
 * Single source of truth for the public site URL used in metadata, OG tags,
 * the JSON-LD payload, robots.txt, and sitemap.xml.
 *
 * `NEXT_PUBLIC_SITE_URL` names the deployment's own origin (a preview
 * environment sets its own); the public `https://skynet.app` is the fallback
 * when it is unset. Centralising the lookup here keeps a future "fail-closed
 * when unset in production" tweak to one place.
 */
const FALLBACK_SITE_URL = "https://skynet.app";

export function getSiteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? FALLBACK_SITE_URL;
}
