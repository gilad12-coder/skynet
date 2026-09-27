/**
 * Tutorial System — Step Definitions
 * Skynet prompt optimization platform
 *
 * Focused, replayable walkthroughs for the product's main user workflows.
 * Works even for users with zero optimizations.
 */

import {
  resetDemoSimulation,
  DEMO_BLACKBOX_OPTIMIZATION_ID,
  DEMO_BLACKBOX_SCORER_CODE,
  DEMO_BLACKBOX_SEED_TEXT,
  DEMO_DATASET_ID,
  DEMO_METRIC_CODE,
  DEMO_OPTIMIZATION_ID,
  DEMO_SIGNATURE_CODE,
  getCachedDemoDashboardAnalytics,
  getCachedDemoDashboardJobs,
  getCachedDemoExplorePoints,
  getDemoDatasets,
} from "./demo-data";
import { TERMS } from "@/shared/lib/terms";
import { formatMsg, msg } from "@/shared/lib/messages";
import { perLocale } from "@/shared/lib/per-locale";
import { PHONE_MEDIA_QUERY } from "@/shared/lib/device-class";
import { TUTORIAL_SUBMIT_SPLASH_MS } from "./tutorial-timing";

/**
 * The short end-to-end path plus four focused workflow guides.
 *
 * Keeping each guide narrow makes the tutorial useful after onboarding too:
 * users can replay only the part they need instead of stepping through the
 * entire application again.
 */
export type TutorialTrack = "quick" | "anything" | "data" | "results" | "workspace";

const QUICK_ONLY: readonly TutorialTrack[] = ["quick"];
const QUICK_AND_RESULTS: readonly TutorialTrack[] = ["quick", "results"];
const QUICK_AND_ANYTHING: readonly TutorialTrack[] = ["quick", "anything"];
const ANYTHING_ONLY: readonly TutorialTrack[] = ["anything"];
const DATA_ONLY: readonly TutorialTrack[] = ["data"];
const RESULTS_ONLY: readonly TutorialTrack[] = ["results"];
const WORKSPACE_ONLY: readonly TutorialTrack[] = ["workspace"];

export interface TutorialStep {
  id: string;
  title: string;
  description: string;
  target: string;
  placement?: "top" | "bottom" | "left" | "right" | "auto";
  /** Vertical nudge in pixels — positive moves the card down, negative up. Used to de-overlap dense sections. */
  offsetY?: number;
  /** Override the default popover height (260px) for steps that need more breathing room. */
  popoverHeight?: number;
  /** Override spotlight padding (default 8) for this step. */
  highlightPadding?: number;
  /** Override spotlight border radius (default 12) for this step. */
  highlightRadius?: number;
  beforeShow?: () => void | Promise<void>;
  /**
   * Best-effort UI cleanup fired when the step is left (PREV / NEXT / exit).
   * Use to undo sticky state the step set (e.g. selected rows, query strings,
   * optimizer choice) so traversal doesn't accumulate. Fire-and-forget —
   * the return value is not awaited.
   */
  afterHide?: () => void | Promise<void>;
  /** Focused guides that include this step. */
  tracks: readonly TutorialTrack[];
  readingTimeSec: number;
}

export interface TutorialTrackDefinition {
  id: TutorialTrack;
  name: string;
  description: string;
  icon: string;
  stepCount: number;
  /** Rounded wall-clock estimate, for setting expectations before starting. */
  estimatedMinutes: number;
  steps: TutorialStep[];
}

import {
  callTutorialHook,
  hasTutorialHook,
  setTutorialNavigating,
  queryTutorialHook,
  waitForHook,
} from "./bridge";
import { isGeneralistAgentEnabled } from "@/features/agent-panel";
import { WIZARD_STAGE } from "@/features/submit";

function navigateTo(path: string) {
  // Prefer in-app client navigation via the tutorial-overlay hook.
  // Fall back to a full reload if no overlay is mounted (e.g. tests).
  if (hasTutorialHook("routerPush")) {
    callTutorialHook("routerPush", path);
  } else {
    setTutorialNavigating(true);
    window.location.href = path;
  }
}

/**
 * Wait for a selector to appear and have layout (non-zero rect) — handles
 * route + wizard + AnimatePresence transitions where the element exists
 * in the DOM but is still at 0×0 during the enter animation.
 */
function isElementVisible(selector: string): boolean {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function waitForElement(selector: string, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    if (isElementVisible(selector)) {
      resolve(true);
      return;
    }
    const start = Date.now();
    const check = () => {
      if (isElementVisible(selector)) {
        resolve(true);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        resolve(false);
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
}

/**
 * Wait until an element's rect is unchanged across two consecutive frames, so
 * a spring-in (e.g. the selection bar) is measured at its resting position.
 */
function waitForStableRect(selector: string, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    let prev: DOMRect | null = null;
    const check = () => {
      const rect = document.querySelector(selector)?.getBoundingClientRect() ?? null;
      const stable =
        !!rect &&
        !!prev &&
        rect.x === prev.x &&
        rect.y === prev.y &&
        rect.width === prev.width &&
        rect.height === prev.height;
      if (stable || Date.now() - start > timeoutMs) {
        resolve();
        return;
      }
      prev = rect;
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
}

/** Show a splash screen identical to the real submit animation */
function showSubmitSplash(): Promise<void> {
  callTutorialHook("showTutorialSplash");
  return new Promise((resolve) => setTimeout(resolve, TUTORIAL_SUBMIT_SPLASH_MS));
}

export function resetTutorialOneShotState(): void {
  // Reserved for future per-tour ephemeral flags. Currently a no-op:
  // the submit splash now keys off path transition (not a one-shot flag),
  // so nothing needs resetting between tour runs.
}

async function ensureDashboard() {
  if (window.location.pathname !== "/") {
    navigateTo("/");
    await waitForElement("[data-tutorial='dashboard-kpis']");
  }
  await waitForHook("setTab");
  // One commit tick so backward arrivals measure after React tab commit
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
}

/** Inject demo jobs + analytics into dashboard for the tutorial — cached “real” data path */
function injectDemoDashboardData() {
  callTutorialHook("setDemoJobs", getCachedDemoDashboardJobs());
  callTutorialHook("setDemoAnalytics", getCachedDemoDashboardAnalytics());
}

async function ensureSubmitPage() {
  if (!window.location.pathname.startsWith("/submit")) navigateTo("/submit");
}

/** `/submit` opens on the recipe picker; the tour asks for it by name. */
async function ensureRecipePicker() {
  await ensureSubmitPage();
  await waitForHook("openTutorialRecipePicker");
  callTutorialHook("openTutorialRecipePicker");
  await waitForElement("[data-tutorial='submit-recipe']");
}

/**
 * No wizard exists until a recipe is chosen, so every wizard step first asks
 * the page for the wizard it belongs to, then waits for that instance's hooks.
 */
async function ensureSubmit(recipe: "program" | "anything") {
  await ensureSubmitPage();
  await waitForHook("openTutorialWizard");
  callTutorialHook("openTutorialWizard", recipe);
  await waitForElement("[data-tutorial='wizard-stepper']");
  await waitForHook("setWizardStep");
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
}

async function ensureDemoDetail(id: string = DEMO_OPTIMIZATION_ID) {
  const path = `/optimizations/${id}`;
  if (window.location.pathname === path) {
    await waitForHook("setDetailTab");
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    return;
  }
  navigateTo(path);
  await waitForElement("[data-tutorial='detail-header']");
  await waitForHook("setDetailTab");
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
}

function setTab(tab: string) {
  callTutorialHook("setTab", tab);
}

function setWizardStep(step: number) {
  callTutorialHook("setWizardStep", step);
}

function setDetailTab(tab: string) {
  callTutorialHook("setDetailTab", tab);
}

function setOptimizerName(name: string) {
  callTutorialHook("setOptimizerName", name);
}

/** A wizard stage is a run of substeps; open the one that holds `field`. */
function showWizardSubstep(stage: keyof typeof WIZARD_STAGE, field?: string) {
  callTutorialHook("showWizardSubstep", stage, field);
  setWizardStep(WIZARD_STAGE[stage]);
}

/** Fill the "Optimize anything" wizard so every stage has something to show. */
function injectBlackboxDemo() {
  callTutorialHook("setCodeAssistMode", "manual");
  callTutorialHook("setBlackboxDemo", {
    seedText: DEMO_BLACKBOX_SEED_TEXT,
    objective: msg("tutorial.demo.blackbox.objective"),
    metricCode: DEMO_BLACKBOX_SCORER_CODE,
  });
}

async function ensureTagger() {
  // A saved session (/tagger/[id]) never shows setup, so leave it for the plain page.
  if (window.location.pathname !== "/tagger") {
    navigateTo("/tagger");
    await waitForHook("setTaggerStartingNew");
    // Force the sessions chooser into setup; no-op if already in setup
    callTutorialHook("setTaggerStartingNew", true);
    await waitForElement("[data-tutorial='tagger-setup']");
  } else if (!hasTutorialHook("setTaggerStep")) {
    // Already on /tagger but still on the sessions panel (startingNew false)
    await waitForHook("setTaggerStartingNew");
    callTutorialHook("setTaggerStartingNew", true);
    await waitForElement("[data-tutorial='tagger-setup']");
  }
  await waitForHook("setTaggerStep");
}

async function ensureExplore() {
  if (window.location.pathname !== "/explore") {
    navigateTo("/explore");
    await waitForElement("[data-tutorial='explore-search']");
  }
  await waitForHook("setDemoExplorePoints");
  callTutorialHook("setDemoExplorePoints", getCachedDemoExplorePoints());
}

/** Open /datasets with a demo card, so a new account's empty library still shows the controls. */
async function ensureDatasets() {
  if (window.location.pathname !== "/datasets") {
    navigateTo("/datasets");
    await waitForElement("[data-tutorial='datasets-library']");
  }
  await waitForHook("setDemoDatasets");
  callTutorialHook("setDemoDatasets", getDemoDatasets());
  await waitForElement("[data-tutorial='datasets-add']");
}

/** Bumped whenever a settings step starts, so a leaving step can tell. */
let settingsOpenRequests = 0;

async function openSettingsTab(tab: string) {
  settingsOpenRequests += 1;
  await ensureDashboard();
  await waitForHook("setSettingsTab");
  callTutorialHook("setSettingsTab", tab);
  await waitForElement(`[data-tutorial='settings-${tab}']`);
}

function closeSettings() {
  callTutorialHook("setSettingsTab", null);
}

/**
 * Close Settings unless the next step reopens it. The overlay runs the next
 * step's beforeShow right after this step's afterHide, so waiting one task
 * shows whether that happened; closing anyway would flicker the modal.
 */
function closeSettingsUnlessReopened() {
  const requests = settingsOpenRequests;
  setTimeout(() => {
    if (settingsOpenRequests === requests) closeSettings();
  }, 0);
}

/** Whether the agent panel was already open before the tour showed it. */
let agentPanelWasOpen = false;

function setGeneralistPanelOpen(open: boolean) {
  callTutorialHook("setGeneralistPanelOpen", open);
}

/** Inject demo data into tagger setup when empty and advance to the requested step */
function injectDemoTaggerData(targetStep: number) {
  if (!queryTutorialHook("hasTaggerData")) {
    const rows = [
      { id: 1, text: msg("auto.features.tutorial.lib.steps.literal.1") },
      { id: 2, text: msg("auto.features.tutorial.lib.steps.literal.2") },
      { id: 3, text: msg("auto.features.tutorial.lib.steps.literal.3") },
      { id: 4, text: msg("auto.features.tutorial.lib.steps.literal.4") },
      { id: 5, text: msg("auto.features.tutorial.lib.steps.literal.5") },
    ];
    callTutorialHook("setTaggerDemoData", {
      rows,
      cols: ["text"],
      textCol: "text",
    });
  }
  callTutorialHook("setTaggerStep", targetStep);
}

/** Inject sample dataset + code into the wizard for the tutorial */
function injectSampleDataset() {
  const rows = [
    { email_text: "Click here to win $1000 now!", category: "spam" },
    { email_text: "Meeting moved to 3pm tomorrow", category: "important" },
    { email_text: "50% off all items this weekend only", category: "promotional" },
    { email_text: "Your quarterly report is ready for review", category: "important" },
    { email_text: "Free gift card waiting for you", category: "spam" },
    { email_text: "Team standup notes from Monday", category: "important" },
  ];
  callTutorialHook("setParsedDataset", {
    columns: ["email_text", "category"],
    rows,
    rowCount: rows.length,
  });
  callTutorialHook("setColumnRoles", {
    email_text: "input",
    category: "output",
  });
  callTutorialHook("setDatasetFileName", "emails_sample.csv");
  callTutorialHook("setSignatureCode", DEMO_SIGNATURE_CODE);
  callTutorialHook("setMetricCode", DEMO_METRIC_CODE);
}

const tutorialSteps: TutorialStep[] = perLocale(() => [
  {
    id: "dd-dataset-add",
    title: msg("tutorial.step.dataset_add.title"),
    description: msg("tutorial.step.dataset_add.body"),
    target: "[data-tutorial='datasets-add']",
    placement: "bottom",
    beforeShow: ensureDatasets,
    tracks: DATA_ONLY,
    readingTimeSec: 9,
  },
  {
    id: "dd-dataset-actions",
    title: msg("tutorial.step.dataset_actions.title"),
    description: msg("tutorial.step.dataset_actions.body"),
    target: "[data-tutorial='datasets-selection']",
    placement: "top",
    beforeShow: async () => {
      await ensureDatasets();
      await waitForHook("setSelectedDatasetIds");
      callTutorialHook("setSelectedDatasetIds", [DEMO_DATASET_ID]);
      await waitForElement("[data-tutorial='datasets-selection']");
      await waitForStableRect("[data-tutorial='datasets-selection']");
    },
    afterHide: () => {
      callTutorialHook("setSelectedDatasetIds", []);
    },
    tracks: DATA_ONLY,
    readingTimeSec: 9,
  },
  {
    id: "dd-tagger-setup",
    title: msg("auto.features.tutorial.lib.steps.literal.29"),
    // The synthetic-dataset button only renders with AI assist on.
    get description() {
      return queryTutorialHook("taggerAssistAvailable") === false
        ? msg("tutorial.step.tagger_data.body")
        : msg("auto.features.tutorial.lib.steps.literal.30");
    },
    target: "[data-tutorial='tagger-data']",
    placement: "auto",
    beforeShow: async () => {
      await ensureTagger();
      injectDemoTaggerData(0);
    },
    tracks: DATA_ONLY,
    readingTimeSec: 10,
  },
  {
    id: "dd-tagger-modes",
    // With AI assist off, the same anchor sits on the task card instead of the
    // mode picker, so the copy is chosen once setup has mounted.
    get title() {
      return queryTutorialHook("taggerAssistAvailable") === false
        ? msg("tutorial.step.tagger_task.title")
        : msg("auto.features.tutorial.lib.steps.literal.31");
    },
    get description() {
      return queryTutorialHook("taggerAssistAvailable") === false
        ? msg("tutorial.step.tagger_task.body")
        : msg("auto.features.tutorial.lib.steps.literal.32");
    },
    target: "[data-tutorial='tagger-modes']",
    placement: "auto",
    beforeShow: async () => {
      await ensureTagger();
      injectDemoTaggerData(1);
      await waitForElement("[data-tutorial='tagger-modes']");
    },
    tracks: DATA_ONLY,
    readingTimeSec: 12,
  },
  {
    id: "dd-recipe-picker",
    title: msg("tutorial.step.recipe_picker.title"),
    description: msg("tutorial.step.recipe_picker.body"),
    target: "[data-tutorial='submit-recipe']",
    placement: "bottom",
    offsetY: 24,
    beforeShow: ensureRecipePicker,
    tracks: QUICK_AND_ANYTHING,
    readingTimeSec: 13,
  },
  {
    id: "dd-data-upload",
    title: formatMsg("auto.features.tutorial.lib.steps.template.16", { p1: TERMS.dataset }),
    description: `${msg("auto.features.tutorial.lib.steps.template.17")} ${msg("auto.features.tutorial.lib.steps.template.18")}`,
    target: "[data-tutorial='wizard-step-2']",
    placement: "left",
    beforeShow: async () => {
      await ensureSubmit("program");
      injectSampleDataset();
      showWizardSubstep("evaluation", "dataset-upload");
      await waitForElement("[data-tutorial='dataset-upload']");
    },
    tracks: QUICK_ONLY,
    readingTimeSec: 14,
  },
  {
    id: "dd-code-setup",
    title: `${msg("auto.features.tutorial.lib.steps.literal.20")} + ${TERMS.metric}`,
    description: msg("auto.features.tutorial.lib.steps.template.22"),
    target: "[data-tutorial='code-editors']",
    placement: "top",
    beforeShow: async () => {
      await ensureSubmit("program");
      injectSampleDataset();
      showWizardSubstep("evaluation", "signature-editor");
      callTutorialHook("setCodeAssistMode", "manual");
      callTutorialHook("chooseModule", "predict");
      callTutorialHook("setSignatureCode", DEMO_SIGNATURE_CODE);
      callTutorialHook("setMetricCode", DEMO_METRIC_CODE);
      await waitForElement("[data-tutorial='code-editors']");
    },
    tracks: QUICK_ONLY,
    readingTimeSec: 13,
  },

  {
    id: "dd-models",
    title: msg("auto.features.tutorial.lib.steps.template.24"),
    description: msg("auto.features.tutorial.lib.steps.template.25"),
    target: "[data-tutorial='model-catalog']",
    placement: "bottom",
    beforeShow: async () => {
      await ensureSubmit("program");
      callTutorialHook("setDemoModels");
      showWizardSubstep("optimization", "model-catalog");
      await waitForElement("[data-tutorial='model-catalog']");
    },
    tracks: QUICK_ONLY,
    readingTimeSec: 8,
  },
  {
    id: "dd-review",
    title: msg("auto.features.tutorial.lib.steps.template.27"),
    description: msg("auto.features.tutorial.lib.steps.template.26"),
    target: "[data-tutorial='wizard-stage-review']",
    placement: "bottom",
    beforeShow: async () => {
      await ensureSubmit("program");
      setOptimizerName("gepa");
      callTutorialHook("setDemoModels");
      setWizardStep(WIZARD_STAGE.review);
    },
    tracks: QUICK_ONLY,
    readingTimeSec: 12,
  },
  {
    id: "bb-start",
    title: msg("tutorial.step.bb_start.title"),
    description: msg("tutorial.step.bb_start.body"),
    target: "[data-tutorial='wizard-stage-goal']",
    placement: "left",
    beforeShow: async () => {
      await ensureSubmit("anything");
      injectBlackboxDemo();
      showWizardSubstep("goal");
      await waitForElement("[data-tutorial='wizard-stage-goal']");
    },
    tracks: ANYTHING_ONLY,
    readingTimeSec: 12,
  },
  {
    id: "bb-budget",
    title: msg("tutorial.step.bb_budget.title"),
    description: msg("tutorial.step.bb_budget.body"),
    target: "[data-tutorial='wizard-stage-evaluation']",
    placement: "left",
    beforeShow: async () => {
      await ensureSubmit("anything");
      injectBlackboxDemo();
      showWizardSubstep("evaluation", "totalBudgetInput");
      await waitForElement("[data-tutorial='wizard-stage-evaluation']");
    },
    tracks: ANYTHING_ONLY,
    readingTimeSec: 9,
  },
  {
    id: "bb-scorer",
    title: msg("tutorial.step.bb_scorer.title"),
    description: msg("tutorial.step.bb_scorer.body"),
    target: "[data-tutorial='wizard-stage-evaluation']",
    placement: "left",
    beforeShow: async () => {
      await ensureSubmit("anything");
      injectBlackboxDemo();
      showWizardSubstep("evaluation", "bb-scorer-code");
      await waitForElement("#bb-scorer-code");
    },
    tracks: ANYTHING_ONLY,
    readingTimeSec: 15,
  },
  {
    id: "bb-engines",
    title: msg("tutorial.step.bb_engines.title"),
    description: msg("tutorial.step.bb_engines.body"),
    target: "[data-tutorial='wizard-stage-optimization']",
    placement: "left",
    beforeShow: async () => {
      await ensureSubmit("anything");
      injectBlackboxDemo();
      showWizardSubstep("optimization", "bb-engines");
      await waitForElement("[data-tutorial='wizard-stage-optimization']");
    },
    tracks: ANYTHING_ONLY,
    readingTimeSec: 9,
  },
  {
    id: "bb-scores",
    title: msg("tutorial.step.bb_scores.title"),
    description: msg("tutorial.step.bb_scores.body"),
    target: "[data-tutorial='score-cards']",
    placement: "bottom",
    beforeShow: async () => {
      const onDetail =
        window.location.pathname === `/optimizations/${DEMO_BLACKBOX_OPTIMIZATION_ID}`;
      if (!onDetail) await showSubmitSplash();
      await ensureDemoDetail(DEMO_BLACKBOX_OPTIMIZATION_ID);
      setDetailTab("overview");
      await waitForElement("[data-tutorial='score-cards']");
    },
    tracks: ANYTHING_ONLY,
    readingTimeSec: 10,
  },
  {
    id: "bb-best-version",
    title: msg("tutorial.step.bb_best_version.title"),
    description: msg("tutorial.step.bb_best_version.body"),
    target: "[data-tutorial='best-version']",
    placement: "top",
    beforeShow: async () => {
      await ensureDemoDetail(DEMO_BLACKBOX_OPTIMIZATION_ID);
      setDetailTab("best");
      await waitForElement("[data-tutorial='best-version']");
    },
    tracks: ANYTHING_ONLY,
    readingTimeSec: 10,
  },
  {
    id: "dd-scores",
    title: msg("tutorial.step.scores.title"),
    description: formatMsg("auto.features.tutorial.lib.steps.template.32", {
      p1: TERMS.baselineScore,
      p2: TERMS.optimization,
      p3: TERMS.optimizedScore,
    }),
    target: "[data-tutorial='score-cards']",
    placement: "bottom",
    beforeShow: async () => {
      // Only the quick start just "submitted" the demo run; the results guide
      // opens on the finished run instead of replaying a submission.
      const onDetail = window.location.pathname === `/optimizations/${DEMO_OPTIMIZATION_ID}`;
      if (!onDetail && queryTutorialHook("activeTutorialTrack") === "quick") {
        resetDemoSimulation();
        await showSubmitSplash();
      }
      await ensureDemoDetail();
      // Other guides describe a finished run; without this the page replays
      // the run live and the Optimized card shows a dash.
      if (queryTutorialHook("activeTutorialTrack") !== "quick") {
        callTutorialHook("finishDemoSimulation");
      }
      setDetailTab("overview");
      await waitForElement("[data-tutorial='score-cards']");
    },
    tracks: QUICK_AND_RESULTS,
    readingTimeSec: 7,
  },
  {
    id: "dd-trajectory",
    title: msg("auto.features.tutorial.lib.steps.literal.46"),
    description: msg("auto.features.tutorial.lib.steps.literal.48"),
    target: "[data-tutorial='trajectory-panel']",
    placement: "top",
    beforeShow: async () => {
      await ensureDemoDetail();
      setDetailTab("overview");
      // Re-stream the candidates so the user sees the tree grow instead of
      // landing on a completed graph with no explanation of its branches.
      callTutorialHook("replayDemoSimulation");
      await waitForElement("[data-tutorial='trajectory-panel']");
    },
    // The replay hides the Artifact tab until it ends, so skip to the result.
    afterHide: () => {
      callTutorialHook("finishDemoSimulation");
    },
    tracks: RESULTS_ONLY,
    readingTimeSec: 12,
  },
  {
    id: "dd-playground",
    title: msg("auto.features.tutorial.lib.steps.literal.25"),
    description: `${msg("auto.features.tutorial.lib.steps.template.36")} ${msg("auto.features.tutorial.lib.steps.literal.41")}`,
    target: "[data-tutorial='serve-playground']",
    placement: "bottom",
    offsetY: 0,
    beforeShow: async () => {
      await ensureDemoDetail();
      setDetailTab("playground");
      await waitForElement("[data-tutorial='serve-playground']");
    },
    tracks: QUICK_AND_RESULTS,
    readingTimeSec: 9,
  },
  {
    id: "dd-code",
    title: msg("tutorial.step.code.title"),
    description: msg("tutorial.step.code.body"),
    target: "[data-tutorial='code-sources']",
    placement: "top",
    beforeShow: async () => {
      await ensureDemoDetail();
      setDetailTab("code");
      await waitForElement("[data-tutorial='code-sources']");
    },
    tracks: RESULTS_ONLY,
    readingTimeSec: 11,
  },
  {
    id: "dd-artifact",
    title: msg("tutorial.step.artifact.title"),
    description: msg("tutorial.step.artifact.body"),
    target: "[data-tutorial='artifact-output']",
    placement: "top",
    beforeShow: async () => {
      await ensureDemoDetail();
      setDetailTab("artifact");
      await waitForElement("[data-tutorial='artifact-output']");
    },
    tracks: RESULTS_ONLY,
    readingTimeSec: 12,
  },
  {
    id: "dd-data-tab",
    title: msg("auto.features.tutorial.lib.steps.literal.24"),
    description: msg("auto.features.tutorial.lib.steps.template.35"),
    target: "[data-tutorial='data-table']",
    placement: "bottom",
    offsetY: 0,
    beforeShow: async () => {
      await ensureDemoDetail();
      setDetailTab("data");
      await waitForElement("[data-tutorial='data-table']");
    },
    tracks: RESULTS_ONLY,
    readingTimeSec: 13,
  },
  {
    id: "dd-logs",
    title: msg("auto.features.tutorial.lib.steps.literal.26"),
    description: msg("auto.features.tutorial.lib.steps.template.37"),
    target: "[data-tutorial='live-logs']",
    placement: "top",
    beforeShow: async () => {
      await ensureDemoDetail();
      setDetailTab("logs");
      await waitForElement("[data-tutorial='live-logs']");
    },
    tracks: RESULTS_ONLY,
    readingTimeSec: 9,
  },
  {
    id: "dd-result-actions",
    title: msg("tutorial.step.result_actions.title"),
    description: msg("tutorial.step.result_actions.body"),
    target: "[data-tutorial='result-actions']",
    placement: "left",
    beforeShow: async () => {
      await ensureDemoDetail();
      setDetailTab("overview");
      await waitForElement("[data-tutorial='result-actions']");
    },
    tracks: RESULTS_ONLY,
    readingTimeSec: 9,
  },
  {
    id: "dd-sidebar-nav",
    title: msg("tutorial.step.sidebar_nav.title"),
    description: msg("tutorial.step.sidebar_nav.body"),
    target: "[data-tutorial='sidebar-nav']",
    placement: "right",
    beforeShow: async () => {
      await ensureDashboard();
      // Below md the sidebar is an off-canvas drawer; slide it in.
      if (window.innerWidth < 768) callTutorialHook("setSidebarOpen", true);
      await waitForElement("[data-tutorial='sidebar-nav']");
    },
    afterHide: () => {
      if (window.innerWidth < 768) callTutorialHook("setSidebarOpen", false);
    },
    tracks: WORKSPACE_ONLY,
    readingTimeSec: 6,
  },
  {
    id: "dd-table",
    title: msg("tutorial.step.table.title"),
    description: msg("auto.features.tutorial.lib.steps.template.2"),
    target: "[data-tutorial='dashboard-table']",
    placement: "top",
    offsetY: 0,
    beforeShow: async () => {
      await ensureDashboard();
      injectDemoDashboardData();
      setTab("jobs");
      await waitForElement("[data-tutorial='dashboard-table']");
    },
    tracks: WORKSPACE_ONLY,
    readingTimeSec: 11,
  },
  {
    id: "dd-analytics",
    title: msg("auto.features.tutorial.lib.steps.literal.9"),
    description: msg("auto.features.tutorial.lib.steps.template.47"),
    target: "[data-tutorial='analytics-content']",
    placement: "bottom",
    beforeShow: async () => {
      await ensureDashboard();
      injectDemoDashboardData();
      setTab("analytics");
      await waitForElement("[data-tutorial='analytics-content']");
      await new Promise((r) => setTimeout(r, 250));
    },
    tracks: WORKSPACE_ONLY,
    readingTimeSec: 9,
  },
  {
    id: "dd-explore",
    title: msg("auto.features.tutorial.lib.steps.literal.38"),
    description: msg("auto.features.tutorial.lib.steps.literal.49"),
    target: "[data-tutorial='explore-search']",
    placement: "bottom",
    beforeShow: async () => {
      await ensureExplore();
    },
    tracks: WORKSPACE_ONLY,
    readingTimeSec: 11,
  },
  {
    id: "dd-agent-panel",
    title: msg("auto.features.tutorial.lib.steps.literal.44"),
    description: msg("auto.features.tutorial.lib.steps.literal.50"),
    target: "[data-tutorial='agent-panel']",
    placement: "left",
    beforeShow: async () => {
      agentPanelWasOpen = isElementVisible("[data-tutorial='agent-panel']");
      setGeneralistPanelOpen(true);
      await waitForElement("[data-tutorial='agent-panel']");
    },
    afterHide: () => {
      if (!agentPanelWasOpen) setGeneralistPanelOpen(false);
    },
    tracks: WORKSPACE_ONLY,
    readingTimeSec: 10,
  },
  {
    id: "dd-settings-billing",
    title: msg("tutorial.step.settings_billing.title"),
    description: msg("tutorial.step.settings_billing.body"),
    target: "[data-tutorial='settings-billing']",
    placement: "left",
    beforeShow: () => openSettingsTab("billing"),
    afterHide: closeSettingsUnlessReopened,
    tracks: WORKSPACE_ONLY,
    readingTimeSec: 8,
  },
  {
    id: "dd-settings-providers",
    title: msg("tutorial.step.settings_providers.title"),
    description: msg("tutorial.step.settings_providers.body"),
    target: "[data-tutorial='settings-providers']",
    placement: "left",
    beforeShow: () => openSettingsTab("providers"),
    afterHide: closeSettings,
    tracks: WORKSPACE_ONLY,
    readingTimeSec: 12,
  },
]);

const AGENT_PANEL_STEP_IDS = new Set(["dd-agent-panel"]);
// Phones render neither these detail tabs, the dashboard table nor the
// sidebar (they get bottom tabs), so the steps would only stall on a
// missing target before being skipped.
const DESKTOP_ONLY_STEP_IDS = new Set(["dd-code", "dd-data-tab", "dd-table", "dd-sidebar-nav"]);

function isPhoneViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia(PHONE_MEDIA_QUERY).matches;
}

function getVisibleSteps(): TutorialStep[] {
  const generalist = isGeneralistAgentEnabled();
  const phone = isPhoneViewport();
  return tutorialSteps.filter((s) => {
    if (!generalist && AGENT_PANEL_STEP_IDS.has(s.id)) return false;
    if (phone && DESKTOP_ONLY_STEP_IDS.has(s.id)) return false;
    return true;
  });
}

// Reading time alone undersells a step: the tour also navigates, waits for
// the target to paint, and gives the user a moment to look at it. Padding
// each step keeps the menu's estimate from reading as optimistic.
const STEP_OVERHEAD_SEC = 6;

export function getTrack(trackId: TutorialTrack): TutorialTrackDefinition | undefined {
  const steps = getVisibleSteps().filter((s) => s.tracks.includes(trackId));
  if (steps.length === 0) return undefined;
  const seconds = steps.reduce((sum, s) => sum + s.readingTimeSec + STEP_OVERHEAD_SEC, 0);
  const metadata: Record<TutorialTrack, { name: string; description: string }> = {
    quick: {
      name: msg("tutorial.track.quick.name"),
      description: msg("tutorial.track.quick.desc"),
    },
    anything: {
      name: msg("tutorial.track.anything.name"),
      description: msg("tutorial.track.anything.desc"),
    },
    data: {
      name: msg("tutorial.track.data.name"),
      description: msg("tutorial.track.data.desc"),
    },
    results: {
      name: msg("tutorial.track.results.name"),
      description: msg("tutorial.track.results.desc"),
    },
    workspace: {
      name: msg("tutorial.track.workspace.name"),
      description: msg("tutorial.track.workspace.desc"),
    },
  };
  return {
    id: trackId,
    name: metadata[trackId].name,
    description: metadata[trackId].description,
    icon: trackId,
    stepCount: steps.length,
    estimatedMinutes: Math.max(1, Math.round(seconds / 60)),
    steps,
  };
}
