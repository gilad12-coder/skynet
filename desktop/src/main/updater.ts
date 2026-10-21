import { app } from "electron";
import { autoUpdater } from "electron-updater";

/**
 * Check GitHub releases for a newer build. Only packaged apps check, and
 * `SKYNET_DESKTOP_NO_UPDATE=1` turns it off. An ad-hoc signed app cannot pass
 * Squirrel.Mac's signature check, so on those builds the download fails; the
 * error is logged and the app keeps running.
 */
export function startUpdateCheck(log: (line: string) => void): void {
  if (!app.isPackaged || process.env.SKYNET_DESKTOP_NO_UPDATE === "1") return;
  autoUpdater.autoDownload = true;
  autoUpdater.logger = null;
  autoUpdater.on("error", (err) => log(`update check failed: ${err.message}`));
  autoUpdater.checkForUpdatesAndNotify().catch((err: Error) => log(`update check failed: ${err.message}`));
}
