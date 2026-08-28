"use client";

import type { ComponentType } from "react";
import { ChatText, Code, Cube, RocketLaunch } from "@/shared/ui/icons";
import { cn } from "@/shared/lib/utils";
import { msg } from "@/shared/lib/messages";

export type Recipe = "prompt" | "program" | "code" | "anything";

const RECIPE_IDS: Recipe[] = ["prompt", "program", "code", "anything"];

export function parseRecipe(value: string | null): Recipe {
  return RECIPE_IDS.includes(value as Recipe) ? (value as Recipe) : "program";
}

/** Recipes other than the DSPy "program" flow all run on the black-box spine. */
export function isBlackboxRecipe(recipe: Recipe): recipe is Exclude<Recipe, "program"> {
  return recipe !== "program";
}

const RECIPES: Array<{ id: Recipe; Icon: ComponentType<{ className?: string }> }> = [
  { id: "prompt", Icon: ChatText },
  { id: "program", Icon: RocketLaunch },
  { id: "code", Icon: Code },
  { id: "anything", Icon: Cube },
];

/** Entry choice above the first wizard step: the DSPy program flow or the black-box one. */
export function RecipeCards({ value, onChange }: { value: Recipe; onChange: (r: Recipe) => void }) {
  return (
    <div className="space-y-2" data-tutorial="submit-recipe">
      <p className="text-xs font-medium text-muted-foreground">{msg("submit.recipe.title")}</p>
      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup">
        {RECIPES.map(({ id, Icon }) => {
          const selected = id === value;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(id)}
              className={cn(
                "flex min-h-[44px] cursor-pointer items-start gap-3 rounded-xl border p-3 text-start transition-colors",
                selected
                  ? "border-primary bg-primary/5"
                  : "border-border/50 bg-card/80 hover:border-primary/50",
              )}
            >
              <Icon
                className={cn(
                  "mt-0.5 size-5 shrink-0",
                  selected ? "text-primary" : "text-muted-foreground",
                )}
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">
                  {msg(`submit.recipe.${id}.title` as Parameters<typeof msg>[0])}
                </span>
                <span className="block text-[0.6875rem] leading-relaxed text-muted-foreground">
                  {msg(`submit.recipe.${id}.desc` as Parameters<typeof msg>[0])}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
