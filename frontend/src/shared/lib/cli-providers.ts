/**
 * The coding-agent CLIs whose subscription can run a model. It lives in
 * `shared/` so pure submit helpers can check a saved CLI without loading the
 * local-runtime feature barrel, which pulls in React hooks.
 */
import type { ModelConfig } from "@/shared/types/api";

export type CliProvider = NonNullable<ModelConfig["cli_provider"]>;

export const CLI_PROVIDERS: readonly CliProvider[] = ["codex", "claude"];

export function isCliProvider(value: unknown): value is CliProvider {
  return typeof value === "string" && (CLI_PROVIDERS as readonly string[]).includes(value);
}
