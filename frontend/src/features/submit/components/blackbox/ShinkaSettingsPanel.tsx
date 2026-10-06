"use client";

import type { ReactNode } from "react";

import { HelpTip } from "@/shared/ui/help-tip";
import { NumberInput } from "@/shared/ui/number-input";
import { Label } from "@/shared/ui/primitives/label";
import { Switch } from "@/shared/ui/primitives/switch";
import { Segmented } from "@/shared/ui/segmented";
import { msg } from "@/shared/lib/messages";
import { tip, type TooltipKey } from "@/shared/lib/tooltips";
import type { MessageKey } from "@/shared/lib/generated/ui-catalog";
import type { BlackboxShinkaParentSelection } from "@/shared/types/api";

import type { BlackboxWizardContext } from "../../hooks/use-blackbox-wizard";
import {
  PARENT_SELECTION_FIELDS,
  SHINKA_LIMITS,
  SHINKA_PATCH_KINDS,
  patchPercent,
  setPatchPercent,
  type ShinkaStepperField,
} from "../../lib/shinka-settings";
import { Disclosure } from "../Disclosure";
import { Field } from "./shared";

// Duplicate rejection needs the gateway embeddings route; until it ships the backend refuses it.
const SHINKA_NOVELTY_READY = false;

const PARENT_SELECTIONS: readonly BlackboxShinkaParentSelection[] = [
  "weighted",
  "power_law",
  "beam_search",
];

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-3">
      <legend className="mb-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

/**
 * ShinkaEvolve's search settings, folded behind a disclosure in the settings
 * step. Every control starts at the backend's default, so a closed panel and
 * an untouched open one submit the same run.
 */
export function ShinkaSettingsPanel({ w }: { w: BlackboxWizardContext }) {
  const { shinkaSettings: s, updateShinka, setShinkaSettings, shinkaOpen, setShinkaOpen } = w;

  const numberField = (field: ShinkaStepperField) => {
    const { min, max, step } = SHINKA_LIMITS[field];
    const id = `bb-shinka-${field}`;
    return (
      <Field
        key={field}
        label={msg(`submit.blackbox.shinka.${field}` as MessageKey)}
        htmlFor={id}
        tip={`submit.blackbox.shinka.${field}` as TooltipKey}
      >
        <NumberInput
          id={id}
          value={s[field]}
          onChange={(value) => updateShinka({ [field]: value })}
          min={min}
          max={max}
          step={step}
        />
      </Field>
    );
  };

  const toggle = (field: "use_text_feedback" | "novelty" | "meta_notes") => {
    const id = `bb-shinka-${field}`;
    return (
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id} className="cursor-pointer">
          <HelpTip text={tip(`submit.blackbox.shinka.${field}` as TooltipKey)}>
            {msg(`submit.blackbox.shinka.${field}` as MessageKey)}
          </HelpTip>
        </Label>
        <Switch
          id={id}
          checked={s[field]}
          onCheckedChange={(checked) => updateShinka({ [field]: checked })}
        />
      </div>
    );
  };

  return (
    <Disclosure
      id="bb-shinka-settings"
      label={msg("submit.blackbox.shinka.title")}
      tip={tip("submit.blackbox.shinka.title")}
      open={shinkaOpen}
      onOpenChange={setShinkaOpen}
    >
      <div className="space-y-6 pt-2 pb-1">
        <Group title={msg("submit.blackbox.shinka.group.search")}>
          <div className="grid gap-4 sm:grid-cols-2">
            {numberField("num_islands")}
            {numberField("migration_interval")}
            {numberField("migration_rate")}
          </div>
          <Field
            label={msg("submit.blackbox.shinka.parent_selection")}
            tip="submit.blackbox.shinka.parent_selection"
          >
            <Segmented<BlackboxShinkaParentSelection>
              label={msg("submit.blackbox.shinka.parent_selection")}
              value={s.parent_selection}
              onChange={(value) => updateShinka({ parent_selection: value })}
              options={PARENT_SELECTIONS.map((value) => ({
                value,
                label: msg(`submit.blackbox.shinka.parent_selection.${value}`),
                tip: tip(`submit.blackbox.shinka.parent_selection.${value}`),
              }))}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            {PARENT_SELECTION_FIELDS[s.parent_selection].map(numberField)}
          </div>
        </Group>

        <Group title={msg("submit.blackbox.shinka.group.changes")}>
          <div className="grid gap-4 sm:grid-cols-3">
            {SHINKA_PATCH_KINDS.map((kind) => {
              const id = `bb-shinka-${kind}`;
              return (
                <Field
                  key={kind}
                  label={msg(`submit.blackbox.shinka.${kind}`)}
                  htmlFor={id}
                  tip={`submit.blackbox.shinka.${kind}`}
                >
                  <NumberInput
                    id={id}
                    value={patchPercent(s[kind])}
                    onChange={(value) =>
                      setShinkaSettings((prev) => setPatchPercent(prev, kind, value))
                    }
                    min={0}
                    max={100}
                    step={5}
                  />
                </Field>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            {msg("submit.blackbox.shinka.patch_mix_hint")}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {numberField("max_patch_attempts")}
            {numberField("max_patch_resamples")}
          </div>
        </Group>

        <Group title={msg("submit.blackbox.shinka.group.archive")}>
          <div className="grid gap-4 sm:grid-cols-2">
            {numberField("archive_size")}
            {numberField("elite_selection_ratio")}
            {numberField("num_archive_inspirations")}
            {numberField("num_top_k_inspirations")}
          </div>
        </Group>

        <Group title={msg("submit.blackbox.shinka.group.extras")}>
          {toggle("use_text_feedback")}
          {SHINKA_NOVELTY_READY && toggle("novelty")}
          {SHINKA_NOVELTY_READY && s.novelty && (
            <div className="grid gap-4 sm:grid-cols-2">
              {numberField("code_embed_sim_threshold")}
              {numberField("max_novelty_attempts")}
            </div>
          )}
          {toggle("meta_notes")}
          {s.meta_notes && (
            <div className="grid gap-4 sm:grid-cols-2">
              {numberField("meta_rec_interval")}
              {numberField("meta_max_recommendations")}
            </div>
          )}
        </Group>

        <Group title={msg("submit.blackbox.shinka.group.parallelism")}>
          <div className="grid gap-4 sm:grid-cols-2">
            {numberField("max_parallel_evaluations")}
            {numberField("max_parallel_proposals")}
          </div>
        </Group>
      </div>
    </Disclosure>
  );
}
