"use client";

import * as React from "react";
import { msg, type MessageKey } from "@/shared/lib/messages";
import {
  JSON_TYPES,
  NAME_PATTERN,
  NORMALIZE_OPS,
  scoreRule,
  type Extract,
  type JsonType,
  type RewardEntry,
  type RewardRule,
} from "@/shared/lib/reward-rules";
import { cn } from "@/shared/lib/utils";
import { Plus, Trash } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/primitives/dialog";
import { Input } from "@/shared/ui/primitives/input";
import { Label } from "@/shared/ui/primitives/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/primitives/tabs";
import { Textarea } from "@/shared/ui/primitives/textarea";
import { Segmented } from "@/shared/ui/segmented";
import { reasonText, ruleTypeLabel, signed } from "./reward-text";

/** A number field that keeps what the user types and reports each valid number. */
function NumField({
  label,
  value,
  onChange,
  min,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
}) {
  const id = React.useId();
  const [text, setText] = React.useState(String(value));
  React.useEffect(() => {
    setText((prev) => (Number(prev) === value ? prev : String(value)));
  }, [value]);
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        dir="ltr"
        inputMode="decimal"
        value={text}
        aria-invalid={!Number.isFinite(Number(text)) || text.trim() === "" || undefined}
        onChange={(e) => {
          setText(e.target.value);
          const next = Number(e.target.value);
          if (
            e.target.value.trim() !== "" &&
            Number.isFinite(next) &&
            (min === undefined || next >= min)
          ) {
            onChange(next);
          }
        }}
        className="h-8 font-mono text-xs"
      />
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  mono = false,
  invalid = false,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  mono?: boolean;
  invalid?: boolean;
  hint?: string;
}) {
  const id = React.useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        dir={mono ? "ltr" : "auto"}
        value={value}
        aria-invalid={invalid || undefined}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => onChange(e.target.value)}
        className={cn("h-8 text-xs", mono && "font-mono")}
      />
      {hint && (
        <p
          id={`${id}-hint`}
          className={cn(
            "text-[0.6875rem]",
            invalid ? "text-[var(--danger)]" : "text-muted-foreground",
          )}
        >
          {hint}
        </p>
      )}
    </div>
  );
}

type ExtractMode = "none" | "between" | "regex";

function ExtractFields({
  value,
  onChange,
}: {
  value: Extract | undefined;
  onChange: (value: Extract | undefined) => void;
}) {
  const mode: ExtractMode = !value ? "none" : "between" in value ? "between" : "regex";
  return (
    <div className="space-y-3">
      <Segmented<ExtractMode>
        size="sm"
        label={msg("reward_builder.extract.label")}
        value={mode}
        onChange={(next) =>
          onChange(
            next === "none"
              ? undefined
              : next === "between"
                ? { between: ["<answer>", "</answer>"] }
                : { regex: "" },
          )
        }
        options={(["none", "between", "regex"] as const).map((m) => ({
          value: m,
          label: msg(`reward_builder.extract.${m}` as MessageKey),
        }))}
      />
      {value && "between" in value && (
        <div className="grid grid-cols-2 gap-2">
          <TextField
            label={msg("reward_builder.extract.start")}
            value={value.between[0]}
            mono
            onChange={(start) => onChange({ between: [start, value.between[1]] })}
          />
          <TextField
            label={msg("reward_builder.extract.end")}
            value={value.between[1]}
            mono
            onChange={(end) => onChange({ between: [value.between[0], end] })}
          />
        </div>
      )}
      {value && "regex" in value && (
        <TextField
          label={msg("reward_builder.extract.pattern")}
          value={value.regex}
          mono
          hint={msg("reward_builder.extract.pattern_hint")}
          onChange={(regex) => onChange({ regex })}
        />
      )}
      <p className="text-xs text-muted-foreground">
        {msg(`reward_builder.extract.${mode}_hint` as MessageKey)}
      </p>
    </div>
  );
}

function ConfigFields({
  rule,
  onChange,
}: {
  rule: RewardRule;
  onChange: (rule: RewardRule) => void;
}) {
  const t = (key: string) => msg(`reward_builder.field.${key}` as MessageKey);
  if (rule.type === "regex") {
    return (
      <div className="space-y-3">
        <TextField
          label={t("pattern")}
          value={rule.pattern}
          mono
          onChange={(pattern) => onChange({ ...rule, pattern })}
        />
        <Segmented<"search" | "fullmatch">
          size="sm"
          label={t("mode")}
          value={rule.mode}
          onChange={(mode) => onChange({ ...rule, mode })}
          options={[
            { value: "search", label: t("mode_search") },
            { value: "fullmatch", label: t("mode_fullmatch") },
          ]}
        />
        <div className="grid grid-cols-2 gap-2">
          <NumField
            label={t("match")}
            value={rule.score.match}
            onChange={(match) => onChange({ ...rule, score: { ...rule.score, match } })}
          />
          <NumField
            label={t("miss")}
            value={rule.score.miss}
            onChange={(miss) => onChange({ ...rule, score: { ...rule.score, miss } })}
          />
        </div>
      </div>
    );
  }
  if (rule.type === "length") {
    return (
      <div className="space-y-3">
        <NumField
          label={t("max_chars")}
          value={rule.max_chars}
          min={0}
          onChange={(max_chars) => onChange({ ...rule, max_chars })}
        />
        <div className="grid grid-cols-2 gap-2">
          <NumField
            label={t("under")}
            value={rule.score.under}
            onChange={(under) => onChange({ ...rule, score: { ...rule.score, under } })}
          />
          <NumField
            label={t("over")}
            value={rule.score.over}
            onChange={(over) => onChange({ ...rule, score: { ...rule.score, over } })}
          />
        </div>
      </div>
    );
  }
  if (rule.type === "json_schema") {
    return (
      <div className="space-y-3">
        <Segmented<JsonType>
          size="sm"
          label={t("json_type")}
          value={rule.schema.type}
          onChange={(type) => onChange({ ...rule, schema: { ...rule.schema, type } })}
          options={JSON_TYPES.map((type) => ({ value: type, label: type }))}
        />
        {rule.schema.type === "object" && (
          <TextField
            label={t("required")}
            value={rule.schema.required.join(", ")}
            mono
            hint={t("required_hint")}
            onChange={(text) =>
              onChange({
                ...rule,
                schema: {
                  ...rule.schema,
                  required: text
                    .split(",")
                    .map((k) => k.trim())
                    .filter(Boolean),
                },
              })
            }
          />
        )}
        <div className="grid grid-cols-2 gap-2">
          <NumField
            label={t("match")}
            value={rule.score.match}
            onChange={(match) => onChange({ ...rule, score: { ...rule.score, match } })}
          />
          <NumField
            label={t("miss")}
            value={rule.score.miss}
            onChange={(miss) => onChange({ ...rule, score: { ...rule.score, miss } })}
          />
        </div>
      </div>
    );
  }
  const compare = (
    <TextField
      label={t("compare_to")}
      value={rule.compare_to}
      mono
      onChange={(compare_to) => onChange({ ...rule, compare_to })}
    />
  );
  if (rule.type === "exact_match") {
    return (
      <div className="space-y-3">
        {compare}
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium">{t("normalize")}</legend>
          <div className="flex flex-wrap gap-1.5">
            {NORMALIZE_OPS.map((op) => {
              const on = rule.normalize.includes(op);
              return (
                <button
                  key={op}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    onChange({
                      ...rule,
                      normalize: on
                        ? rule.normalize.filter((o) => o !== op)
                        : [...rule.normalize, op],
                    })
                  }
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-xs",
                    on
                      ? "border-primary-fill bg-primary-fill text-primary-foreground"
                      : "border-border/70 hover:bg-accent",
                  )}
                >
                  {msg(`reward_builder.normalize.${op}` as MessageKey)}
                </button>
              );
            })}
          </div>
        </fieldset>
        <div className="grid grid-cols-3 gap-2">
          <NumField
            label={t("match")}
            value={rule.score.match}
            onChange={(match) => onChange({ ...rule, score: { ...rule.score, match } })}
          />
          <NumField
            label={t("miss")}
            value={rule.score.miss}
            onChange={(miss) => onChange({ ...rule, score: { ...rule.score, miss } })}
          />
          <NumField
            label={t("missing")}
            value={rule.missing}
            onChange={(missing) => onChange({ ...rule, missing })}
          />
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {compare}
      <fieldset className="space-y-2">
        <legend className="text-xs font-medium">{t("bands")}</legend>
        <p className="text-[0.6875rem] text-muted-foreground">{t("bands_hint")}</p>
        {rule.bands.map((band, index) => (
          <div key={index} className="flex items-end gap-2">
            <div className="flex-1">
              <NumField
                label={t("within")}
                value={band.within}
                min={0}
                onChange={(within) =>
                  onChange({
                    ...rule,
                    bands: rule.bands.map((b, i) => (i === index ? { ...b, within } : b)),
                  })
                }
              />
            </div>
            <div className="flex-1">
              <NumField
                label={t("score")}
                value={band.score}
                onChange={(score) =>
                  onChange({
                    ...rule,
                    bands: rule.bands.map((b, i) => (i === index ? { ...b, score } : b)),
                  })
                }
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("remove_band")}
              onClick={() => onChange({ ...rule, bands: rule.bands.filter((_, i) => i !== index) })}
            >
              <Trash className="size-3.5" />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => onChange({ ...rule, bands: [...rule.bands, { within: 0.1, score: 0 }] })}
        >
          <Plus />
          {t("add_band")}
        </Button>
      </fieldset>
      <div className="grid grid-cols-2 gap-2">
        <NumField
          label={t("else")}
          value={rule.else}
          onChange={(value) => onChange({ ...rule, else: value })}
        />
        <NumField
          label={t("missing")}
          value={rule.missing}
          onChange={(missing) => onChange({ ...rule, missing })}
        />
      </div>
    </div>
  );
}

function RuleTest({ rule, expectedField }: { rule: RewardRule; expectedField: string }) {
  const id = React.useId();
  const [reply, setReply] = React.useState("");
  const [expected, setExpected] = React.useState("");
  const field = "compare_to" in rule ? rule.compare_to : expectedField;
  const result = scoreRule(rule, reply, { [field]: expected });
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor={`${id}-reply`} className="text-xs">
          {msg("reward_builder.try.reply")}
        </Label>
        <Textarea
          id={`${id}-reply`}
          dir="auto"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          className="min-h-20 font-mono text-xs"
        />
      </div>
      {"compare_to" in rule && (
        <div className="space-y-1">
          <Label htmlFor={`${id}-expected`} className="text-xs">
            {msg("reward_builder.try.expected", { field })}
          </Label>
          <Input
            id={`${id}-expected`}
            dir="auto"
            value={expected}
            onChange={(e) => setExpected(e.target.value)}
            className="h-8 font-mono text-xs"
          />
        </div>
      )}
      <p aria-live="polite" data-test-score className="rounded-md bg-muted/40 px-3 py-2 text-xs">
        <span className="font-mono font-semibold">
          <bdi dir="ltr">{signed(result.score)}</bdi>
        </span>{" "}
        · {reasonText(result.reason)}
      </p>
    </div>
  );
}

/**
 * The dialog that edits one reward (SKY-84): its name and description, then
 * Configuration, Extraction and Test tabs, as in Unsloth Studio's editor.
 *
 * Args:
 *   entry: The reward to edit, or null when the dialog is closed.
 *   taken: The other rewards' names, which this one may not reuse.
 *   expectedField: The run's expected column, for the Test tab.
 *   onSave: Keep the edited reward.
 *   onClose: Close without keeping the edits.
 */
export function RewardRuleEditor({
  entry,
  taken,
  expectedField,
  onSave,
  onClose,
}: {
  entry: RewardEntry | null;
  taken: readonly string[];
  expectedField: string;
  onSave: (entry: RewardEntry) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = React.useState<RewardEntry | null>(entry);
  React.useEffect(() => setDraft(entry), [entry]);
  if (!draft) return null;
  const nameIssue = !NAME_PATTERN.test(draft.name)
    ? msg("reward_builder.field.name_bad")
    : taken.includes(draft.name)
      ? msg("reward_builder.field.name_taken")
      : null;
  const extractable = draft.rule.type !== "regex" && draft.rule.type !== "length";
  const setRule = (rule: RewardRule) => setDraft({ ...draft, rule });
  return (
    <Dialog open={entry !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[min(36rem,92vw)]">
        <DialogHeader>
          <DialogTitle>
            {msg("reward_builder.editor.title", { type: ruleTypeLabel(draft.rule.type) })}
          </DialogTitle>
          <DialogDescription>{msg("reward_builder.editor.desc")}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-[1fr_6rem] gap-2">
          <TextField
            label={msg("reward_builder.field.name")}
            value={draft.name}
            mono
            invalid={nameIssue !== null}
            hint={nameIssue ?? undefined}
            onChange={(name) => setDraft({ ...draft, name: name.toLowerCase() })}
          />
          <NumField
            label={msg("reward_builder.field.weight")}
            value={draft.weight}
            min={0}
            onChange={(weight) => setDraft({ ...draft, weight })}
          />
        </div>
        <TextField
          label={msg("reward_builder.field.description")}
          value={draft.description}
          onChange={(description) => setDraft({ ...draft, description })}
        />
        <Tabs defaultValue="config">
          <TabsList>
            <TabsTrigger value="config">{msg("reward_builder.editor.config")}</TabsTrigger>
            <TabsTrigger value="extract" disabled={!extractable}>
              {msg("reward_builder.editor.extract")}
            </TabsTrigger>
            <TabsTrigger value="test">{msg("reward_builder.editor.test")}</TabsTrigger>
          </TabsList>
          <TabsContent value="config" className="mt-3">
            <ConfigFields rule={draft.rule} onChange={setRule} />
          </TabsContent>
          <TabsContent value="extract" className="mt-3">
            {extractable && (
              <ExtractFields
                value={(draft.rule as { extract?: Extract }).extract}
                onChange={(extract) => setRule({ ...draft.rule, extract } as RewardRule)}
              />
            )}
          </TabsContent>
          <TabsContent value="test" className="mt-3">
            <RuleTest rule={draft.rule} expectedField={expectedField} />
          </TabsContent>
        </Tabs>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {msg("reward_builder.cancel")}
          </Button>
          <Button type="button" disabled={nameIssue !== null} onClick={() => onSave(draft)}>
            {msg("reward_builder.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
