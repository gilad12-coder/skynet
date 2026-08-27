"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";

import { SubmitWizard } from "./SubmitWizard";
import { BlackboxWizard } from "./blackbox/BlackboxWizard";
import { RecipeCards, parseRecipe } from "./RecipeCards";

/** `/submit` root: picks between the DSPy wizard and the black-box wizard. */
export function SubmitEntry() {
  const searchParams = useSearchParams();
  const [recipe, setRecipe] = useState(() => parseRecipe(searchParams.get("recipe")));
  const cards = <RecipeCards value={recipe} onChange={setRecipe} />;
  return recipe === "anything" ? (
    <BlackboxWizard header={cards} />
  ) : (
    <SubmitWizard header={cards} />
  );
}
