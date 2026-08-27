"use client";

import { Cube, RocketLaunch } from "@/shared/ui/icons";
import { cn } from "@/shared/lib/utils";
import { msg } from "@/shared/lib/messages";

export type Recipe = "program" | "anything";

export function parseRecipe(value: string | null): Recipe {
  return value === "anything" ? "anything" : "program";
}

const RECIPES = [
  { id: "program", Icon: RocketLaunch },
  { id: "anything", Icon: Cube },
] as const;

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
                  {msg(
                    id === "program"
                      ? "submit.recipe.program.title"
                      : "submit.recipe.anything.title",
                  )}
                </span>
                <span className="block text-[0.6875rem] leading-relaxed text-muted-foreground">
                  {msg(
                    id === "program" ? "submit.recipe.program.desc" : "submit.recipe.anything.desc",
                  )}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
