import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LEGACY_SECRETS_FILE, loadOrCreateSecrets, SECRETS_FILE } from "../src/main/secrets";
import { PG_PASSWORD_VAR, setPasswordArgs } from "../src/main/postgres";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "skynet-secrets-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const mode = (file: string) => fs.statSync(file).mode & 0o777;

describe("loadOrCreateSecrets", () => {
  it("creates a 0600 JSON file and reuses it on the next launch", () => {
    const data = path.join(dir, "Skynet");
    const first = loadOrCreateSecrets(data);
    expect(first.created).toBe(true);
    expect(first.replacedLegacy).toBe(false);
    const file = path.join(data, SECRETS_FILE);
    expect(mode(file)).toBe(0o600);
    expect(mode(data)).toBe(0o700);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(first.secrets);
    for (const value of Object.values(first.secrets)) expect(value.length).toBeGreaterThanOrEqual(32);

    const second = loadOrCreateSecrets(data);
    expect(second).toEqual({ secrets: first.secrets, created: false, replacedLegacy: false });
  });

  it("does not use the keychain", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "main", "secrets.ts"), "utf8");
    expect(source).not.toMatch(/from "electron"/);
    expect(source).not.toMatch(/safeStorage\./);
  });

  it("replaces a legacy secrets.bin without reading it", () => {
    const legacy = path.join(dir, LEGACY_SECRETS_FILE);
    fs.writeFileSync(legacy, Buffer.from("v10-not-decryptable-here"), { mode: 0o600 });
    const result = loadOrCreateSecrets(dir);
    expect(result.created).toBe(true);
    expect(result.replacedLegacy).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(path.join(dir, SECRETS_FILE))).toBe(true);
  });

  it("tightens a widened file mode", () => {
    loadOrCreateSecrets(dir);
    const file = path.join(dir, SECRETS_FILE);
    fs.chmodSync(file, 0o644);
    loadOrCreateSecrets(dir);
    expect(mode(file)).toBe(0o600);
  });

  it("refuses an incomplete file and keeps it", () => {
    const file = path.join(dir, SECRETS_FILE);
    fs.writeFileSync(file, JSON.stringify({ pgPassword: "short" }), { mode: 0o600 });
    expect(() => loadOrCreateSecrets(dir)).toThrow(/incomplete/);
    expect(fs.readFileSync(file, "utf8")).toContain("short");
  });

  it("ignores a stale temp file from a crashed write", () => {
    fs.writeFileSync(path.join(dir, `${SECRETS_FILE}.tmp`), "{");
    expect(loadOrCreateSecrets(dir).created).toBe(true);
    expect(fs.existsSync(path.join(dir, `${SECRETS_FILE}.tmp`))).toBe(false);
  });
});

describe("setPasswordArgs", () => {
  it("passes the password by environment name, never in argv", () => {
    const args = setPasswordArgs();
    expect(args.slice(0, 4)).toEqual(["exec", "-e", PG_PASSWORD_VAR, "skynet-local-postgres"]);
    const script = args[args.length - 1];
    expect(script).toContain(`\\getenv pw ${PG_PASSWORD_VAR}`);
    expect(script).toContain("ALTER ROLE CURRENT_USER PASSWORD :'pw';");
    expect(script).toContain("ON_ERROR_STOP=1");
  });
});
