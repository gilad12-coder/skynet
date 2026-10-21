import { describe, expect, it } from "vitest";
import type { CliStatus, DockerStatus } from "../src/main/cli-detect";
import { computeOnboardingState, type Inputs } from "../src/main/supervisor";

const NOW = new Date("2026-10-21T12:00:00Z");
const DOCKER_OK: DockerStatus = { path: "/usr/local/bin/docker", running: true, error: null };

function cli(id: CliStatus["id"], over: Partial<CliStatus> = {}): CliStatus {
  return {
    id,
    path: `/opt/homebrew/bin/${id}`,
    version: "9.9.9",
    minVersion: "0.0.0",
    versionOk: true,
    loggedIn: true,
    loginCommand: `${id} login`,
    upgradeCommand: `${id} update`,
    ...over,
  };
}

const MISSING = { path: null, version: null, versionOk: false, loggedIn: null };

function state(over: Partial<Inputs>) {
  return computeOnboardingState({
    docker: DOCKER_OK,
    clis: [cli("claude"), cli("codex", MISSING), cli("droid", MISSING)],
    limits: {},
    now: NOW,
    acceptedRateCap: false,
    ...over,
  });
}

describe("computeOnboardingState", () => {
  it("asks for Docker first", () => {
    expect(state({ docker: { path: null, running: false, error: null }, clis: [] }).kind).toBe("docker_missing");
    expect(state({ docker: { path: "/x/docker", running: false, error: "no daemon" } }).kind).toBe("docker_stopped");
  });

  it("asks for a CLI when none is installed", () => {
    expect(state({ clis: [cli("claude", MISSING), cli("codex", MISSING), cli("droid", MISSING)] }).kind).toBe("no_cli");
  });

  it("asks for an upgrade when every installed CLI is too old", () => {
    const s = state({ clis: [cli("codex", { version: "0.157.0", versionOk: false, loggedIn: null }), cli("claude", MISSING)] });
    expect(s.kind).toBe("cli_too_old");
  });

  it("does not block on a too-old CLI when another one works", () => {
    const s = state({ clis: [cli("codex", { versionOk: false, loggedIn: null }), cli("claude")] });
    expect(s.kind).toBe("starting");
  });

  it("asks for sign-in when no current CLI is signed in", () => {
    expect(state({ clis: [cli("claude", { loggedIn: false }), cli("codex", { loggedIn: false })] }).kind).toBe("not_logged_in");
  });

  it("treats an unreadable login check as signed out", () => {
    expect(state({ clis: [cli("claude", { loggedIn: false }), cli("droid", { loggedIn: null })] }).kind).toBe("not_logged_in");
    expect(state({ clis: [cli("droid", { loggedIn: null }), cli("codex", { loggedIn: true })] }).kind).toBe("starting");
  });

  it("reports the earliest reset when every usable CLI is capped", () => {
    const s = state({
      clis: [cli("claude"), cli("codex")],
      limits: {
        claude: { reset_at: "2026-10-21T18:00:00Z", message: "Claude 5-hour limit" },
        codex: { reset_at: "2026-10-21T15:00:00Z", message: "Codex weekly limit" },
      },
    });
    expect(s).toMatchObject({ kind: "rate_capped", resetAt: "2026-10-21T15:00:00Z", limitMessage: "Codex weekly limit" });
  });

  it("ignores a cap whose reset time has passed or is invalid", () => {
    expect(state({ limits: { claude: { reset_at: "2026-10-21T11:00:00Z", message: "" } } }).kind).toBe("starting");
    expect(state({ limits: { claude: { reset_at: "soon", message: "" } } }).kind).toBe("starting");
  });

  it("starts when one CLI is capped and another is free", () => {
    const s = state({ clis: [cli("claude"), cli("codex")], limits: { claude: { reset_at: "2026-10-22T00:00:00Z", message: "" } } });
    expect(s.kind).toBe("starting");
  });

  it("starts after the user continues past the cap", () => {
    const limits = { claude: { reset_at: "2026-10-22T00:00:00Z", message: "" } };
    expect(state({ limits }).kind).toBe("rate_capped");
    expect(state({ limits, acceptedRateCap: true }).kind).toBe("starting");
  });
});
