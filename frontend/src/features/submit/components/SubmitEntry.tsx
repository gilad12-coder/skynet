"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "framer-motion";

import { SubmitWizard } from "./SubmitWizard";
import { BlackboxWizard } from "./blackbox/BlackboxWizard";
import {
  RecipeChip,
  RecipePicker,
  isBlackboxRecipe,
  parseRecipe,
  type Recipe,
} from "./RecipePicker";

type Screen = "picker" | "wizard";

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
  const searchParams = useSearchParams();
  const initial = parseRecipe(searchParams.get("recipe"));
  const [recipe, setRecipe] = useState<Recipe | null>(initial);
  // The picker is its own screen ahead of the wizard: a `?recipe=` deep link
  // skips it, otherwise no wizard exists until a recipe is committed. Reopening
  // it later hides the wizard rather than unmounting it, so the draft survives
  // a look at the other options.
  const [picking, setPicking] = useState(initial === null);
  // `shown` trails `picking` by one exit: the outgoing screen has left the
  // column before the incoming one takes it.
  const [shown, setShown] = useState<Screen>(initial === null ? "picker" : "wizard");
  const variants = useReducedMotion() ? STILL_VARIANTS : SCREEN_VARIANTS;

  const choose = (next: Recipe) => {
    setRecipe(next);
    setPicking(false);
  };
  const chip = recipe && <RecipeChip recipe={recipe} onChange={() => setPicking(true)} />;
  const wizardShown = shown === "wizard" && !picking;

  return (
    <>
      <AnimatePresence initial={false} onExitComplete={() => setShown("wizard")}>
        {shown === "picker" && picking && (
          <motion.div
            key="picker"
            variants={variants}
            initial="out"
            animate="in"
            exit="out"
            className="mx-auto w-full min-w-0 max-w-4xl pb-6 md:-mt-4 md:pb-8"
          >
            <RecipePicker current={recipe} onChoose={choose} />
          </motion.div>
        )}
      </AnimatePresence>
      {recipe && (
        <motion.div
          variants={variants}
          initial={false}
          animate={wizardShown ? "in" : "out"}
          onAnimationComplete={(definition) => {
            if (definition === "out" && picking) setShown("picker");
          }}
          className={shown === "wizard" ? undefined : "hidden"}
        >
          {isBlackboxRecipe(recipe) ? (
            <BlackboxWizard header={chip} recipe={recipe} />
          ) : (
            <SubmitWizard header={chip} />
          )}
        </motion.div>
      )}
    </>
  );
}
