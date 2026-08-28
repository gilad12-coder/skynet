"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";

import { SubmitWizard } from "./SubmitWizard";
import { BlackboxWizard } from "./blackbox/BlackboxWizard";
import { RecipeCards, isBlackboxRecipe, parseRecipe } from "./RecipeCards";

/** `/submit` root: picks between the DSPy wizard and the black-box wizard. */
export function SubmitEntry() {
  const searchParams = useSearchParams();
  const [recipe, setRecipe] = useState(() => parseRecipe(searchParams.get("recipe")));
  const cards = <RecipeCards value={recipe} onChange={setRecipe} />;
  return isBlackboxRecipe(recipe) ? (
    <BlackboxWizard header={cards} recipe={recipe} />
  ) : (
    <SubmitWizard header={cards} />
  );
}
