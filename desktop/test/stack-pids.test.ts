import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearPids, PIDS_FILE, psStartOf, readPids, recordPid, sweepOrphans, type SweepDeps } from "../src/main/stack-pids";
import { sandboxTag } from "../src/main/sandbox-image";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "skynet-pids-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const API = "Wed Oct 21 02:01:40 2026";
const WEB = "Wed Oct 21 02:01:59 2026";

/** A fake process table: pid -> start time. SIGTERM ends a pid unless it ignores TERM. */
function fakeProcs(table: Record<number, string>, ignoresTerm: number[] = []) {
  const signals: [number, NodeJS.Signals][] = [];
  const deps: SweepDeps = {
    startOf: (pid) => table[pid] ?? null,
    kill: (target, sig) => {
      signals.push([target, sig]);
      const pid = -target;
      if (!(pid in table)) throw new Error("ESRCH");
      if (sig === "SIGKILL" || !ignoresTerm.includes(pid)) delete table[pid];
    },
    sleep: async () => {},
    log: () => {},
    graceMs: 20,
  };
  return { deps, signals };
}

describe("pid file", () => {
  it("records one entry per role and clears", () => {
    recordPid(dir, { role: "api", pgid: 100, started: API });
    recordPid(dir, { role: "frontend", pgid: 200, started: WEB });
    recordPid(dir, { role: "api", pgid: 300, started: API });
    expect(readPids(dir)).toEqual([
      { role: "frontend", pgid: 200, started: WEB },
      { role: "api", pgid: 300, started: API },
    ]);
    clearPids(dir);
    expect(fs.existsSync(path.join(dir, PIDS_FILE))).toBe(false);
    expect(readPids(dir)).toEqual([]);
  });

  it("ignores a corrupt file and unsafe pids", () => {
    fs.writeFileSync(path.join(dir, PIDS_FILE), "not json");
    expect(readPids(dir)).toEqual([]);
    fs.writeFileSync(path.join(dir, PIDS_FILE), JSON.stringify([{ role: "x", pgid: 1, started: API }, { role: "y", pgid: 0, started: API }, { role: "z", pgid: 5, started: "" }, { role: "w", pgid: 6, command: "old format" }]));
    expect(readPids(dir)).toEqual([]);
  });
});

describe("sweepOrphans", () => {
  it("stops recorded groups whose start time still matches", async () => {
    recordPid(dir, { role: "api", pgid: 100, started: API });
    recordPid(dir, { role: "frontend", pgid: 200, started: WEB });
    const { deps, signals } = fakeProcs({ 100: API, 200: WEB, 999: "Tue Oct 20 09:00:00 2026" });
    expect(await sweepOrphans(dir, deps)).toBe(2);
    expect(signals).toContainEqual([-100, "SIGTERM"]);
    expect(signals).toContainEqual([-200, "SIGTERM"]);
    expect(signals.some(([t]) => t === -999 || t === 999)).toBe(false);
    expect(readPids(dir)).toEqual([]);
  });

  it("never signals a reused pid or a pid that is gone", async () => {
    recordPid(dir, { role: "api", pgid: 100, started: API });
    recordPid(dir, { role: "frontend", pgid: 200, started: WEB });
    const { deps, signals } = fakeProcs({ 100: "Wed Oct 21 03:15:00 2026" });
    expect(await sweepOrphans(dir, deps)).toBe(0);
    expect(signals).toEqual([]);
    expect(fs.existsSync(path.join(dir, PIDS_FILE))).toBe(false);
  });

  it("escalates to SIGKILL after the grace period", async () => {
    recordPid(dir, { role: "api", pgid: 100, started: API });
    const { deps, signals } = fakeProcs({ 100: API }, [100]);
    await sweepOrphans(dir, deps);
    expect(signals.map(([, s]) => s)).toEqual(["SIGTERM", "SIGKILL", "SIGKILL"]);
  });

  it("does nothing without a pid file", async () => {
    const { deps, signals } = fakeProcs({ 100: API });
    expect(await sweepOrphans(dir, deps)).toBe(0);
    expect(signals).toEqual([]);
  });
});

describe("psStartOf", () => {
  it("reads a live process start time that stays the same", () => {
    const first = psStartOf(process.pid);
    expect(first).toMatch(/\d{4}$/);
    expect(psStartOf(process.pid)).toBe(first);
  });

  it("returns null for a pid that does not exist", () => {
    expect(psStartOf(2 ** 22 + 7)).toBeNull();
  });
});

describe("sandboxTag", () => {
  it("keeps a bundle id that is already a valid tag", () => {
    expect(sandboxTag("0.1.0-41ab7353-1792571545000")).toBe("0.1.0-41ab7353-1792571545000");
  });

  it("replaces characters Docker does not allow and caps the length", () => {
    expect(sandboxTag("0.1.0+dirty/x")).toBe("0.1.0-dirty-x");
    expect(sandboxTag("-.abc")).toBe("abc");
    expect(sandboxTag("a".repeat(200))).toHaveLength(128);
    expect(sandboxTag("")).toBe("local");
  });
});
