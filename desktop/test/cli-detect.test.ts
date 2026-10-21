import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  childPath,
  codexSubscriptionLogin,
  compareVersions,
  FAKE_CLI_DIR_ENV,
  findExecutable,
  meetsFloor,
  MIN_VERSIONS,
  parseVersion,
  probeCli,
  probeClis,
  probeDocker,
  readCliLimits,
  readCodexLoginFile,
  searchDirs,
  type Runner,
} from "../src/main/cli-detect";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "skynet-cli-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function fake(name: string, script: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return file;
}

describe("version parsing and comparison", () => {
  it("extracts the version from real --version outputs", () => {
    expect(parseVersion("2.1.306 (Claude Code)")).toBe("2.1.306");
    expect(parseVersion("codex-cli 0.157.0")).toBe("0.157.0");
    expect(parseVersion("droid v0.231.0\n")).toBe("0.231.0");
    expect(parseVersion("unknown")).toBeNull();
  });

  it("compares numerically, not as strings", () => {
    expect(compareVersions("0.160.0", "0.157.0")).toBe(1);
    expect(compareVersions("0.99.0", "0.160.0")).toBe(-1);
    expect(compareVersions("2.1.226", "2.1.226")).toBe(0);
    expect(compareVersions("10.0.0", "9.9.9")).toBe(1);
  });

  it("checks the version floors", () => {
    expect(meetsFloor("2.1.306", MIN_VERSIONS.claude)).toBe(true);
    expect(meetsFloor("0.157.0", MIN_VERSIONS.codex)).toBe(false);
    expect(meetsFloor("0.160.0", MIN_VERSIONS.codex)).toBe(true);
    expect(meetsFloor(null, MIN_VERSIONS.droid)).toBe(false);
  });

  it("keeps the floors in step with backend MIN_VERSIONS", () => {
    expect(MIN_VERSIONS).toEqual({ claude: "2.1.226", codex: "0.160.0", droid: "0.0.0" });
  });
});

describe("search paths", () => {
  it("uses only the fake directory when it is set", () => {
    const env = { [FAKE_CLI_DIR_ENV]: dir, HOME: "/Users/x" };
    expect(searchDirs("/opt/homebrew/bin:/usr/bin", env)).toEqual([dir]);
    expect(childPath("/usr/bin", env)).toBe(`${dir}:/usr/bin`);
  });

  it("adds Homebrew and Docker Desktop locations to the login PATH", () => {
    const dirs = searchDirs("/usr/bin:/bin", { HOME: "/Users/x" });
    expect(dirs.slice(0, 2)).toEqual(["/usr/bin", "/bin"]);
    expect(dirs).toContain("/opt/homebrew/bin");
    expect(dirs).toContain("/Users/x/.docker/bin");
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  it("finds only executable files", () => {
    fs.writeFileSync(path.join(dir, "codex"), "not executable", { mode: 0o644 });
    fs.mkdirSync(path.join(dir, "claude"));
    expect(findExecutable("codex", [dir])).toBeNull();
    expect(findExecutable("claude", [dir])).toBeNull();
    const droid = fake("droid", "echo 1.0.0");
    expect(findExecutable("droid", ["/nonexistent", dir])).toBe(droid);
  });
});

describe("probeCli with fake binaries", () => {
  it("reports a missing CLI", async () => {
    const status = await probeCli("codex", [dir], {});
    expect(status).toMatchObject({ path: null, version: null, versionOk: false, loggedIn: null });
  });

  it("reports a CLI below its floor without a login check", async () => {
    fake("codex", 'echo "codex-cli 0.157.0"');
    const status = await probeCli("codex", [dir], {});
    expect(status).toMatchObject({ version: "0.157.0", versionOk: false, loggedIn: null });
    expect(status.upgradeCommand).toContain("@openai/codex");
  });

  it("reads claude auth status JSON", async () => {
    fake("claude", 'if [ "$1" = "--version" ]; then echo "2.1.306 (Claude Code)"; else echo \'{"loggedIn": false}\'; fi');
    expect(await probeCli("claude", [dir], {})).toMatchObject({ versionOk: true, loggedIn: false });
    fake("claude", 'if [ "$1" = "--version" ]; then echo "2.1.306"; else echo \'{"loggedIn": true, "authMethod": "claude.ai"}\'; fi');
    expect(await probeCli("claude", [dir], {})).toMatchObject({ versionOk: true, loggedIn: true });
    for (const method of ["api_key_helper", "oauth_token", "api_key", "third_party", "none"]) {
      fake("claude", `if [ "$1" = "--version" ]; then echo "2.1.306"; else echo '{"loggedIn": true, "authMethod": "${method}"}'; fi`);
      expect(await probeCli("claude", [dir], {})).toMatchObject({ versionOk: true, loggedIn: false });
    }
    fake("claude", 'if [ "$1" = "--version" ]; then echo "2.1.306"; else echo \'{"loggedIn": true}\'; fi');
    expect(await probeCli("claude", [dir], {})).toMatchObject({ versionOk: true, loggedIn: false });
    fake("claude", 'if [ "$1" = "--version" ]; then echo "2.1.306"; else echo \'{"loggedIn": false, "authMethod": "claude.ai"}\'; fi');
    expect(await probeCli("claude", [dir], {})).toMatchObject({ versionOk: true, loggedIn: false });
    fake("claude", 'if [ "$1" = "--version" ]; then echo "2.1.306"; else echo "Logged in"; fi');
    expect(await probeCli("claude", [dir], {})).toMatchObject({ versionOk: true, loggedIn: false });
    fake("claude", 'if [ "$1" = "--version" ]; then echo "2.1.306"; else echo \'{"loggedIn": "yes"}\'; fi');
    expect(await probeCli("claude", [dir], {})).toMatchObject({ versionOk: true, loggedIn: false });
  });

  it("needs exit 0 and a non-API-key 'logged in' from codex login status", async () => {
    const codexHome = path.join(dir, "codex-home");
    fs.mkdirSync(codexHome);
    fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "a" } }));
    const env = { CODEX_HOME: codexHome };
    fake("codex", 'if [ "$1" = "--version" ]; then echo "codex-cli 0.160.1"; else echo "Not logged in" >&2; exit 1; fi');
    expect(await probeCli("codex", [dir], env)).toMatchObject({ version: "0.160.1", versionOk: true, loggedIn: false });
    fake("codex", 'if [ "$1" = "--version" ]; then echo "codex-cli 0.160.1"; else echo "something else"; fi');
    expect(await probeCli("codex", [dir], env)).toMatchObject({ loggedIn: false });
    fake("codex", 'if [ "$1" = "--version" ]; then echo "codex-cli 0.160.1"; else echo "Logged in using ChatGPT" >&2; fi');
    expect(await probeCli("codex", [dir], env)).toMatchObject({ loggedIn: true });
    fake("codex", 'if [ "$1" = "--version" ]; then echo "codex-cli 0.160.1"; else echo "Logged in using an API key - sk-proj-***ABCDE" >&2; fi');
    expect(await probeCli("codex", [dir], env)).toMatchObject({ loggedIn: false });
    fake("codex", 'if [ "$1" = "--version" ]; then echo "codex-cli 0.160.1"; else echo "Logged in using API KEY"; fi');
    expect(await probeCli("codex", [dir], env)).toMatchObject({ loggedIn: false });
  });

  // codex says "Logged in using ChatGPT" (exit 0) for all of these; the backend
  // (core/local/cli_probe.py) refuses them, so the onboarding must too.
  it("signs codex in only when auth.json is a ChatGPT login with an access token, like the backend", async () => {
    const codexHome = path.join(dir, "codex-home");
    fs.mkdirSync(codexHome);
    fake("codex", 'if [ "$1" = "--version" ]; then echo "codex-cli 0.163.0"; else echo "Logged in using ChatGPT"; fi');
    const withAuth = async (doc: unknown) => {
      fs.writeFileSync(path.join(codexHome, "auth.json"), typeof doc === "string" ? doc : JSON.stringify(doc));
      return (await probeCli("codex", [dir], { CODEX_HOME: codexHome })).loggedIn;
    };
    expect(await withAuth({ auth_mode: "chatgpt", tokens: { id_token: "x", access_token: "a", refresh_token: "r" } })).toBe(true);
    expect(await withAuth({ tokens: { access_token: "a" } })).toBe(true);
    expect(await withAuth({ OPENAI_API_KEY: "", tokens: { access_token: "a" } })).toBe(true);
    expect(await withAuth({ auth_mode: "chatgpt" })).toBe(false);
    expect(await withAuth({ auth_mode: "chatgpt", tokens: null })).toBe(false);
    expect(await withAuth({ auth_mode: "chatgpt", tokens: { access_token: "" } })).toBe(false);
    expect(await withAuth({ auth_mode: "chatgpt", tokens: { access_token: {} } })).toBe(false);
    expect(await withAuth({})).toBe(false);
    expect(await withAuth({ auth_mode: "chatgptAuthTokens", tokens: { access_token: "a" } })).toBe(false);
    expect(await withAuth({ auth_mode: "personalAccessToken", tokens: { access_token: "a" } })).toBe(false);
    expect(await withAuth({ auth_mode: "agentIdentity", tokens: { access_token: "a" } })).toBe(false);
    expect(await withAuth({ auth_mode: "bedrockAccessKeys", tokens: { access_token: "a" } })).toBe(false);
    expect(await withAuth({ OPENAI_API_KEY: "sk-x", tokens: { access_token: "a" } })).toBe(false);
    expect(await withAuth("not json")).toBe(false);
    expect(await withAuth([])).toBe(false);
    // Keychain store: codex keeps no auth.json.
    fs.rmSync(path.join(codexHome, "auth.json"));
    expect((await probeCli("codex", [dir], { CODEX_HOME: codexHome })).loggedIn).toBe(false);
  });

  it("reads auth.json from CODEX_HOME, else from HOME/.codex", async () => {
    const home = path.join(dir, "home");
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "a" } }));
    expect(readCodexLoginFile({ HOME: home })).toMatchObject({ auth_mode: "chatgpt" });
    expect(readCodexLoginFile({ HOME: home, CODEX_HOME: path.join(dir, "empty") })).toBeNull();
    fake("codex", 'if [ "$1" = "--version" ]; then echo "codex-cli 0.163.0"; else echo "Logged in using ChatGPT"; fi');
    expect((await probeCli("codex", [dir], { HOME: home })).loggedIn).toBe(true);
    expect((await probeCli("codex", [dir], { HOME: home, CODEX_HOME: path.join(dir, "empty") })).loggedIn).toBe(false);
    expect(codexSubscriptionLogin(null)).toBe(false);
  });

  it("reads ok from droid doctor --auth --json", async () => {
    const droid = (out: string) => {
      const runner: Runner = async (_file, args) => {
        if (args[0] === "--version") return { code: 0, stdout: "0.231.0", stderr: "" };
        expect(args).toEqual(["doctor", "--auth", "--json"]);
        return { code: 0, stdout: out, stderr: "" };
      };
      return probeCli("droid", [dir], {}, runner);
    };
    fake("droid", "exit 0");
    expect(await droid('{"ok": true, "checks": []}')).toMatchObject({ versionOk: true, loggedIn: true });
    expect(await droid('{"ok": false}')).toMatchObject({ loggedIn: false });
    expect(await droid("Error: unknown command")).toMatchObject({ loggedIn: null });
    expect(await droid('{"ok": "yes"}')).toMatchObject({ loggedIn: null });
    expect(await droid("null")).toMatchObject({ loggedIn: null });
  });

  it("probes with only the allowed environment", async () => {
    fake("claude", "echo 2.1.300");
    const seen: Record<string, string>[] = [];
    const runner: Runner = async (_file, args, env) => {
      seen.push(env);
      return { code: 0, stdout: args[0] === "--version" ? "2.1.300" : '{"loggedIn":true,"authMethod":"claude.ai"}', stderr: "" };
    };
    await probeClis(
      [dir],
      {
        ANTHROPIC_API_KEY: "sk-test",
        ANTHROPIC_PROFILE: "work",
        OPENAI_API_KEY: "sk-test",
        FACTORY_API_KEY: "fk-test",
        NODE_OPTIONS: "--require /tmp/x.js",
        HOME: "/Users/x",
      },
      runner,
    );
    expect(seen.length).toBeGreaterThan(0);
    for (const env of seen) expect(env).toEqual({ HOME: "/Users/x" });
  });
});

describe("probeDocker", () => {
  it("reports missing, stopped and running Docker", async () => {
    expect(await probeDocker([dir], {})).toEqual({ path: null, running: false, error: null });
    fake("docker", 'echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock." >&2; exit 1');
    expect(await probeDocker([dir], {})).toMatchObject({ running: false, error: expect.stringContaining("Cannot connect") });
    fake("docker", "echo 29.0.0");
    expect(await probeDocker([dir], {})).toMatchObject({ running: true, error: null });
  });
});

describe("readCliLimits", () => {
  it("reads valid entries and ignores the rest", () => {
    fs.writeFileSync(
      path.join(dir, "cli_limits.json"),
      JSON.stringify({ claude: { reset_at: "2026-10-21T18:00:00Z", message: "5-hour limit" }, codex: { message: "x" }, other: {} }),
    );
    expect(readCliLimits(dir)).toEqual({ claude: { reset_at: "2026-10-21T18:00:00Z", message: "5-hour limit" } });
  });

  it("returns nothing for a missing or broken file", () => {
    expect(readCliLimits(dir)).toEqual({});
    fs.writeFileSync(path.join(dir, "cli_limits.json"), "{not json");
    expect(readCliLimits(dir)).toEqual({});
  });
});
