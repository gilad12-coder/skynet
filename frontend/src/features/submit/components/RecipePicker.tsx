"use client";

import type { ComponentType } from "react";

import { Cube, Repeat, RocketLaunch } from "@/shared/ui/icons";
import { formatMsg, msg } from "@/shared/lib/messages";
import { Carousel } from "@/features/agent-panel";

import { wizardRecipe, type BlackboxRecipe } from "../hooks/use-blackbox-wizard";
import { BannerFrame, GArrow, GBar, GBox, GWire, PickerSlide } from "./steps/PickerSlide";

export type Recipe = "program" | "anything";

/**
 * What a `?recipe=` deep link or clone link names, or null when absent or
 * unknown. A black-box link carries the kind of starting point the run
 * persists — `code`, `anything`, or `prompt` from before prompts folded
 * into text — which lands on the Anything slide and preselects that kind
 * in the wizard's Starting point step.
 */
export function parseRecipeLink(
  value: string | null,
): { recipe: Recipe; kind: BlackboxRecipe } | null {
  if (value === "program") return { recipe: "program", kind: "anything" };
  if (value === "prompt" || value === "code" || value === "anything") {
    return { recipe: "anything", kind: wizardRecipe(value) };
  }
  return null;
}

type MessageKey = Parameters<typeof msg>[0];

const RECIPES: Array<{
  id: Recipe;
  Icon: ComponentType<{ className?: string }>;
  Banner: ComponentType;
}> = [
  { id: "anything", Icon: Cube, Banner: AnythingBanner },
  { id: "program", Icon: RocketLaunch, Banner: ProgramBanner },
];

function recipeTitle(id: Recipe): string {
  return msg(`submit.recipe.${id}.title` as MessageKey);
}

/**
 * The entry screen of `/submit`: what to optimize, chosen before the wizard
 * and its first step exist. Same carousel as the module picker, one slide per
 * recipe; `current` is the recipe in use when the picker is reopened from the
 * wizard, so it opens on that slide.
 */
export function RecipePicker({
  current,
  onChoose,
  startsNew = false,
}: {
  current: Recipe | null;
  onChoose: (recipe: Recipe) => void;
  /** A saved draft awaits its offer: choosing here is labelled as starting a new setup. */
  startsNew?: boolean;
}) {
  const currentIndex = RECIPES.findIndex((r) => r.id === current);
  return (
    // A container, not a breakpoint: only the card's own width can say whether
    // a slide has room to sit its banner and copy side by side.
    <div
      className="@container rounded-2xl border border-border/50 bg-card/80 px-4 py-5 shadow-lg backdrop-blur-xl sm:px-8 sm:py-7"
      data-tutorial="submit-recipe"
    >
      <Carousel
        items={RECIPES}
        itemKey={(r) => r.id}
        renderItem={(r) => (
          <RecipeSlide
            recipe={r}
            selected={r.id === current}
            onChoose={onChoose}
            startsNew={startsNew}
          />
        )}
        // The question rides the carousel's own header row, opposite the
        // position counter, rather than sitting above it as a second block.
        title={
          <span className="text-sm font-semibold tracking-tight">{msg("submit.recipe.title")}</span>
        }
        ariaLabel={msg("submit.recipe.carousel_aria")}
        jumpIndices={currentIndex >= 0 ? [currentIndex] : undefined}
        fluid
      />
    </div>
  );
}

function RecipeSlide({
  recipe,
  selected,
  onChoose,
  startsNew,
}: {
  recipe: (typeof RECIPES)[number];
  selected: boolean;
  onChoose: (recipe: Recipe) => void;
  startsNew: boolean;
}) {
  const { id, Icon, Banner } = recipe;
  const title = recipeTitle(id);
  return (
    <PickerSlide
      Banner={Banner}
      icon={Icon}
      label={title}
      tagline={msg(`submit.recipe.tagline.${id}` as MessageKey)}
      description={msg(`submit.recipe.${id}.desc` as MessageKey)}
      chooseName={formatMsg(startsNew ? "submit.recipe.choose_new" : "submit.recipe.choose", {
        p1: title,
      })}
      selected={selected}
      onChoose={() => onChoose(id)}
    />
  );
}

/**
 * The chosen recipe as a chip in the header band of the wizard's first card,
 * with the click-to-switch affordance that reopens the picker — the same
 * shape as the module chip that sits beside it in the authoring header.
 */
export function RecipeChip({ recipe, onChange }: { recipe: Recipe; onChange: () => void }) {
  const Icon = RECIPES.find((r) => r.id === recipe)?.Icon ?? Cube;
  return (
    <button
      type="button"
      onClick={onChange}
      data-tutorial="submit-recipe"
      className="group inline-flex min-h-[44px] w-full min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 py-1 text-xs shadow-xs transition-colors hover:border-[#C8A882] sm:w-auto lg:min-h-0"
    >
      <Icon className="size-3.5 shrink-0 text-[#3D2E22]" aria-hidden />
      <span className="min-w-0 truncate font-semibold text-foreground">{recipeTitle(recipe)}</span>
      <span aria-hidden className="ms-auto h-3 w-px shrink-0 bg-border/80" />
      <span className="flex shrink-0 items-center gap-1 font-medium text-muted-foreground transition-colors group-hover:text-foreground">
        {msg("submit.recipe.change")}
        <Repeat className="size-3" />
      </span>
    </button>
  );
}

function ProgramBanner() {
  return (
    <BannerFrame>
      <GWire d="M50 34 H90" />
      <GWire d="M146 34 H190" />
      {/* The metric scores each answer and the optimizer folds the score back
          into the module's prompts and demos. */}
      <GWire d="M206 46 V62" />
      <GArrow x={206} y={62} dir="down" />
      <GWire d="M184 70 H118 V46" />
      <GArrow x={118} y={46} dir="up" />
      <GBox x={18} y={23} w={32} h={22} />
      <GBar x={25} y={32} w={18} />
      <GBox x={90} y={22} w={56} h={24} accent />
      <GBar x={104} y={32} w={28} />
      <GBox x={190} y={23} w={32} h={22} />
      <GBar x={197} y={32} w={18} />
      <GBox x={184} y={62} w={44} h={16} />
      <GBar x={194} y={69} w={24} />
    </BannerFrame>
  );
}

function AnythingBanner() {
  return (
    <BannerFrame>
      {/* The optimize loop: a candidate goes to the scorer, and its score comes
          back around as the next candidate. */}
      <GWire d="M96 40 H136" />
      <GArrow x={140} y={40} dir="right" />
      <GWire d="M184 40 H198" />
      <GWire d="M162 55 V72 H61 V66" />
      <GArrow x={61} y={62} dir="up" />
      <GBox x={26} y={18} w={70} h={44} accent />
      <GBar x={38} y={30} w={44} />
      <GBar x={38} y={38} w={30} />
      <GBar x={38} y={46} w={40} />
      <GBox x={140} y={25} w={44} h={30} />
      <GBar x={152} y={36} w={20} />
      <GBar x={152} y={43} w={12} />
      <GBox x={198} y={29} w={26} h={22} />
      <GBar x={204} y={36} w={14} />
      <GBar x={204} y={42} w={9} />
    </BannerFrame>
  );
}
