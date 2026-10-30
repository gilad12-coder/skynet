// Skynet helpers for reel flows (see ./SKILL.md). Each takes the reel `page`.
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

export const TICKETS_CSV = fileURLToPath(new URL("./fixtures/tickets.csv", import.meta.url));

const WORKBENCH = ".monaco-workbench";

export const STAGING_URL = "https://staging.skynetml.com";

/** The PR preview frontend (SKY-164). Its API is `https://api-pr-<n>.staging.skynetml.com`. */
export const previewUrl = (pr) => `https://pr-${pr}.staging.skynetml.com`;

/** The backend that serves the frontend `origin`: a PR preview, AWS staging or local dev. */
function apiFor(origin) {
  const host = new URL(origin).hostname;
  if (/^pr-\d+\.staging\.skynetml\.com$/.test(host)) return `https://api-${host}`;
  return origin === STAGING_URL ? "https://api-staging.skynetml.com" : "http://localhost:8000";
}

async function servedCommit(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    return res.ok ? ((await res.json()).commit ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Wait until the PR preview serves `sha` on both the backend (`/health`) and
 * the frontend (`/api/version`). Without `sha`, wait until both answer.
 * Returns `{ backend, frontend }` (commit SHAs). Throws after `timeoutMs`.
 */
export async function waitForPreview(pr, { sha, timeoutMs = 20 * 60_000 } = {}) {
  const app = previewUrl(pr);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const served = {
      backend: await servedCommit(`${apiFor(app)}/health`),
      frontend: await servedCommit(`${app}/api/version`),
    };
    const ok = sha ? served.backend === sha && served.frontend === sha : served.backend && served.frontend;
    if (ok) return served;
    if (Date.now() > deadline) {
      throw new Error(`preview ${app} is not ready: ${JSON.stringify(served)}. See the PR's preview comment and run.`);
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

function origin(page) {
  const url = page.url();
  if (!url.startsWith("http")) throw new Error("navigate to the app first, e.g. startReel({ url: STAGING_URL + '/login' })");
  return new URL(url).origin;
}

/** The commit the frontend was built from, read from the login page's "Source code" link. */
export async function deployedSha(page) {
  await page.goto(`${origin(page)}/login`, { waitUntil: "load" });
  const href = await page.getByRole("link", { name: /^Source code/ }).getAttribute("href");
  return href.match(/\/tree\/([0-9a-f]{7,40})/)?.[1] ?? null;
}

/**
 * Register a throwaway account (recNNN-<random>@example.com, $0 credit),
 * sign the page in, set English and skip the experience intake. Never buy credit.
 * Local dev with SMTP unset only: staging requires an email code, so sign-in fails.
 * Returns { email, password }.
 */
export async function signup(page, { tag = "rec" } = {}) {
  const base = origin(page);
  const email = `${tag}-${randomBytes(5).toString("hex")}@example.com`;
  const password = randomBytes(16).toString("hex");
  const req = page.request;
  const reg = await req.post(`${base}/api/register`, { data: { email, password, name: "Reel" } });
  if (!reg.ok()) throw new Error(`register ${reg.status()}: ${await reg.text()}`);
  const { csrfToken } = await (await req.get(`${base}/api/auth/csrf`)).json();
  await req.post(`${base}/api/auth/callback/credentials`, {
    form: { email, password, csrfToken, callbackUrl: `${base}/`, json: "true" },
  });
  const session = await (await req.get(`${base}/api/auth/session`)).json();
  if (!session?.backendAccessToken) throw new Error("sign-in failed: no session after register");
  // Expert level with the intake done, so no onboarding tour covers the wizard.
  const lv = await req.patch(`${apiFor(base)}/account/experience`, {
    headers: { Authorization: `Bearer ${session.backendAccessToken}` },
    data: { level: "expert", intake_completed: true },
  });
  if (!lv.ok()) throw new Error(`experience ${lv.status()}`);
  await page.context().addCookies([
    { name: "NEXT_LOCALE", value: "en", url: base },
    { name: "app_locale", value: "en", url: base },
    // Builds from before the internal rename only read the old cookie name.
    { name: "skynet_locale", value: "en", url: base },
  ]);
  console.log(`signup ${email}`);
  return { email, password };
}

const next = async (page) => {
  await page.getByRole("button", { name: /^Continue$/ }).click();
  await page.waitForTimeout(1500);
};

/** Start a Manual prompt task in the wizard and upload `csvPath`; ends on the Inputs step. */
export async function newManualTask(
  page,
  {
    objective = "Classify customer support tickets into billing, technical or account.",
    background = "Answer with exactly one lowercase word.",
    prompt = "Read the support ticket and answer with one word: billing, technical or account.",
    csvPath = TICKETS_CSV,
  } = {},
) {
  await page.goto(`${origin(page)}/submit`, { waitUntil: "load", timeout: 90_000 });
  const manual = page.getByText("Manual", { exact: true }).first();
  await manual.waitFor({ timeout: 90_000 });
  await manual.click();
  await page.getByPlaceholder("What the optimized artifact should do well").fill(objective);
  await page.getByPlaceholder("Context, constraints and what a good result looks like").fill(background);
  await next(page);
  await page.getByText("Prompt", { exact: true }).first().click();
  await page.getByPlaceholder("Paste the current version, or let the assistant draft one").fill(prompt);
  await next(page);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByText(/^Upload a CSV/).first().click()]);
  await chooser.setFiles(csvPath);
  await page.getByText("How to read the data").waitFor({ timeout: 60_000 });
  await page.waitForTimeout(2000);
}

/** The IDE: the inline section in Metric & run, or the full-screen pop-up, around the workbench host. */
export const ide = (page) =>
  page.locator("[data-ide-host]").locator('xpath=ancestor::*[self::section or @role="dialog"][1]');

/** The IDE header: the Check and Full screen / Exit full screen icon buttons. */
export const ideToolbar = (page) => ide(page).locator("header");

/** The coding agent's chat, docked on the right of the IDE (about 320px wide). */
export const agentPanel = (page) => ide(page).locator("aside");

/** The agent composer's textbox ("Ask the coding agent…"). */
export const agentInput = (page) => agentPanel(page).getByPlaceholder("Ask the coding agent…");

/**
 * Continue from the current wizard step to "Metric & run" and wait until the inline
 * IDE's file explorer lists run.py. Returns ms from arriving on the step to the explorer.
 */
export async function toMetricAndRun(page) {
  const host = page.locator("[data-ide-host]");
  for (let i = 0; i < 6 && !(await host.isVisible()); i++) await next(page);
  await host.waitFor({ timeout: 30_000 });
  const t = Date.now();
  await page
    .locator(`${WORKBENCH} .explorer-folders-view .monaco-list-row`, { hasText: "run.py" })
    .first()
    .waitFor({ timeout: 120_000 });
  return Date.now() - t;
}

const ZOOM_SETTLE_MS = 220 + 200; // the IDE's zoom animation (ZOOM_MS) plus a relayout

/** Full screen: the inline IDE grows into a pop-up over the page. Waits for the animation. */
export async function enterFullScreen(page) {
  await ideToolbar(page).getByRole("button", { name: "Full screen", exact: true }).click();
  await page.locator('[role="dialog"]:has([data-ide-host])').waitFor();
  await page.waitForTimeout(ZOOM_SETTLE_MS);
}

/** Exit full screen: the pop-up shrinks back into the step. Waits for the animation. */
export async function exitFullScreen(page) {
  await ideToolbar(page).getByRole("button", { name: "Exit full screen", exact: true }).click();
  await page.locator('[role="dialog"]:has([data-ide-host])').waitFor({ state: "detached", timeout: 10_000 });
  await page.waitForTimeout(ZOOM_SETTLE_MS - 220);
}

/**
 * Wait until the coding agent is not running a turn (its Stop button is gone).
 * Gives a turn `startMs` to begin first, so call it right after sending or arriving.
 */
export async function waitForAgentIdle(page, { startMs = 10_000, timeout = 300_000 } = {}) {
  const stop = agentPanel(page).getByRole("button", { name: "Stop", exact: true });
  await stop.waitFor({ timeout: startMs }).catch(() => undefined);
  await stop.waitFor({ state: "hidden", timeout });
}

/** Ask the coding agent something and wait for its reply to finish. */
export async function askAgent(page, text, opts) {
  await agentInput(page).fill(text);
  await agentPanel(page).getByRole("button", { name: "Send", exact: true }).click();
  await waitForAgentIdle(page, opts);
}
