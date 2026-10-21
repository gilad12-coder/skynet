import { execFile } from "node:child_process";
import os from "node:os";

/**
 * Keys removed from every child environment (§1.7). With none of these keys
 * present, no child can bill OpenRouter, Anthropic, OpenAI, Factory, Vercel or
 * Stripe, and the backend's hosted-safety validator cannot see a Railway
 * environment. The CLI keys match the set the backend strips (SKY-112): each
 * one moves a claude, codex or droid call off the user's subscription, to an
 * API account, another endpoint (base URLs, Bedrock) or another config home.
 * CLAUDE_CODE_OAUTH_TOKEN stays: it is the subscription login itself.
 */
export const DELETED_ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "AWS_BEARER_TOKEN_BEDROCK",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "FACTORY_API_KEY",
  "FACTORY_API_BASE_URL",
  "FACTORY_API_BASE_URL_EU",
  "FACTORY_HOME_OVERRIDE",
  "VERCEL_TOKEN",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "RAILWAY_ENVIRONMENT_NAME",
] as const;

/** Every key with one of these prefixes is removed too (CLAUDE_CODE_USE_BEDROCK, _VERTEX, _FOUNDRY, ...). */
export const DELETED_ENV_PREFIXES = ["CLAUDE_CODE_USE_"] as const;

export const LOGIN_SHELL_TIMEOUT_MS = 10_000;

/** The PATH used when the login shell cannot be read. */
export function fallbackPath(home: string = os.homedir()): string {
  return ["/opt/homebrew/bin", "/usr/local/bin", `${home}/.local/bin`, "/usr/bin", "/bin"].join(":");
}

/** Parse the output of `env -0` (NUL-separated KEY=VALUE records). */
export function parseEnvNul(output: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const record of output.split("\0")) {
    const eq = record.indexOf("=");
    if (eq <= 0) continue;
    // A login shell can print a banner before `env -0` runs; only the text
    // after the last newline of the first record belongs to the variable name.
    const rawKey = record.slice(0, eq);
    const key = rawKey.slice(rawKey.lastIndexOf("\n") + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = record.slice(eq + 1);
  }
  return env;
}

export type ExecFileLike = (
  file: string,
  args: string[],
  options: { timeout: number; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string }>;

const defaultExec: ExecFileLike = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { ...options, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout });
    });
  });

/**
 * Read PATH from the user's login shell. Apps opened from Finder inherit a
 * minimal launchd PATH that misses Homebrew, nvm and ~/.local/bin, which is
 * where docker, codex, claude and droid usually live.
 */
export async function loginShellPath(
  opts: { shell?: string; home?: string; exec?: ExecFileLike; timeoutMs?: number } = {},
): Promise<{ path: string; fromShell: boolean }> {
  const shell = opts.shell || process.env.SHELL || "/bin/zsh";
  const home = opts.home || os.homedir();
  const exec = opts.exec ?? defaultExec;
  try {
    const { stdout } = await exec(shell, ["-lc", "env -0"], {
      timeout: opts.timeoutMs ?? LOGIN_SHELL_TIMEOUT_MS,
      env: { ...process.env, HOME: home, SHELL: shell, TERM: "dumb" },
    });
    const parsed = parseEnvNul(stdout).PATH;
    if (parsed && parsed.trim()) return { path: parsed, fromShell: true };
  } catch {
    // Timeout, missing shell or a broken rc file: the fallback PATH still finds Homebrew installs.
  }
  return { path: fallbackPath(home), fromShell: false };
}

/**
 * Build a child process environment: the base env minus DELETED_ENV_KEYS and
 * DELETED_ENV_PREFIXES,
 * plus overrides. The keys are deleted again after the overrides so a caller
 * can never reintroduce a provider credential by accident.
 */
export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }
  // Electron sets this for its own helper processes; a stray copy would turn
  // every spawned Electron binary into plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  for (const key of DELETED_ENV_KEYS) delete env[key];
  for (const key of Object.keys(env)) {
    if (DELETED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) delete env[key];
  }
  return env;
}
