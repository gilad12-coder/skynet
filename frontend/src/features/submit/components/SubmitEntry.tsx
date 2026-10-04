"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "framer-motion";

import { useWizardStateOptional } from "@/features/agent-panel";
import { registerTutorialHook } from "@/features/tutorial";
import { sessionIdentity } from "@/shared/lib/session-identity";

import { SubmitWizard } from "./SubmitWizard";
import { BlackboxWizard } from "./blackbox/BlackboxWizard";
import { RecipeChip, RecipePicker, parseRecipeLink, type Recipe } from "./RecipePicker";
import { ExecutionBudgetProvider } from "../hooks/use-execution-budget";

type Screen = "picker" | "wizard";

// Setups were once saved as drafts in this browser and offered back on
// return; that feature is gone, so whatever an older build left is dropped.
const RETIRED_DRAFT_DATABASE = "skynet-wizard-drafts";
const RETIRED_DRAFT_RESUME_KEY = "skynet.wizard-draft.resume";

function clearRetiredDrafts() {
  try {
    window.indexedDB?.deleteDatabase(RETIRED_DRAFT_DATABASE);
  } catch {}
  try {
    window.sessionStorage.removeItem(RETIRED_DRAFT_RESUME_KEY);
  } catch {}
}

// A quick fade-down out, then a slower rise in: the swap reads as one motion
// without the column ever holding both screens.
const SCREEN_VARIANTS: Variants = {
  out: { opacity: 0, y: 12, transition: { type: "tween", duration: 0.14, ease: [0.4, 0, 1, 1] } },
  in: { opacity: 1, y: 0, transition: { type: "tween", duration: 0.22, ease: [0.22, 1, 0.36, 1] } },
};
const STILL_VARIANTS: Variants = {
  out: { opacity: 0, y: 0, transition: { duration: 0 } },
  in: { opacity: 1, y: 0, transition: { duration: 0 } },
};

/** `/submit` root: the recipe picker first, then the DSPy or black-box wizard it selects. */
export function SubmitEntry() {
  const wizardState = useWizardStateOptional();
  const searchParams = useSearchParams();
  const link = parseRecipeLink(searchParams.get("recipe"));
  const initial = link?.recipe ?? null;
  // A clone link keeps the picker on screen even when it names a recipe: the
  // carousel opens preselected on the source job's slide, confirmed rather
  // than skipped, so the recipe can still be switched before the wizard.
  const cloning = searchParams.get("clone") !== null;
  // Read once: a run started from a folder's menu should land in that folder.
  const [folderId] = useState(() => searchParams.get("folder"));
  const [recipe, setRecipe] = useState<Recipe | null>(initial);
  // The picker is its own screen ahead of the wizard: a `?recipe=` deep link
  // skips it, otherwise no wizard exists until a recipe is committed. Reopening
  // it later hides the wizard rather than unmounting it, so the setup survives
  // a look at the other options.
  const [picking, setPicking] = useState(initial === null || cloning);
  // `shown` trails `picking` by one exit: the outgoing screen has left the
  // column before the incoming one takes it.
  const [shown, setShown] = useState<Screen>(initial === null || cloning ? "picker" : "wizard");
  // The tour hands the wizard a fresh instance per recipe: the hooks hydrate
  // once at mount, so a live instance is never re-seeded underneath the user.
  const [wizardKey, setWizardKey] = useState(0);
  // Set while the guided tour drives this page: which screen it opened last.
  // The tour always leaves `/submit` when it ends, which unmounts this state.
  const [touring, setTouring] = useState<Recipe | "picker" | null>(null);
  const variants = useReducedMotion() ? STILL_VARIANTS : SCREEN_VARIANTS;

  const { data: session, status } = useSession();
  const accountId = status === "loading" ? null : sessionIdentity(session) || null;

  useEffect(() => {
    clearRetiredDrafts();
  }, []);

  useEffect(() => {
    const offWizard = registerTutorialHook("openTutorialWizard", (next) => {
      // Each tour step asks for its wizard again; only a change of recipe
      // gets a fresh instance, so demo data seeded by earlier steps survives.
      if (touring !== next) {
        wizardState?.reset();
        setWizardKey((k) => k + 1);
        setTouring(next);
        setRecipe(next);
      }
      setPicking(false);
    });
    const offPicker = registerTutorialHook("openTutorialRecipePicker", () => {
      setTouring((current) => current ?? "picker");
      setPicking(true);
    });
    return () => {
      offWizard();
      offPicker();
    };
  }, [touring, wizardState]);

  // The shared agent state outlives either wizard. Fields that only mean
  // something to the workflow being left (its staged rows, the black-box task)
  // are dropped on a switch so the next wizard never adopts them as its own.
  // `keep` names fields the agent wrote in the same update as the switch:
  // those already belong to the workflow being entered.
  const dropRecipeScopedState = (next: Recipe, keep: readonly string[] = []) => {
    if (!wizardState || recipe === null || recipe === next) return;
    for (const key of [
      "staged_dataset_id",
      "blackbox_objective",
      "blackbox_seed",
      "blackbox_scorer_code",
    ] as const) {
      if (keep.includes(key)) continue;
      if (wizardState.state[key] !== undefined) wizardState.clearField(key);
    }
  };

  // The agent picks the workflow by writing `job_type`; follow it so the wizard
  // on screen is the one whose fields the agent is filling. Only a pulse that
  // lands while this page is open counts: the keys of an older pulse are still
  // in the shared state at mount and must not skip the picker.
  const agentPulseTick = wizardState?.agentPulseTick ?? 0;
  const mountPulseTickRef = useRef(agentPulseTick);
  useEffect(() => {
    if (agentPulseTick === mountPulseTickRef.current) return;
    if (!wizardState?.agentPulseKeys.includes("job_type")) return;
    const jobType = wizardState.state.job_type;
    if (!jobType) return;
    const wanted: Recipe = jobType === "blackbox" ? "anything" : "program";
    if (recipe === wanted && !picking) return;
    dropRecipeScopedState(wanted, wizardState.agentPulseKeys);
    setRecipe(wanted);
    setPicking(false);
    // Runs once per agent pulse; the keys and state are read from that render.
  }, [agentPulseTick]);

  const choose = (next: Recipe) => {
    dropRecipeScopedState(next);
    setRecipe(next);
    setPicking(false);
  };
  const chip = recipe && <RecipeChip recipe={recipe} onChange={() => setPicking(true)} />;
  const wizardShown = shown === "wizard" && !picking;

  return (
    <>
      <ExecutionBudgetProvider key={`${accountId}:${wizardKey}`}>
        <AnimatePresence initial={false} onExitComplete={() => setShown("wizard")}>
          {shown === "picker" && picking && (
            <motion.div
              key="picker"
              variants={variants}
              initial="out"
              animate="in"
              exit="out"
              // Centered in the content column (viewport minus header and the
              // shell's block padding) so the picker doesn't hug the top of an
              // otherwise empty page. Phones keep top alignment: their shell is
              // shorter and scrolls.
              className="mx-auto flex w-full min-w-0 max-w-4xl flex-col justify-center pb-6 md:min-h-[calc(100dvh-var(--header-height,53px)-5rem)] md:pb-8"
            >
              <RecipePicker current={recipe} onChoose={choose} />
            </motion.div>
          )}
        </AnimatePresence>
        {recipe && accountId !== null && (
          <motion.div
            variants={variants}
            initial={false}
            animate={wizardShown ? "in" : "out"}
            onAnimationComplete={(definition) => {
              if (definition === "out" && picking) setShown("picker");
            }}
            className={shown === "wizard" ? undefined : "hidden"}
          >
            {recipe === "anything" ? (
              <BlackboxWizard
                key={`${accountId}:${wizardKey}`}
                header={chip}
                initialRecipe={link?.kind ?? "anything"}
                folderId={folderId}
                touring={touring !== null}
              />
            ) : (
              <SubmitWizard key={`${accountId}:${wizardKey}`} header={chip} folderId={folderId} />
            )}
          </motion.div>
        )}
      </ExecutionBudgetProvider>
    </>
  );
}
