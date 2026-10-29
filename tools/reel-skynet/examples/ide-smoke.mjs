// Example reel flow: Metric & run is an inline IDE, the coding agent starts on its own,
// and Full screen grows the IDE into a pop-up and back.
//   PR=715 node ~/.agents/skills/reel/bin/reel.mjs run tools/reel-skynet/examples/ide-smoke.mjs --out <scratch>/ide-smoke
import { startReel } from "reel";
import {
  agentPanel,
  deployedSha,
  enterFullScreen,
  exitFullScreen,
  ideToolbar,
  newManualTask,
  STAGING_URL,
  signup,
  toMetricAndRun,
  waitForAgentIdle,
} from "../skynet.mjs";

const pr = process.env.PR ?? "715";
const r = await startReel({ url: `${STAGING_URL}/login` });
const { page } = r;
console.log("frontend sha", await deployedSha(page));

r.fast(6);
r.mark("Setup: fresh account, a Manual prompt task and 12 tickets");
await signup(page, { tag: `rec${pr}` });
await newManualTask(page);

r.normal();
r.mark("Metric & run is the IDE: explorer, editor and the coding agent");
console.log("boot ms", await toMetricAndRun(page));
await page.waitForTimeout(1500);
await r.still("ide-toolbar", { locator: ideToolbar(page) });

r.fast(4);
r.mark("The coding agent writes run.py and metric.py on its own");
await waitForAgentIdle(page);
r.normal();
await r.still("agent-reply", { locator: agentPanel(page) });

r.mark("Full screen grows the IDE over the page, and back");
await enterFullScreen(page);
await page.waitForTimeout(1500);
await exitFullScreen(page);
await page.waitForTimeout(1500);
await r.still("after-full-screen");
