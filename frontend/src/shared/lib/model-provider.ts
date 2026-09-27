// OpenRouter vendor segments spelled differently from the brand mark's slug.
const BRAND_SLUGS: Record<string, string> = {
  "x-ai": "xai",
  "z-ai": "zai",
  mistralai: "mistral",
  "meta-llama": "meta",
};

/**
 * Company slug for a routed model id, in the vocabulary `ProviderLogo` reads.
 *
 * The OpenRouter prefix is transport, not brand, so it is skipped when a
 * company segment follows it.
 */
export function modelProviderSlug(id: string): string {
  const parts = id.split("/");
  const slug = (parts[0] === "openrouter" && parts.length > 2 ? parts[1] : parts[0]) ?? id;
  return BRAND_SLUGS[slug] ?? slug;
}
