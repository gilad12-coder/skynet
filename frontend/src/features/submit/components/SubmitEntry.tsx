"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";

import { SubmitWizard } from "./SubmitWizard";
import { BlackboxWizard } from "./blackbox/BlackboxWizard";
import {
  RecipeChip,
  RecipePicker,
  isBlackboxRecipe,
  parseRecipe,
  type Recipe,
} from "./RecipePicker";

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

  const choose = (next: Recipe) => {
    setRecipe(next);
    setPicking(false);
  };
  const chip = recipe && <RecipeChip recipe={recipe} onChange={() => setPicking(true)} />;

  return (
    <>
      {picking && (
        <div className="mx-auto w-full min-w-0 max-w-4xl pb-6 md:-mt-4 md:pb-8">
          <RecipePicker current={recipe} onChoose={choose} />
        </div>
      )}
      {recipe && (
        <div className={picking ? "hidden" : undefined}>
          {isBlackboxRecipe(recipe) ? (
            <BlackboxWizard header={chip} recipe={recipe} />
          ) : (
            <SubmitWizard header={chip} />
          )}
        </div>
      )}
    </>
  );
}
