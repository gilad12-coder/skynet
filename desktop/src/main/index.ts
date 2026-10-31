import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, clipboard, ipcMain, nativeTheme, shell } from "electron";
import { childPath, probeClis, probeDocker, readCliLimits, searchDirs } from "./cli-detect";
import { allocatePorts, type PortPlan } from "./ports";
import { holdQuitUntilStopped } from "./quit";
import { databaseUrl, removeSandboxContainers, startPostgres, stopPostgres, type DockerCtx } from "./postgres";
import { ensureSandboxImage } from "./sandbox-image";
import { ensurePrivateDir, loadOrCreateSecrets } from "./secrets";
import { clearPids, psStartOf, recordPid, sweepOrphans } from "./stack-pids";
import { buildChildEnv, loginShellPath } from "./shell-env";
import {
  computeOnboardingState,
  httpStatus,
  killActiveCommands,
  ManagedProcess,
  runCommand,
  waitFor,
  type OnboardingState,
} from "./supervisor";
import { startUpdateCheck } from "./updater";

const dataDir = process.env.SKYNET_DESKTOP_DATA_DIR || app.getPath("userData");
const logsDir = path.join(dataDir, "logs");
const localStateDir = path.join(dataDir, "local");
ensurePrivateDir(dataDir);
fs.mkdirSync(logsDir, { recursive: true });
fs.mkdirSync(localStateDir, { recursive: true });
const desktopLog = fs.createWriteStream(path.join(logsDir, "desktop.log"), { flags: "a" });

function log(line: string): void {
  desktopLog.write(`${new Date().toISOString()} ${line}\n`);
}

/** Bundled stack: inside the .app when packaged, `desktop/stage` in development. */
const resourcesDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, "..", "..", "stage");
const uvBin = app.isPackaged
  ? path.join(resourcesDir, "uv", "uv")
  : path.join(resourcesDir, "uv", process.arch === "arm64" ? "arm64" : "x64", "uv");

if (process.env.SKYNET_DESKTOP_THEME === "light" || process.env.SKYNET_DESKTOP_THEME === "dark") {
  nativeTheme.themeSource = process.env.SKYNET_DESKTOP_THEME;
}

// The web app picks its language from Accept-Language, which Chromium takes
// from its own locale (the system language). A forced onboarding language must
// change that locale too, or the web app stays in the system language.
if (process.env.SKYNET_DESKTOP_LANG === "en" || process.env.SKYNET_DESKTOP_LANG === "he") {
  app.commandLine.appendSwitch("lang", process.env.SKYNET_DESKTOP_LANG);
}

let win: BrowserWindow | null = null;
let state: OnboardingState = { kind: "checking", clis: [], docker: null };
let acceptedRateCap = false;
let busy = false;
let quitting = false;
let dockerCtx: DockerCtx | null = null;
let api: ManagedProcess | null = null;
let frontend: ManagedProcess | null = null;
let postgresStarted = false;
let frontendUrl: string | null = null;
let sweptOrphans = false;
let sweptSandboxes = false;

function setState(next: OnboardingState): void {
  state = next;
  log(`state ${next.kind}${next.step ? ` (${next.step})` : ""}${next.error ? `: ${next.error}` : ""}`);
  win?.webContents.send("onboarding:state", state);
}

function locale(): "en" | "he" {
  const forced = process.env.SKYNET_DESKTOP_LANG;
  if (forced === "en" || forced === "he") return forced;
  return app.getLocale().toLowerCase().startsWith("he") ? "he" : "en";
}

function showOnboarding(): void {
  void win?.loadFile(path.join(__dirname, "..", "renderer", "index.html"), { query: { lang: locale() } });
}

/**
 * Copy the bundled backend and frontend into Application Support once per
 * bundle. uv writes build metadata next to pyproject.toml and Next writes its
 * cache under .next, and neither may write inside the signed .app.
 */
function stageRuntime(): { backendDir: string; frontendDir: string; bundleId: string } {
  const bundleId = fs.readFileSync(path.join(resourcesDir, "bundle-id.txt"), "utf8").trim();
  const runtimeRoot = path.join(dataDir, "runtime");
  const target = path.join(runtimeRoot, bundleId);
  const marker = path.join(target, ".complete");
  if (!fs.existsSync(marker)) {
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    fs.cpSync(path.join(resourcesDir, "backend"), path.join(target, "backend"), { recursive: true });
    fs.cpSync(path.join(resourcesDir, "frontend"), path.join(target, "frontend"), { recursive: true, verbatimSymlinks: true });
    fs.writeFileSync(marker, bundleId);
  }
  for (const old of fs.readdirSync(runtimeRoot)) {
    if (old !== bundleId) fs.rmSync(path.join(runtimeRoot, old), { recursive: true, force: true });
  }
  return { backendDir: path.join(target, "backend"), frontendDir: path.join(target, "frontend"), bundleId };
}

async function check(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    if (!sweptOrphans) {
      // Before stopStack, which deletes the pid file. Ports held by a crashed session are freed before allocatePorts.
      sweptOrphans = true;
      await sweepOrphans(dataDir, {
        startOf: psStartOf,
        kill: (target, sig) => process.kill(target, sig),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        log,
      });
    }
    await stopStack();
    setState({ kind: "checking", clis: [], docker: null });
    const login = await loginShellPath();
    const loginPath = childPath(login.path);
    const env = buildChildEnv(process.env, { PATH: loginPath });
    const dirs = searchDirs(login.path);
    const [docker, clis] = await Promise.all([probeDocker(dirs, env), probeClis(dirs, env)]);
    const next = computeOnboardingState({
      docker,
      clis,
      limits: readCliLimits(localStateDir),
      now: new Date(),
      acceptedRateCap,
    });
    setState(next);
    if (next.kind !== "starting") return;
    dockerCtx = { docker: docker.path as string, env };
    if (!sweptSandboxes) {
      // Job containers from a crashed session are not removed by its quit path.
      sweptSandboxes = true;
      await removeSandboxContainers(dockerCtx);
    }
    await startStack(next, loginPath);
  } catch (err) {
    if (quitting) return;
    const message = err instanceof Error ? err.message : String(err);
    setState({ ...state, kind: "error", error: message });
    await stopStack();
  } finally {
    busy = false;
  }
}

async function startStack(base: OnboardingState, loginPath: string): Promise<void> {
  const step = (name: string) => {
    // A quit during first-launch setup must not start the next service after shutdown ran.
    if (quitting) throw new Error("Skynet is quitting");
    setState({ ...base, kind: "starting", step: name });
  };
  const ctx = dockerCtx as DockerCtx;
  const binEnv: Record<string, string> = { APP_DOCKER_BIN: ctx.docker };
  for (const cli of base.clis) {
    if (cli.path && cli.versionOk) binEnv[`APP_${cli.id.toUpperCase()}_BIN`] = cli.path;
  }

  step("secrets");
  const { secrets, created, replacedLegacy } = loadOrCreateSecrets(dataDir);
  log(created ? "created new local secrets" : "reused local secrets");
  if (replacedLegacy) log("replaced the keychain-encrypted secrets.bin; Postgres gets the new password");
  const ports: PortPlan = await allocatePorts();
  log(`ports api=${ports.api} frontend=${ports.frontend} postgres=${ports.postgres}`);

  step("runtime");
  const { backendDir, frontendDir, bundleId } = stageRuntime();

  step("postgres");
  postgresStarted = true;
  await startPostgres(ctx, ports.postgres, secrets.pgPassword);

  step("sandbox");
  const sandboxImage = await ensureSandboxImage(ctx, backendDir, bundleId, path.join(logsDir, "sandbox-build.log"));

  const feOrigin = `http://127.0.0.1:${ports.frontend}`;
  const apiOrigin = `http://127.0.0.1:${ports.api}`;
  const uvEnv = buildChildEnv(process.env, {
    PATH: loginPath,
    UV_PROJECT_ENVIRONMENT: path.join(dataDir, "venv"),
    UV_NO_PROGRESS: "1",
    PYTHONPYCACHEPREFIX: path.join(dataDir, "pycache"),
    APP_LOCAL_MODE: "1",
    API_HOST: "127.0.0.1",
    API_PORT: String(ports.api),
    // The backend reads API_PORT first and falls back to PORT. buildChildEnv
    // drops an inherited PORT, and this pins it to the same port, so the two
    // never disagree.
    PORT: String(ports.api),
    WORKER_ENABLED: "true",
    REMOTE_DB_URL: databaseUrl(secrets.pgPassword, ports.postgres),
    BACKEND_AUTH_SECRET: secrets.backendAuthSecret,
    ALLOWED_ORIGINS: feOrigin,
    APP_LOCAL_STATE_DIR: localStateDir,
    APP_LOCAL_SANDBOX_IMAGE: sandboxImage,
    ...binEnv,
  });

  step("python");
  const migrateLog = fs.createWriteStream(path.join(logsDir, "migrate.log"), { flags: "a" });
  try {
    const sync = await runCommand(uvBin, ["sync", "--frozen"], { env: uvEnv, cwd: backendDir, timeoutMs: 45 * 60_000, log: migrateLog });
    if (sync.code !== 0) throw new Error(`uv sync failed; see ${path.join(logsDir, "migrate.log")}`);
    step("migrations");
    const migrate = await runCommand(uvBin, ["run", "--frozen", "alembic", "upgrade", "head"], {
      env: uvEnv,
      cwd: backendDir,
      timeoutMs: 10 * 60_000,
      log: migrateLog,
    });
    if (migrate.code !== 0) throw new Error(`Database migrations failed; see ${path.join(logsDir, "migrate.log")}`);
  } finally {
    migrateLog.end();
  }

  step("api");
  const apiArgs = ["run", "--frozen", "python", "main.py"];
  api = new ManagedProcess("api", uvBin, apiArgs, {
    env: uvEnv,
    cwd: backendDir,
    logFile: path.join(logsDir, "api.log"),
  });
  api.start();
  recordStarted("api", api.pid);
  const apiProc = api;
  await waitFor("The API", async () => (await httpStatus(`${apiOrigin}/health`)) === 200, {
    timeoutMs: 180_000,
    alive: () => !apiProc.exited,
  });

  step("frontend");
  frontend = new ManagedProcess("frontend", process.execPath, ["server.js"], {
    env: buildChildEnv(process.env, {
      PATH: loginPath,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      PORT: String(ports.frontend),
      HOSTNAME: "127.0.0.1",
      APP_LOCAL_MODE: "1",
      API_URL: apiOrigin,
      AUTH_SECRET: secrets.authSecret,
      BACKEND_AUTH_SECRET: secrets.backendAuthSecret,
      AUTH_URL: feOrigin,
    }),
    cwd: frontendDir,
    logFile: path.join(logsDir, "frontend.log"),
  });
  frontend.start();
  recordStarted("frontend", frontend.pid);
  const feProc = frontend;
  await waitFor("The web app", async () => (await httpStatus(`${feOrigin}/api/auth/session`)) === 200, {
    timeoutMs: 120_000,
    alive: () => !feProc.exited,
  });

  if (quitting) return;
  frontendUrl = feOrigin;
  setState({ ...base, kind: "ready", url: feOrigin });
  watchForCrash(apiProc, "The API");
  watchForCrash(feProc, "The web app");
  await win?.loadURL(feOrigin);
}

function watchForCrash(proc: ManagedProcess, label: string): void {
  const timer = setInterval(() => {
    if (quitting || state.kind !== "ready") return clearInterval(timer);
    if (!proc.exited) return;
    clearInterval(timer);
    frontendUrl = null;
    showOnboarding();
    setState({ ...state, kind: "error", error: `${label} stopped unexpectedly (exit ${proc.exitCode}). See ${logsDir}.` });
  }, 1_000);
}

function recordStarted(role: string, pid: number | undefined): void {
  const started = pid ? psStartOf(pid) : null;
  if (pid && started) recordPid(dataDir, { role, pgid: pid, started });
}

/** Stop in §1.7 order: frontend, API, Postgres, then sandbox containers. */
async function stopStack(): Promise<void> {
  killActiveCommands();
  const fe = frontend;
  const be = api;
  frontend = null;
  api = null;
  frontendUrl = null;
  await fe?.stop();
  await be?.stop();
  if (dockerCtx && postgresStarted) {
    await stopPostgres(dockerCtx);
    await removeSandboxContainers(dockerCtx);
  }
  postgresStarted = false;
  clearPids(dataDir);
}

function isAllowedUrl(target: string): boolean {
  if (target.startsWith("file://")) return true;
  if (frontendUrl === null) return false;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  // Next.js builds callbackUrl with "localhost" even though the server binds 127.0.0.1.
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
    url.port === new URL(frontendUrl).port
  );
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "Skynet",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1814" : "#f5f0ea",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once("ready-to-show", () => win?.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !isAllowedUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (isAllowedUrl(url)) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
  win.on("closed", () => {
    win = null;
  });
  showOnboarding();
}

ipcMain.handle("onboarding:get-state", () => state);
ipcMain.handle("onboarding:recheck", () => {
  void check();
});
ipcMain.handle("onboarding:continue", () => {
  acceptedRateCap = true;
  void check();
});
ipcMain.handle("onboarding:copy", (_event, text: unknown) => {
  if (typeof text === "string" && text.length < 500) clipboard.writeText(text);
});
ipcMain.handle("onboarding:open-logs", () => shell.openPath(logsDir));
ipcMain.handle("onboarding:open-docker", () => shell.openExternal("https://www.docker.com/products/docker-desktop/"));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
  app.whenReady().then(() => {
    log(`Skynet desktop ${app.getVersion()} starting`);
    createWindow();
    win?.webContents.once("did-finish-load", () => void check());
    startUpdateCheck(log);
  });
  app.on("window-all-closed", () => app.quit());
  app.on(
    "before-quit",
    holdQuitUntilStopped(() => {
      quitting = true;
      stopStack()
        .catch((err: Error) => log(`shutdown error: ${err.message}`))
        .finally(() => {
          log("stopped");
          desktopLog.end(() => app.exit(0));
        });
    }),
  );
}
