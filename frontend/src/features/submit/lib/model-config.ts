import { isCliProvider } from "@/shared/lib/cli-providers";
import type { ModelConfig } from "@/shared/types/api";

/**
 * Strip a model config down to what a submit may carry: credentials and
 * endpoint overrides never leave the browser, and a BYOK provider is kept only
 * while the config is billed to the user's own key. A restored draft or a clone
 * can name a CLI the app no longer offers (Droid); the backend refuses that at
 * submit, so the CLI goes out as null.
 */
export function prepareModelConfig(config: ModelConfig): ModelConfig {
  const { base_url: _baseUrl, ...fields } = config;
  const {
    api_key: _apiKey,
    api_base: _ApiBase,
    base_url: _ExtraBaseUrl,
    ...safeExtra
  } = fields.extra ?? {};
  const tokenSource = fields.token_source ?? "managed";
  return {
    ...fields,
    token_source: tokenSource,
    byok_provider: tokenSource === "byok" ? fields.byok_provider : undefined,
    extra: Object.keys(safeExtra).length > 0 ? safeExtra : undefined,
    ...(fields.cli_provider != null &&
      !isCliProvider(fields.cli_provider) && { cli_provider: null }),
  };
}
