import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { STOP_GRACE_MS } from "./supervisor";

/**
 * A crash or force quit skips the before-quit cleanup, and the API and web
 * server keep running under launchd. Each service start records its process
 * group here; the next launch stops the recorded groups before it picks ports.
 */
export const PIDS_FILE = "stack.pids";

export interface PidEntry {
  role: string;
  /** Process group id; the group leader has this pid. */
  pgid: number;
  /** The leader's command line as `ps -o command=` prints it. */
  command: string;
}

export interface SweepDeps {
  /** The current command line of a pid, or null when no such process exists. */
  commandOf(pid: number): string | null;
  kill(target: number, signal: NodeJS.Signals): void;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  graceMs?: number;
}

export function readPids(dataDir: string): PidEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, PIDS_FILE), "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e): e is PidEntry =>
        typeof e === "object" &&
        e !== null &&
        typeof e.role === "string" &&
        Number.isInteger(e.pgid) &&
        e.pgid > 1 &&
        typeof e.command === "string" &&
        e.command.length > 0,
    );
  } catch {
    return [];
  }
}

export function recordPid(dataDir: string, entry: PidEntry): void {
  const entries = readPids(dataDir).filter((e) => e.role !== entry.role);
  entries.push(entry);
  fs.writeFileSync(path.join(dataDir, PIDS_FILE), JSON.stringify(entries));
}

export function clearPids(dataDir: string): void {
  fs.rmSync(path.join(dataDir, PIDS_FILE), { force: true });
}

/** The command line that `ps -o command=` shows for a spawned file and args. */
export function commandLine(file: string, args: string[]): string {
  return [file, ...args].join(" ");
}

export function psCommandOf(pid: number): string | null {
  try {
    const out = execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Stop each recorded group whose leader still runs the recorded command, then
 * delete the file. A pid that is gone, or that now belongs to another program,
 * is left alone: only processes this app started are signalled.
 */
export async function sweepOrphans(dataDir: string, deps: SweepDeps): Promise<number> {
  const live = readPids(dataDir).filter((e) => deps.commandOf(e.pgid) === e.command);
  for (const e of live) {
    deps.log(`stopping leftover ${e.role} (pgid ${e.pgid}) from an earlier session`);
    signalGroup(e.pgid, "SIGTERM", deps);
  }
  const deadline = Date.now() + (deps.graceMs ?? STOP_GRACE_MS);
  let remaining = live;
  while (remaining.length && Date.now() < deadline) {
    await deps.sleep(250);
    remaining = remaining.filter((e) => deps.commandOf(e.pgid) === e.command);
  }
  for (const e of remaining) signalGroup(e.pgid, "SIGKILL", deps);
  // The leader can exit before its children (uv before python); sweep each group once more.
  for (const e of live) signalGroup(e.pgid, "SIGKILL", deps);
  clearPids(dataDir);
  return live.length;
}

function signalGroup(pgid: number, signal: NodeJS.Signals, deps: SweepDeps): void {
  try {
    deps.kill(-pgid, signal);
  } catch {
    // The group is already gone.
  }
}
