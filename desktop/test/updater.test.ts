import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false } }));
vi.mock("electron-updater", () => ({ autoUpdater: {} }));

const { shouldCheckForUpdates } = await import("../src/main/updater");

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "skynet-updater-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("shouldCheckForUpdates", () => {
  it("skips a dir build that has no app-update.yml", () => {
    expect(shouldCheckForUpdates({ isPackaged: true, resourcesPath: dir, env: {} })).toBe(false);
  });

  it("checks a packaged build with app-update.yml", () => {
    fs.writeFileSync(path.join(dir, "app-update.yml"), "provider: github\n");
    expect(shouldCheckForUpdates({ isPackaged: true, resourcesPath: dir, env: {} })).toBe(true);
  });

  it("skips an unpackaged app and the opt-out", () => {
    fs.writeFileSync(path.join(dir, "app-update.yml"), "provider: github\n");
    expect(shouldCheckForUpdates({ isPackaged: false, resourcesPath: dir, env: {} })).toBe(false);
    expect(shouldCheckForUpdates({ isPackaged: true, resourcesPath: dir, env: { SKYNET_DESKTOP_NO_UPDATE: "1" } })).toBe(false);
  });
});
