import { describe, expect, it } from "vitest";
import { buildChildEnv, DELETED_ENV_KEYS, DELETED_ENV_PREFIXES, fallbackPath, loginShellPath, parseEnvNul } from "../src/main/shell-env";

describe("parseEnvNul", () => {
  it("parses NUL-separated records, including values with = and newlines", () => {
    const env = parseEnvNul("PATH=/opt/homebrew/bin:/usr/bin\0EMPTY=\0MULTI=a\nb=c\0");
    expect(env).toEqual({ PATH: "/opt/homebrew/bin:/usr/bin", EMPTY: "", MULTI: "a\nb=c" });
  });

  it("ignores a banner printed by the login shell before env -0", () => {
    const env = parseEnvNul("Welcome to zsh!\nlast login: today\nPATH=/usr/local/bin:/bin\0HOME=/Users/x\0");
    expect(env.PATH).toBe("/usr/local/bin:/bin");
    expect(env.HOME).toBe("/Users/x");
  });

  it("skips records without a valid name", () => {
    expect(parseEnvNul("=bad\0no-equals\0 1X=y\0OK=1")).toEqual({ OK: "1" });
  });
});

describe("loginShellPath", () => {
  it("returns the login shell PATH", async () => {
    const result = await loginShellPath({
      shell: "/bin/zsh",
      home: "/Users/x",
      exec: async (file, args) => {
        expect(file).toBe("/bin/zsh");
        expect(args).toEqual(["-lc", "env -0"]);
        return { stdout: "HOME=/Users/x\0PATH=/Users/x/.nvm/bin:/opt/homebrew/bin:/usr/bin\0" };
      },
    });
    expect(result).toEqual({ path: "/Users/x/.nvm/bin:/opt/homebrew/bin:/usr/bin", fromShell: true });
  });

  it("falls back when the shell fails or times out", async () => {
    const result = await loginShellPath({
      shell: "/bin/zsh",
      home: "/Users/x",
      exec: async () => {
        throw new Error("timed out");
      },
    });
    expect(result).toEqual({ path: fallbackPath("/Users/x"), fromShell: false });
    expect(result.path).toBe("/opt/homebrew/bin:/usr/local/bin:/Users/x/.local/bin:/usr/bin:/bin");
  });

  it("falls back when the output has no PATH", async () => {
    const result = await loginShellPath({ home: "/Users/x", exec: async () => ({ stdout: "HOME=/Users/x\0" }) });
    expect(result.fromShell).toBe(false);
  });
});

describe("buildChildEnv", () => {
  it("removes every provider key, even when an override sets one", () => {
    const base: NodeJS.ProcessEnv = { HOME: "/Users/x", PATH: "/bin" };
    for (const key of DELETED_ENV_KEYS) base[key] = "secret";
    const env = buildChildEnv(base, { API_PORT: "48100", OPENAI_API_KEY: "again" });
    for (const key of DELETED_ENV_KEYS) expect(env).not.toHaveProperty(key);
    expect(env).toMatchObject({ HOME: "/Users/x", PATH: "/bin", API_PORT: "48100" });
  });

  it("lists exactly the keys from the desktop contract", () => {
    expect([...DELETED_ENV_KEYS].sort()).toEqual(
      [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "AWS_BEARER_TOKEN_BEDROCK",
        "CODEX_ACCESS_TOKEN",
        "CODEX_API_KEY",
        "FACTORY_API_BASE_URL",
        "FACTORY_API_BASE_URL_EU",
        "FACTORY_API_KEY",
        "FACTORY_HOME_OVERRIDE",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "OPENROUTER_API_KEY",
        "RAILWAY_ENVIRONMENT_NAME",
        "STRIPE_SECRET_KEY",
        "STRIPE_WEBHOOK_SECRET",
        "VERCEL_TOKEN",
      ].sort(),
    );
  });

  it("removes every CLAUDE_CODE_USE_ key but keeps the subscription token and PATH", () => {
    expect(DELETED_ENV_PREFIXES).toEqual(["CLAUDE_CODE_USE_"]);
    const env = buildChildEnv(
      {
        PATH: "/opt/homebrew/bin:/bin",
        CLAUDE_CODE_OAUTH_TOKEN: "subscription",
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_USE_VERTEX: "1",
        CLAUDE_CODE_USE_FOUNDRY: "1",
      },
      { CLAUDE_CODE_USE_BEDROCK: "again" },
    );
    expect(env).toEqual({ PATH: "/opt/homebrew/bin:/bin", CLAUDE_CODE_OAUTH_TOKEN: "subscription" });
  });

  it("drops an inherited ELECTRON_RUN_AS_NODE but keeps an explicit one", () => {
    expect(buildChildEnv({ ELECTRON_RUN_AS_NODE: "1" })).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    expect(buildChildEnv({}, { ELECTRON_RUN_AS_NODE: "1" }).ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("removes a key when the override is undefined", () => {
    expect(buildChildEnv({ A: "1" }, { A: undefined })).not.toHaveProperty("A");
  });
});
