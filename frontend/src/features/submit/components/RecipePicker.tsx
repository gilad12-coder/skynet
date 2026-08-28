"use client";

import type { ComponentType } from "react";

import { ChatText, Code, Cube, Repeat, RocketLaunch } from "@/shared/ui/icons";
import { formatMsg, msg } from "@/shared/lib/messages";
import { Carousel } from "@/features/agent-panel";

import { BannerFrame, GArrow, GBar, GBox, GWire, PickerSlide } from "./steps/PickerSlide";

export type Recipe = "prompt" | "program" | "code" | "anything";

const RECIPE_IDS: Recipe[] = ["prompt", "program", "code", "anything"];

/** The recipe named by a `?recipe=` deep link, or null when absent or unknown. */
export function parseRecipe(value: string | null): Recipe | null {
  return RECIPE_IDS.includes(value as Recipe) ? (value as Recipe) : null;
}

/** Recipes other than the DSPy "program" flow all run on the black-box spine. */
export function isBlackboxRecipe(recipe: Recipe): recipe is Exclude<Recipe, "program"> {
  return recipe !== "program";
}

type MessageKey = Parameters<typeof msg>[0];

const RECIPES: Array<{
  id: Recipe;
  Icon: ComponentType<{ className?: string }>;
  Banner: ComponentType;
}> = [
  { id: "prompt", Icon: ChatText, Banner: PromptBanner },
  { id: "program", Icon: RocketLaunch, Banner: ProgramBanner },
  { id: "code", Icon: Code, Banner: CodeBanner },
  { id: "anything", Icon: Cube, Banner: AnythingBanner },
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
}: {
  current: Recipe | null;
  onChoose: (recipe: Recipe) => void;
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
        renderItem={(r) => <RecipeSlide recipe={r} onChoose={onChoose} />}
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
  onChoose,
}: {
  recipe: (typeof RECIPES)[number];
  onChoose: (recipe: Recipe) => void;
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
      chooseName={formatMsg("submit.recipe.choose", { p1: title })}
      onChoose={() => onChoose(id)}
    />
  );
}

/**
 * The chosen recipe as a chip above the wizard's first step, with the
 * click-to-switch affordance that reopens the picker — the same shape as the
 * module chip in the authoring header.
 */
export function RecipeChip({ recipe, onChange }: { recipe: Recipe; onChange: () => void }) {
  const Icon = RECIPES.find((r) => r.id === recipe)?.Icon ?? Cube;
  return (
    // The chip is the picker folded shut: it keeps the picker card's surface
    // and the wizard card's inset, so the column reads as one stack.
    <button
      type="button"
      onClick={onChange}
      data-tutorial="submit-recipe"
      className="group flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-2xl border border-border/50 bg-card/80 px-6 py-2.5 text-sm shadow-xs backdrop-blur-xl transition-[border-color,box-shadow] duration-300 hover:border-[#C8A882] hover:shadow-md"
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[#F3EDE3] text-[#3D2E22]">
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 truncate font-semibold tracking-tight text-foreground">
        {recipeTitle(recipe)}
      </span>
      <span className="ms-auto flex shrink-0 items-center gap-1.5 font-medium text-muted-foreground transition-colors group-hover:text-foreground">
        {msg("submit.recipe.change")}
        <Repeat className="size-3.5" />
      </span>
    </button>
  );
}

function PromptBanner() {
  return (
    <BannerFrame>
      {/* The system prompt is what gets rewritten; the model and its answer
          stay fixed. */}
      <GWire d="M96 44 H124" />
      <GWire d="M168 44 H190" />
      <GBox x={26} y={16} w={70} h={56} accent />
      <GBar x={38} y={29} w={44} />
      <GBar x={38} y={37} w={32} />
      <GBar x={38} y={45} w={46} />
      <GBar x={38} y={53} w={26} />
      <GBox x={124} y={29} w={44} h={30} />
      <GBar x={136} y={43} w={20} />
      <GBox x={190} y={33} w={32} h={22} />
      <GBar x={197} y={40} w={18} />
      <GBar x={197} y={46} w={12} />
    </BannerFrame>
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

function CodeBanner() {
  return (
    <BannerFrame>
      {/* A script, run through the user's Python scorer; the score steers the
          next rewrite. */}
      <GWire d="M104 44 H132" />
      <GArrow x={136} y={44} dir="right" />
      <GWire d="M180 44 H198" />
      <GBox x={26} y={16} w={78} h={56} accent />
      <GBar x={38} y={29} w={44} />
      <GBar x={46} y={37} w={40} />
      <GBar x={46} y={45} w={28} />
      <GBar x={38} y={53} w={50} />
      <GBox x={136} y={29} w={44} h={30} />
      <path
        d="M150 44 L156 50 L166 38"
        fill="none"
        stroke="#3D2E22"
        strokeOpacity={0.35}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <GBox x={198} y={33} w={26} h={22} />
      <GBar x={204} y={40} w={14} />
      <GBar x={204} y={46} w={9} />
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
