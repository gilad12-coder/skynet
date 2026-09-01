/**
 * Company slug for a routed model id, in the vocabulary `ProviderLogo` reads.
 *
 * The OpenRouter prefix is transport, not brand, so it is skipped when a
 * company segment follows it; "x-ai" is the one id spelling that differs
 * from the brand mark's slug.
 */
export function modelProviderSlug(id: string): string {
  const parts = id.split("/");
  const slug = (parts[0] === "openrouter" && parts.length > 2 ? parts[1] : parts[0]) ?? id;
  return slug === "x-ai" ? "xai" : slug;
}
