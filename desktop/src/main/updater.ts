import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { autoUpdater } from "electron-updater";

/**
 * Whether this build can check for updates. electron-builder writes
 * app-update.yml only for the dmg and zip targets; a `--dir` build has none,
 * and electron-updater then fails with ENOENT.
 */
export function shouldCheckForUpdates(opts: {
  isPackaged: boolean;
  resourcesPath: string;
  env: NodeJS.ProcessEnv;
}): boolean {
  if (!opts.isPackaged || opts.env.SKYNET_DESKTOP_NO_UPDATE === "1") return false;
  return fs.existsSync(path.join(opts.resourcesPath, "app-update.yml"));
}

/**
 * Check GitHub releases for a newer build. Only packaged apps with an
 * app-update.yml check, and `SKYNET_DESKTOP_NO_UPDATE=1` turns it off. An
 * ad-hoc signed app cannot pass Squirrel.Mac's signature check, so on those
 * builds the download fails; the error is logged and the app keeps running.
 */
export function startUpdateCheck(log: (line: string) => void): void {
  if (!shouldCheckForUpdates({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, env: process.env })) {
    if (app.isPackaged) log("update check skipped");
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.logger = null;
  autoUpdater.on("error", (err) => log(`update check failed: ${err.message}`));
  autoUpdater.checkForUpdatesAndNotify().catch((err: Error) => log(`update check failed: ${err.message}`));
}
