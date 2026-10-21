import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearPids, commandLine, PIDS_FILE, readPids, recordPid, sweepOrphans, type SweepDeps } from "../src/main/stack-pids";
import { sandboxTag } from "../src/main/sandbox-image";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "skynet-pids-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const API = commandLine("/data/uv", ["run", "--frozen", "python", "main.py"]);
const WEB = commandLine("/Applications/Skynet.app/Contents/MacOS/Skynet", ["server.js"]);

/** A fake process table: pid -> command. SIGTERM ends a pid unless it ignores TERM. */
function fakeProcs(table: Record<number, string>, ignoresTerm: number[] = []) {
  const signals: [number, NodeJS.Signals][] = [];
  const deps: SweepDeps = {
    commandOf: (pid) => table[pid] ?? null,
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
    recordPid(dir, { role: "api", pgid: 100, command: API });
    recordPid(dir, { role: "frontend", pgid: 200, command: WEB });
    recordPid(dir, { role: "api", pgid: 300, command: API });
    expect(readPids(dir)).toEqual([
      { role: "frontend", pgid: 200, command: WEB },
      { role: "api", pgid: 300, command: API },
    ]);
    clearPids(dir);
    expect(fs.existsSync(path.join(dir, PIDS_FILE))).toBe(false);
    expect(readPids(dir)).toEqual([]);
  });

  it("ignores a corrupt file and unsafe pids", () => {
    fs.writeFileSync(path.join(dir, PIDS_FILE), "not json");
    expect(readPids(dir)).toEqual([]);
    fs.writeFileSync(path.join(dir, PIDS_FILE), JSON.stringify([{ role: "x", pgid: 1, command: "launchd" }, { role: "y", pgid: 0, command: "a" }, { role: "z", pgid: 5, command: "" }]));
    expect(readPids(dir)).toEqual([]);
  });
});

describe("sweepOrphans", () => {
  it("stops recorded groups whose command still matches", async () => {
    recordPid(dir, { role: "api", pgid: 100, command: API });
    recordPid(dir, { role: "frontend", pgid: 200, command: WEB });
    const { deps, signals } = fakeProcs({ 100: API, 200: WEB, 999: "/usr/bin/other" });
    expect(await sweepOrphans(dir, deps)).toBe(2);
    expect(signals).toContainEqual([-100, "SIGTERM"]);
    expect(signals).toContainEqual([-200, "SIGTERM"]);
    expect(signals.some(([t]) => t === -999 || t === 999)).toBe(false);
    expect(readPids(dir)).toEqual([]);
  });

  it("never signals a reused pid or a pid that is gone", async () => {
    recordPid(dir, { role: "api", pgid: 100, command: API });
    recordPid(dir, { role: "frontend", pgid: 200, command: WEB });
    const { deps, signals } = fakeProcs({ 100: "/Applications/Safari.app/Contents/MacOS/Safari" });
    expect(await sweepOrphans(dir, deps)).toBe(0);
    expect(signals).toEqual([]);
    expect(fs.existsSync(path.join(dir, PIDS_FILE))).toBe(false);
  });

  it("escalates to SIGKILL after the grace period", async () => {
    recordPid(dir, { role: "api", pgid: 100, command: API });
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
