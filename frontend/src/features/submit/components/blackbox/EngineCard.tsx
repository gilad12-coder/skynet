"use client";

import type { ComponentType } from "react";

import {
  ArrowsClockwise,
  Books,
  Cube,
  GitBranch,
  ListChecks,
  MagicWand,
  Robot,
  Shuffle,
  SquaresFour,
  Wrench,
} from "@/shared/ui/icons";
import { Badge } from "@/shared/ui/primitives/badge";
import { msg } from "@/shared/lib/messages";

import { BannerFrame, GArrow, GBar, GBox, GWire } from "../steps/PickerSlide";

/** What a card shows about one optimizer: a black-box engine, a DSPy optimizer or Auto. */
export interface EngineSlideInfo {
  id: string;
  label: string;
  description: string;
  available: boolean;
  unavailable_reason?: string | null;
}

/**
 * The body of one optimizer option card: the optimizer's schematic banner,
 * its identity and availability. The caller owns the radio semantics.
 */
export function EngineCard({
  engine,
  blocked = false,
  blockedNote,
}: {
  engine: EngineSlideInfo;
  // The setup rules this optimizer out; the card stays readable so the
  // user can see what they are giving up.
  blocked?: boolean;
  blockedNote?: string;
}) {
  const { Banner, icon: Icon } = ENGINE_VISUALS[engine.id] ?? GENERIC_VISUAL;
  return (
    <>
      {/* The banner frame sizes itself for a full-width slide; a grid card
          only needs a strip of it. */}
      <div className="@container [&>div]:h-24" aria-hidden="true">
        <Banner />
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-3 text-start">
        <div className="flex flex-wrap items-center gap-2">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent text-muted-foreground [&_svg]:size-3.5">
            <Icon className="size-3.5" />
          </span>
          <span dir="ltr" className="text-sm font-semibold tracking-tight text-foreground">
            {engine.label}
          </span>
          {!engine.available && (
            <Badge variant="secondary" size="sm">
              {msg("submit.blackbox.engines.not_runnable")}
            </Badge>
          )}
        </div>
        <span className="text-xs leading-relaxed text-muted-foreground">{engine.description}</span>
        {blocked ? (
          <span className="text-xs text-[var(--warning)]" dir="auto">
            {blockedNote ?? msg("submit.blackbox.validation.engine_parts")}
          </span>
        ) : (
          !engine.available &&
          engine.unavailable_reason && (
            <span className="text-xs text-[var(--warning)]" dir="auto">
              {engine.unavailable_reason}
            </span>
          )
        )}
      </div>
    </>
  );
}

interface EngineVisual {
  Banner: ComponentType;
  icon: ComponentType<{ className?: string }>;
}

// Each banner is the engine's search loop in the wizard's schematic grammar:
// plain boxes are versions, the accented one is the proposer or the winner.

function GepaBanner() {
  return (
    <BannerFrame>
      <GBox x={22} y={33} w={34} h={22} />
      <GBar x={30} y={40} w={18} />
      <GBar x={30} y={46} w={12} />
      <GWire d="M56 44 H80 C92 44 92 22 104 22" />
      <GWire d="M56 44 H104" />
      <GWire d="M56 44 H80 C92 44 92 66 104 66" />
      <GBox x={104} y={11} w={34} h={22} />
      <GBar x={112} y={18} w={18} />
      <GBox x={104} y={33} w={34} h={22} />
      <GBar x={112} y={40} w={18} />
      <GBox x={104} y={55} w={34} h={22} />
      <GBar x={112} y={62} w={18} />
      <GWire d="M138 22 H162 C174 22 174 44 186 44" />
      <GWire d="M138 66 H162 C174 66 174 44 186 44" />
      <GArrow x={190} y={44} dir="right" />
      <GBox x={190} y={31} w={34} h={26} accent />
      <GBar x={198} y={39} w={18} />
      <GBar x={198} y={45} w={12} />
    </BannerFrame>
  );
}

function BestOfNBanner() {
  return (
    <BannerFrame>
      <GBox x={22} y={33} w={34} h={22} accent />
      <GBar x={30} y={40} w={18} />
      <GBar x={30} y={46} w={12} />
      <GWire d="M56 44 H76 C88 44 88 16 100 16" />
      <GWire d="M56 44 H76 C88 44 88 35 100 35" />
      <GWire d="M56 44 H76 C88 44 88 54 100 54" />
      <GWire d="M56 44 H76 C88 44 88 73 100 73" />
      <GBox x={100} y={8} w={34} h={16} />
      <GBar x={108} y={15} w={18} />
      <GBox x={100} y={27} w={34} h={16} />
      <GBar x={108} y={34} w={18} />
      <GBox x={100} y={46} w={34} h={16} />
      <GBar x={108} y={53} w={18} />
      <GBox x={100} y={65} w={34} h={16} />
      <GBar x={108} y={72} w={18} />
      <GWire d="M134 35 H164 C176 35 176 44 188 44" />
      <GArrow x={192} y={44} dir="right" />
      <GBox x={192} y={33} w={30} h={22} accent />
      <GBar x={199} y={40} w={16} />
      <GBar x={199} y={46} w={10} />
    </BannerFrame>
  );
}

function AutoResearchBanner() {
  return (
    <BannerFrame>
      <GBox x={30} y={26} w={52} h={32} accent />
      <GBar x={40} y={34} w={30} />
      <GBar x={40} y={40} w={22} />
      <GBar x={40} y={46} w={26} />
      <GWire d="M82 42 H116 V20 H146" />
      <GArrow x={150} y={20} dir="right" />
      <GWire d="M116 42 H146" />
      <GArrow x={150} y={42} dir="right" />
      <GWire d="M116 42 V64 H146" />
      <GArrow x={150} y={64} dir="right" />
      <GBox x={150} y={13} w={60} h={14} />
      <GBar x={158} y={19} w={34} />
      <GBox x={150} y={35} w={60} h={14} accent />
      <GBar x={158} y={41} w={42} />
      <GBox x={150} y={57} w={60} h={14} />
      <GBar x={158} y={63} w={26} />
      <GWire d="M180 71 V80 H56 V62" />
      <GArrow x={56} y={58} dir="up" />
    </BannerFrame>
  );
}

function MetaHarnessBanner() {
  return (
    <BannerFrame>
      <GBox x={22} y={30} w={44} h={28} accent />
      <GBar x={30} y={38} w={26} />
      <GBar x={30} y={44} w={18} />
      <GBar x={30} y={50} w={22} />
      <GWire d="M66 44 H90 C102 44 102 22 114 22" />
      <GWire d="M66 44 H114" />
      <GWire d="M66 44 H90 C102 44 102 66 114 66" />
      <GBox x={114} y={13} w={30} h={18} />
      <GBar x={121} y={21} w={16} />
      <GBox x={114} y={35} w={30} h={18} />
      <GBar x={121} y={43} w={16} />
      <GBox x={114} y={57} w={30} h={18} />
      <GBar x={121} y={65} w={16} />
      <GWire d="M144 22 H166 C178 22 178 44 190 44" />
      <GWire d="M144 44 H190" />
      <GWire d="M144 66 H166 C178 66 178 44 190 44" />
      <GArrow x={194} y={44} dir="right" />
      <GBox x={194} y={33} w={28} h={22} />
      <GBar x={201} y={40} w={14} />
      <GBar x={201} y={46} w={10} />
      <GWire d="M208 55 V76 H44 V62" />
      <GArrow x={44} y={58} dir="up" />
    </BannerFrame>
  );
}

function AutoSaddlerBanner() {
  return (
    <BannerFrame>
      <GBox x={22} y={33} w={34} h={22} />
      <GBar x={30} y={40} w={18} />
      <GBar x={30} y={46} w={12} />
      <GWire d="M56 44 H76" />
      <GArrow x={80} y={44} dir="right" />
      <GBox x={80} y={29} w={44} h={30} accent />
      <GBar x={90} y={37} w={24} />
      <GBar x={90} y={43} w={18} />
      <GBar x={90} y={49} w={22} />
      <GWire d="M124 44 H144" />
      <GArrow x={148} y={44} dir="right" />
      <GBox x={148} y={33} w={34} h={22} />
      <GBar x={156} y={40} w={18} />
      <GBar x={156} y={46} w={12} />
      <GWire d="M182 44 H202" />
      <GArrow x={206} y={44} dir="right" />
      <GBox x={206} y={33} w={20} h={22} />
      <GBar x={211} y={40} w={10} />
      <GBar x={211} y={46} w={7} />
      <GWire d="M165 55 V72 H102 V63" />
      <GArrow x={102} y={59} dir="up" />
    </BannerFrame>
  );
}

// Two islands evolve apart through the shared model pool, and the dashed
// return path is migration between them.
function ShinkaEvolveBanner() {
  return (
    <BannerFrame>
      <GBox x={22} y={15} w={34} h={20} />
      <GBar x={30} y={23} w={18} />
      <GBox x={22} y={53} w={34} h={20} />
      <GBar x={30} y={61} w={14} />
      <GWire d="M56 25 H76 C86 25 86 44 96 44" />
      <GWire d="M56 63 H76 C86 63 86 44 96 44" />
      <GArrow x={100} y={44} dir="right" />
      <GBox x={100} y={29} w={40} h={30} accent />
      <GBar x={109} y={37} w={22} />
      <GBar x={109} y={43} w={16} />
      <GBar x={109} y={49} w={20} />
      <GWire d="M140 44 H150 C160 44 160 25 180 25" />
      <GWire d="M140 44 H150 C160 44 160 63 180 63" />
      <GArrow x={184} y={25} dir="right" />
      <GArrow x={184} y={63} dir="right" />
      <GBox x={184} y={15} w={34} h={20} />
      <GBar x={192} y={23} w={18} />
      <GBox x={184} y={53} w={34} h={20} />
      <GBar x={192} y={61} w={12} />
      <GWire d="M201 73 V82 H39 V78" />
      <GArrow x={39} y={73} dir="up" />
    </BannerFrame>
  );
}

// Auto runs a short trial of several optimizers side by side and then
// continues the leader, so the banner forks into lanes that converge.
function AutoBanner() {
  return (
    <BannerFrame>
      <GBox x={22} y={33} w={30} h={22} />
      <GBar x={29} y={40} w={16} />
      <GBar x={29} y={46} w={10} />
      <GWire d="M52 44 H70 C80 44 80 18 90 18" />
      <GWire d="M52 44 H90" />
      <GWire d="M52 44 H70 C80 44 80 70 90 70" />
      <GBar x={94} y={17} w={40} />
      <GBar x={94} y={43} w={58} />
      <GBar x={94} y={69} w={28} />
      <GWire d="M156 44 H176" />
      <GArrow x={180} y={44} dir="right" />
      <GBox x={180} y={31} w={42} h={26} accent />
      <GBar x={188} y={39} w={26} />
      <GBar x={188} y={45} w={18} />
    </BannerFrame>
  );
}

// DSPy GEPA: the program's predictors are rewritten from reflective feedback,
// several candidates per round, and the Pareto front feeds the next round.
function DspyGepaBanner() {
  return (
    <BannerFrame>
      <GBox x={22} y={22} w={40} h={44} />
      <GBar x={30} y={30} w={24} />
      <GBar x={30} y={41} w={18} />
      <GBar x={30} y={52} w={22} />
      <GWire d="M62 44 H84" />
      <GArrow x={88} y={44} dir="right" />
      <GBox x={88} y={30} w={40} h={28} accent />
      <GBar x={96} y={38} w={24} />
      <GBar x={96} y={44} w={16} />
      <GWire d="M128 44 H146 C156 44 156 24 166 24" />
      <GWire d="M128 44 H146 C156 44 156 64 166 64" />
      <GBox x={166} y={14} w={44} h={20} />
      <GBar x={174} y={22} w={26} />
      <GBox x={166} y={54} w={44} h={20} />
      <GBar x={174} y={62} w={20} />
      <GWire d="M188 74 V82 H42 V70" />
      <GArrow x={42} y={66} dir="up" />
    </BannerFrame>
  );
}

// MIPROv2 proposes instruction and demo candidates per predictor, then a
// search picks the best combination.
function DspyMiproBanner() {
  return (
    <BannerFrame>
      <GBox x={22} y={14} w={44} h={18} />
      <GBar x={30} y={21} w={26} />
      <GBox x={22} y={35} w={44} h={18} />
      <GBar x={30} y={42} w={20} />
      <GBox x={22} y={56} w={44} h={18} />
      <GBar x={30} y={63} w={24} />
      <GWire d="M66 23 H84 C96 23 96 44 108 44" />
      <GWire d="M66 44 H108" />
      <GWire d="M66 65 H84 C96 65 96 44 108 44" />
      <GArrow x={112} y={44} dir="right" />
      <GBox x={112} y={28} w={48} h={32} accent />
      <GBar x={121} y={36} w={30} />
      <GBar x={121} y={42} w={22} />
      <GBar x={121} y={48} w={26} />
      <GWire d="M160 44 H184" />
      <GArrow x={188} y={44} dir="right" />
      <GBox x={188} y={33} w={34} h={22} />
      <GBar x={196} y={40} w={18} />
      <GBar x={196} y={46} w={12} />
    </BannerFrame>
  );
}

// Bootstrap few-shot runs the program on training cases and keeps the traces
// that score well as demonstrations in the prompt.
function DspyBootstrapBanner() {
  return (
    <BannerFrame>
      <GBox x={22} y={33} w={34} h={22} />
      <GBar x={30} y={40} w={18} />
      <GBar x={30} y={46} w={12} />
      <GWire d="M56 44 H78" />
      <GArrow x={82} y={44} dir="right" />
      <GBox x={82} y={12} w={36} h={14} />
      <GBar x={89} y={18} w={22} />
      <GBox x={82} y={30} w={36} h={14} accent />
      <GBar x={89} y={36} w={22} />
      <GBox x={82} y={48} w={36} h={14} />
      <GBar x={89} y={54} w={18} />
      <GBox x={82} y={66} w={36} h={14} accent />
      <GBar x={89} y={72} w={20} />
      <GWire d="M118 37 H150 C160 37 160 44 170 44" />
      <GWire d="M118 73 H150 C160 73 160 44 170 44" />
      <GArrow x={174} y={44} dir="right" />
      <GBox x={174} y={26} w={48} h={36} accent />
      <GBar x={182} y={34} w={30} />
      <GBar x={182} y={41} w={22} />
      <GBar x={182} y={48} w={26} />
    </BannerFrame>
  );
}

function GenericBanner() {
  return (
    <BannerFrame>
      <GBox x={60} y={33} w={34} h={22} />
      <GBar x={68} y={40} w={18} />
      <GBar x={68} y={46} w={12} />
      <GWire d="M94 44 H140" />
      <GArrow x={144} y={44} dir="right" />
      <GBox x={144} y={31} w={36} h={26} accent />
      <GBar x={152} y={39} w={20} />
      <GBar x={152} y={45} w={14} />
    </BannerFrame>
  );
}

const GENERIC_VISUAL: EngineVisual = { Banner: GenericBanner, icon: Cube };

const ENGINE_VISUALS: Record<string, EngineVisual> = {
  auto: { Banner: AutoBanner, icon: MagicWand },
  dspy_gepa: { Banner: DspyGepaBanner, icon: GitBranch },
  dspy_miprov2: { Banner: DspyMiproBanner, icon: ListChecks },
  dspy_bootstrap_fewshot: { Banner: DspyBootstrapBanner, icon: Books },
  gepa: { Banner: GepaBanner, icon: GitBranch },
  best_of_n: { Banner: BestOfNBanner, icon: Shuffle },
  autoresearch: { Banner: AutoResearchBanner, icon: Robot },
  meta_harness: { Banner: MetaHarnessBanner, icon: Wrench },
  autosaddler: { Banner: AutoSaddlerBanner, icon: ArrowsClockwise },
  shinka_evolve: { Banner: ShinkaEvolveBanner, icon: SquaresFour },
};
