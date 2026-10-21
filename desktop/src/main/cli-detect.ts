import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildChildEnv } from "./shell-env";

export type CliId = "codex" | "claude" | "droid";
export const CLI_IDS: readonly CliId[] = ["claude", "codex", "droid"];

/**
 * Version floors. These duplicate `backend/core/local/cli_catalog.MIN_VERSIONS`
 * (SKY-111); a change there must change this table too.
 */
export const MIN_VERSIONS: Record<CliId, string> = {
  claude: "2.1.226",
  codex: "0.160.0",
  droid: "0.0.0",
};

export const LOGIN_COMMANDS: Record<CliId, string> = {
  claude: "claude auth login",
  codex: "codex login",
  droid: "droid",
};

export const UPGRADE_COMMANDS: Record<CliId, string> = {
  claude: "claude update",
  codex: "npm install -g @openai/codex@latest",
  droid: "curl -fsSL https://app.factory.ai/cli | sh",
};

/** When set, every binary (docker and the CLIs) is looked up only in this directory. */
export const FAKE_CLI_DIR_ENV = "SKYNET_DESKTOP_FAKE_CLI_DIR";

const PROBE_TIMEOUT_MS = 15_000;

export interface CliStatus {
  id: CliId;
  path: string | null;
  version: string | null;
  minVersion: string;
  versionOk: boolean;
  /** null means the login check gave no readable answer; the readiness gate treats it as signed out. */
  loggedIn: boolean | null;
  loginCommand: string;
  upgradeCommand: string;
}

export interface DockerStatus {
  path: string | null;
  running: boolean;
  error: string | null;
}

export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (file: string, args: string[], env: Record<string, string>) => Promise<RunResult>;

export const defaultRunner: Runner = (file, args, env) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { env, timeout: PROBE_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });

/** Extract the first `major.minor.patch` from a `--version` output. */
export function parseVersion(text: string): string | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/** Compare two `major.minor.patch` strings numerically. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export function meetsFloor(version: string | null, floor: string): boolean {
  return version !== null && compareVersions(version, floor) >= 0;
}

/** The directories searched for docker and the CLIs. */
export function searchDirs(loginPath: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const fake = env[FAKE_CLI_DIR_ENV];
  if (fake) return [fake];
  const home = env.HOME ?? "";
  // Docker Desktop links its CLI into ~/.docker/bin when it lacks admin rights for /usr/local/bin.
  const extras = ["/opt/homebrew/bin", "/usr/local/bin", `${home}/.docker/bin`, `${home}/.local/bin`];
  const dirs = [...loginPath.split(":"), ...extras].filter(Boolean);
  return [...new Set(dirs)];
}

/** Find an executable by name in the given directories. */
export function findExecutable(name: string, dirs: string[]): string | null {
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/** The PATH children see: the fake dir first when it is set, so fakes win over real installs. */
export function childPath(loginPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const fake = env[FAKE_CLI_DIR_ENV];
  return fake ? `${fake}:${loginPath}` : loginPath;
}

/** The same login checks as the backend's `core/local/cli_probe.py` (SKY-111). */
export async function checkLogin(id: CliId, bin: string, run: Runner, env: Record<string, string>): Promise<boolean | null> {
  if (id === "claude") {
    const res = await run(bin, ["auth", "status"], env);
    try {
      const parsed = JSON.parse(res.stdout) as { loggedIn?: unknown };
      if (typeof parsed.loggedIn === "boolean") return parsed.loggedIn;
    } catch {
      // Not JSON: fall through.
    }
    // Fail closed: output without a boolean loggedIn counts as signed out.
    return false;
  }
  if (id === "codex") {
    const res = await run(bin, ["login", "status"], env);
    // "Not logged in" also contains "logged in"; the exit code rules that case out.
    return res.code === 0 && /logged in/i.test(`${res.stdout}\n${res.stderr}`);
  }
  const res = await run(bin, ["doctor", "--auth", "--json"], env);
  try {
    const parsed = JSON.parse(res.stdout) as { ok?: unknown } | null;
    if (parsed && typeof parsed.ok === "boolean") return parsed.ok;
  } catch {
    // Unreadable output: unknown.
  }
  return null;
}

/** Probe one CLI: location, version against its floor, and login state. */
export async function probeCli(
  id: CliId,
  dirs: string[],
  env: Record<string, string>,
  run: Runner = defaultRunner,
): Promise<CliStatus> {
  const base = {
    id,
    minVersion: MIN_VERSIONS[id],
    loginCommand: LOGIN_COMMANDS[id],
    upgradeCommand: UPGRADE_COMMANDS[id],
  };
  const bin = findExecutable(id, dirs);
  if (!bin) return { ...base, path: null, version: null, versionOk: false, loggedIn: null };
  const probeEnv = buildChildEnv(env);
  const res = await run(bin, ["--version"], probeEnv);
  const version = parseVersion(`${res.stdout}\n${res.stderr}`);
  const versionOk = meetsFloor(version, MIN_VERSIONS[id]);
  const loggedIn = versionOk ? await checkLogin(id, bin, run, probeEnv) : null;
  return { ...base, path: bin, version, versionOk, loggedIn };
}

export async function probeClis(dirs: string[], env: Record<string, string>, run: Runner = defaultRunner): Promise<CliStatus[]> {
  return Promise.all(CLI_IDS.map((id) => probeCli(id, dirs, env, run)));
}

/** Find docker and check that its daemon answers. */
export async function probeDocker(dirs: string[], env: Record<string, string>, run: Runner = defaultRunner): Promise<DockerStatus> {
  const bin = findExecutable("docker", dirs);
  if (!bin) return { path: null, running: false, error: null };
  const res = await run(bin, ["info", "--format", "{{.ServerVersion}}"], buildChildEnv(env));
  if (res.code === 0 && res.stdout.trim()) return { path: bin, running: true, error: null };
  const error = (res.stderr || res.stdout).trim().split("\n").pop() ?? null;
  return { path: bin, running: false, error: error || null };
}

export interface CliLimit {
  reset_at: string;
  message: string;
}

/**
 * Read `cli_limits.json` from the local state dir. The backend's
 * `/local/status` reports the same file; the desktop reads it directly
 * because that endpoint needs a signed-in user token.
 */
export function readCliLimits(stateDir: string): Partial<Record<CliId, CliLimit>> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, "cli_limits.json"), "utf8")) as Record<string, unknown>;
    const out: Partial<Record<CliId, CliLimit>> = {};
    for (const id of CLI_IDS) {
      const entry = raw[id] as { reset_at?: unknown; message?: unknown } | undefined;
      if (entry && typeof entry.reset_at === "string") {
        out[id] = { reset_at: entry.reset_at, message: typeof entry.message === "string" ? entry.message : "" };
      }
    }
    return out;
  } catch {
    return {};
  }
}
