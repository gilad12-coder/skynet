// Example reel flow: the IDE opens from Metric & run and closes cleanly.
//   PR=715 node ~/.agents/skills/reel/bin/reel.mjs run tools/reel-skynet/examples/ide-smoke.mjs --out <scratch>/ide-smoke
import { startReel } from "reel";
import {
  closeIde,
  deployedSha,
  ideToolbar,
  newManualTask,
  openIde,
  previewUrl,
  signup,
  toMetricAndRun,
  waitForPreview,
} from "../skynet.mjs";

const pr = process.env.PR ?? "715";
console.log("deploys", await waitForPreview(pr));

const r = await startReel({ url: `${previewUrl(pr)}/login` });
const { page } = r;
console.log("frontend sha", await deployedSha(page));

r.fast(6);
r.mark("Setup: fresh account, a Manual prompt task and 12 tickets");
await signup(page, { tag: `rec${pr}` });
await newManualTask(page);
await toMetricAndRun(page);

r.normal();
r.mark("Open IDE turns the workspace into a full-screen VS Code");
console.log("boot ms", await openIde(page));
await page.waitForTimeout(1500);
await r.still("ide-toolbar", { locator: ideToolbar(page) });
await r.hoverStill(ideToolbar(page).getByRole("button", { name: /^Check$/ }), "check-tooltip");

r.mark("Back to the wizard returns to Metric & run");
await closeIde(page);
await page.waitForTimeout(1500);
await r.still("wizard-after-close");
