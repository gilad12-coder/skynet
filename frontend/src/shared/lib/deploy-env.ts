/**
 * Platform-neutral deploy variables. Each `APP_*` name wins; Railway's own
 * name is the fallback until hosting moves off Railway. Empty counts as unset.
 */

type Env = Record<string, string | undefined>;

/** Return the commit the deployed build came from, or `undefined` when none is known. */
export function deployGitSha(env: Env = process.env): string | undefined {
  return env.APP_GIT_SHA || env.RAILWAY_GIT_COMMIT_SHA || undefined;
}

/** Return whether the deploy environment is a PR preview (a name ending in `-pr-<n>`). */
export function isPreviewEnvironment(env: Env = process.env): boolean {
  return /-pr-\d+$/.test(env.APP_ENVIRONMENT || env.RAILWAY_ENVIRONMENT_NAME || "");
}
