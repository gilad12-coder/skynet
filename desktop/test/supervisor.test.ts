import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagedProcess } from "../src/main/supervisor";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("ManagedProcess", () => {
  afterEach(() => vi.restoreAllMocks());

  it("kills the group's leftover children when the leader exits", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skynet-supervisor-"));
    const pidFile = path.join(dir, "child.pid");
    const proc = new ManagedProcess("svc", "/bin/sh", ["-c", `sleep 30 & echo $! > ${pidFile}; exit 0`], {
      env: { PATH: "/usr/bin:/bin" },
      cwd: dir,
      logFile: path.join(dir, "svc.log"),
    });
    proc.start();
    await until(() => proc.exited);
    const childPid = Number(fs.readFileSync(pidFile, "utf8").trim());
    await until(() => !alive(childPid));
  });

  it("sends no signal on stop after the service already exited", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skynet-supervisor-"));
    const proc = new ManagedProcess("svc", "/bin/sh", ["-c", "exit 3"], {
      env: { PATH: "/usr/bin:/bin" },
      cwd: dir,
      logFile: path.join(dir, "svc.log"),
    });
    proc.start();
    await until(() => proc.exited);
    const kill = vi.spyOn(process, "kill");
    await proc.stop();
    expect(kill).not.toHaveBeenCalled();
    expect(proc.exitCode).toBe(3);
  });
});
