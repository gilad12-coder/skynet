"use client";

import * as React from "react";
import { msg, type MessageKey } from "@/shared/lib/messages";
import { rewardFormatters, rewardPartLabel } from "@/shared/lib/reward-format";
import { rewardFromMarkdown, rewardToMarkdown } from "@/shared/lib/reward-md";
import {
  bundledRewards,
  buildIssues,
  customReward,
  uniqueName,
  type BuildIssue,
  type RewardBuild,
  type RewardEntry,
  type RuleType,
} from "@/shared/lib/reward-rules";
import { cn } from "@/shared/lib/utils";
import { useCopyToClipboard } from "@/shared/ui/copy-button";
import {
  BracketsCurly,
  CaretDown,
  Check,
  Coins,
  DotsThree,
  DownloadSimple,
  Hash,
  PencilSimple,
  Plus,
  Ruler,
  TextT,
  Timer,
  Trophy,
  UploadSimple,
} from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/primitives/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/primitives/dropdown-menu";
import { Input } from "@/shared/ui/primitives/input";
import { Label } from "@/shared/ui/primitives/label";
import { Textarea } from "@/shared/ui/primitives/textarea";
import { SelectCheckbox, checkboxBoxClass } from "@/shared/ui/select-checkbox";
import { TooltipButton } from "@/shared/ui/tooltip-button";
import { RewardRuleEditor, type RewardEditMode } from "./reward-rule-editor";
import { importErrorText, plain, ruleSummary } from "./reward-text";
import { RewardTryIt, type RewardSample } from "./reward-try-it";

// Unsloth Studio's limit on the rewards in one run.
export const MAX_REWARDS = 16;

const TYPE_ICON: Record<RuleType, typeof Check> = {
  exact_match: Check,
  numeric: Hash,
  regex: TextT,
  json_schema: BracketsCurly,
  length: Ruler,
};

/** One issue that stops the build from becoming a valid metric, as text. */
function issueText(issue: BuildIssue): string {
  if (issue.code === "bad_reference") {
    return msg("reward_builder.issue.bad_reference", { part: rewardPartLabel(issue.part) });
  }
  if ("name" in issue) return msg(`reward_builder.issue.${issue.code}`, { name: issue.name });
  return msg(`reward_builder.issue.${issue.code}`);
}

/** A built-in reward's description in the active locale. */
function bundledText(name: string): string {
  return msg(`reward_builder.bundled.${name.replace(/-/g, "_")}` as MessageKey);
}

/** Save a text as a file the browser downloads. */
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** A small number field for a weight or a reference, kept as typed until valid. */
function InlineNumber({
  value,
  onChange,
  label,
  className,
}: {
  value: number;
  onChange: (value: number) => void;
  label: string;
  className?: string;
}) {
  const [text, setText] = React.useState(String(value));
  React.useEffect(() => {
    setText((prev) => (Number(prev) === value ? prev : String(value)));
  }, [value]);
  return (
    <Input
      dir="ltr"
      inputMode="decimal"
      aria-label={label}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const next = Number(e.target.value);
        if (e.target.value.trim() !== "" && Number.isFinite(next) && next >= 0) onChange(next);
      }}
      className={cn("h-8 w-16 px-1.5 text-center font-mono text-xs", className)}
    />
  );
}

/** The rounded square that holds a row's icon. */
function IconTile({ icon: Icon }: { icon: typeof Check }) {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
      <Icon className="size-4" aria-hidden />
    </span>
  );
}

/** The weight cell of a row: "×" and the weight, as a field or as text. */
function WeightCell({
  value,
  readOnly,
  label,
  onChange,
}: {
  value: number;
  readOnly: boolean;
  label: string;
  onChange: (value: number) => void;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
      <span aria-hidden>×</span>
      {readOnly ? (
        <span className="font-mono tabular-nums text-foreground">{plain(value)}</span>
      ) : (
        <InlineNumber value={value} onChange={onChange} label={label} />
      )}
    </span>
  );
}

// Rows share one grid so the weights and menus line up down the list.
const ROW = "grid grid-cols-[2rem_minmax(0,1fr)_auto_2rem] items-center gap-3 px-4 py-3";

function RewardRow({
  entry,
  readOnly,
  onEdit,
  onRemove,
  onWeight,
}: {
  entry: RewardEntry;
  readOnly: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onWeight: (weight: number) => void;
}) {
  const { copy } = useCopyToClipboard();
  const bundled = entry.source === "bundled";
  return (
    <li data-reward={entry.name} className={ROW}>
      <IconTile icon={TYPE_ICON[entry.rule.type]} />
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <bdi dir="ltr" className="truncate font-mono text-sm font-medium">
            {entry.name}
          </bdi>
          <span
            className={cn(
              "shrink-0 rounded-full px-1.5 text-[0.625rem] font-medium",
              bundled ? "bg-muted text-muted-foreground" : "bg-primary-fill/15 text-foreground",
            )}
          >
            {msg(bundled ? "reward_builder.bundled" : "reward_builder.yours")}
          </span>
        </div>
        <p className="truncate text-xs text-muted-foreground">{ruleSummary(entry.rule)}</p>
      </div>
      <WeightCell
        value={entry.weight}
        readOnly={readOnly}
        label={msg("reward_builder.weight_of", { name: entry.name })}
        onChange={onWeight}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={msg("reward_builder.row_menu", { name: entry.name })}
          >
            <DotsThree className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {!readOnly && (
            <DropdownMenuItem onSelect={onEdit}>
              <PencilSimple className="size-3.5" aria-hidden />
              {msg(bundled ? "reward_builder.customize" : "reward_builder.edit")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => void copy(rewardToMarkdown(entry))}>
            {msg("reward_builder.export.copy")}
          </DropdownMenuItem>
          {!readOnly && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onRemove} className="text-[var(--danger)]">
                {msg("reward_builder.remove")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/** Speed or cost (SKY-69): a row like a reward's, with its reference instead of a summary. */
function PartRow({
  part,
  build,
  readOnly,
  onChange,
}: {
  part: "speed" | "cost";
  build: RewardBuild;
  readOnly: boolean;
  onChange: (build: RewardBuild) => void;
}) {
  const f = rewardFormatters();
  const value = build[part];
  const label = rewardPartLabel(part);
  const set = (next: Partial<typeof value>) =>
    onChange({ ...build, [part]: { ...value, ...next } });
  return (
    <li data-part={part} className={ROW}>
      <IconTile icon={part === "speed" ? Timer : Coins} />
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <span>
            {msg(
              part === "speed" ? "reward_builder.part.speed_ref" : "reward_builder.part.cost_ref",
            )}
          </span>
          {readOnly ? (
            <bdi className="font-mono text-foreground">
              {part === "speed" ? f.ms(value.reference) : f.usd(value.reference)}
            </bdi>
          ) : (
            <InlineNumber
              value={value.reference}
              onChange={(reference) => set({ reference })}
              label={msg("reward_builder.part.reference_of", { part: label })}
              className="h-7 w-20"
            />
          )}
        </div>
      </div>
      <WeightCell
        value={value.weight}
        readOnly={readOnly}
        label={msg("reward_builder.weight_of", { name: label })}
        onChange={(weight) => set({ weight })}
      />
      <span aria-hidden />
    </li>
  );
}

/** The Export menu: tick rewards, then download each as its REWARD.md. */
function ExportMenu({ rewards }: { rewards: readonly RewardEntry[] }) {
  const [picked, setPicked] = React.useState<ReadonlySet<string>>(new Set());
  const names = rewards.map((r) => r.name);
  const chosen = names.filter((name) => picked.has(name));
  const all = chosen.length === names.length && names.length > 0;
  const toggle = (name: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  return (
    <DropdownMenu onOpenChange={(open) => open && setPicked(new Set(names))}>
      <TooltipButton tooltip={msg("reward_builder.export.title")}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={msg("reward_builder.export.title")}
            disabled={names.length === 0}
          >
            <DownloadSimple />
          </Button>
        </DropdownMenuTrigger>
      </TooltipButton>
      <DropdownMenuContent align="end" className="w-72 p-0">
        <div className="max-h-72 overflow-y-auto p-1">
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setPicked(all ? new Set() : new Set(names));
            }}
          >
            <span
              className={checkboxBoxClass(all ? true : chosen.length > 0 ? "mixed" : false)}
              aria-hidden
            >
              {chosen.length > 0 && <Check className="size-3.5" />}
            </span>
            {msg("reward_builder.export.all")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {rewards.map((entry) => {
            const Icon = TYPE_ICON[entry.rule.type];
            const on = picked.has(entry.name);
            return (
              <DropdownMenuItem
                key={entry.name}
                role="menuitemcheckbox"
                aria-checked={on}
                onSelect={(e) => {
                  e.preventDefault();
                  toggle(entry.name);
                }}
                className="items-start"
              >
                <Icon className="mt-0.5 size-3.5 text-muted-foreground" aria-hidden />
                <span className="flex min-w-0 flex-1 flex-col">
                  <bdi dir="ltr" className="truncate font-mono text-xs">
                    {entry.name}
                  </bdi>
                  {entry.description && (
                    <span className="truncate text-[0.6875rem] text-muted-foreground">
                      {entry.source === "bundled" ? bundledText(entry.name) : entry.description}
                    </span>
                  )}
                </span>
                <span className={checkboxBoxClass(on)} aria-hidden>
                  {on && <Check className="size-3.5" />}
                </span>
              </DropdownMenuItem>
            );
          })}
        </div>
        <div className="border-t border-border/60 p-2">
          <Button
            type="button"
            size="sm"
            className="w-full"
            disabled={chosen.length === 0}
            onClick={() => {
              for (const entry of rewards) {
                if (picked.has(entry.name)) download(`${entry.name}.md`, rewardToMarkdown(entry));
              }
            }}
          >
            {msg("reward_builder.export.selected", { count: String(chosen.length) })}
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The REWARD.md import dialog: one or more files, or pasted text. */
function ImportDialog({
  open,
  onClose,
  onImport,
  expectedField,
}: {
  open: boolean;
  onClose: () => void;
  onImport: (entries: RewardEntry[], replace: boolean) => void;
  expectedField: string;
}) {
  const id = React.useId();
  const [text, setText] = React.useState("");
  const [replace, setReplace] = React.useState(false);
  const [errors, setErrors] = React.useState<string[]>([]);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const take = (sources: Array<{ label: string; text: string }>) => {
    const entries: RewardEntry[] = [];
    const failed: string[] = [];
    for (const source of sources) {
      const read = rewardFromMarkdown(source.text, expectedField);
      if (read.ok) entries.push({ ...read.entry, weight: 1 });
      else failed.push(`${source.label}: ${importErrorText(read.error, read.detail)}`);
    }
    setErrors(failed);
    if (entries.length > 0) onImport(entries, replace);
    // What imported is in the build now; only the failures stay to retry,
    // so a second Import does not add the good ones again.
    if (failed.length === 0 || entries.length > 0) setText("");
    if (failed.length === 0) onClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setErrors([]);
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{msg("reward_builder.import.title")}</DialogTitle>
          <DialogDescription>{msg("reward_builder.import.desc")}</DialogDescription>
        </DialogHeader>
        <input
          ref={fileRef}
          type="file"
          accept=".md,text/markdown,text/plain"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={async (e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            take(
              await Promise.all(
                files.map(async (file) => ({ label: file.name, text: await file.text() })),
              ),
            );
          }}
        />
        <Button type="button" variant="outline" onClick={() => fileRef.current?.click()}>
          <UploadSimple />
          {msg("reward_builder.import.files")}
        </Button>
        <div className="space-y-1">
          <Label htmlFor={`${id}-paste`}>{msg("reward_builder.import.paste")}</Label>
          <Textarea
            id={`${id}-paste`}
            dir="ltr"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"---\nname: my-reward\nkind: rule\n---\ntype: regex\n..."}
            className="min-h-32 font-mono text-xs"
          />
        </div>
        <label className="flex items-center gap-2 text-xs">
          <SelectCheckbox
            checked={replace}
            onToggle={() => setReplace((v) => !v)}
            ariaLabel={msg("reward_builder.import.replace")}
          />
          {msg("reward_builder.import.replace")}
        </label>
        {errors.length > 0 && (
          <ul role="alert" className="space-y-1 text-xs text-[var(--danger)]">
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {msg("reward_builder.cancel")}
          </Button>
          <Button
            type="button"
            disabled={!text.trim()}
            onClick={() => take([{ label: msg("reward_builder.import.pasted"), text }])}
          >
            {msg("reward_builder.import.action")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The Rewards card (SKY-84), laid out like Unsloth Studio's: a header with
 * the title and the Import and Export buttons; one row per reward with its
 * icon, name, badge, summary, weight and menu; the SKY-69 Speed and Cost rows;
 * a full-width "Add reward" menu of built-in rewards and "Custom"; then
 * "Try it". Read-only, it shows the same rows for a finished run.
 *
 * Args:
 *   build: The rewards.
 *   onChange: Keep a changed build; omit for a read-only view.
 *   expectedField: The run's expected column.
 *   samples: Cases for "Try it".
 *   tryIt: Whether the card ends with "Try it".
 */
export function RewardBuilder({
  build,
  onChange,
  expectedField,
  samples = [],
  tryIt = true,
  className,
}: {
  build: RewardBuild;
  onChange?: (build: RewardBuild) => void;
  expectedField: string;
  samples?: readonly RewardSample[];
  tryIt?: boolean;
  className?: string;
}) {
  const readOnly = !onChange;
  const [editing, setEditing] = React.useState<{
    index: number | null;
    entry: RewardEntry;
    mode: RewardEditMode;
  } | null>(null);
  const [importing, setImporting] = React.useState(false);
  const change = onChange ?? (() => undefined);
  const names = build.rewards.map((r) => r.name);
  const issues = buildIssues(build);
  const full = build.rewards.length >= MAX_REWARDS;
  const addable = bundledRewards(expectedField).filter((entry) => !names.includes(entry.name));

  const add = (entries: RewardEntry[], replace = false) => {
    let rewards = [...build.rewards];
    for (const entry of entries) {
      const at = replace ? rewards.findIndex((r) => r.name === entry.name) : -1;
      if (at >= 0) {
        rewards[at] = { ...entry, weight: rewards[at]!.weight };
        continue;
      }
      if (rewards.length >= MAX_REWARDS) break;
      const name = uniqueName(
        entry.name,
        rewards.map((r) => r.name),
      );
      rewards = [...rewards, { ...entry, name }];
    }
    change({ ...build, rewards });
  };

  return (
    <section
      aria-labelledby="reward-builder-title"
      className={cn("rounded-2xl border border-border/60 bg-card", className)}
    >
      <header className="flex items-start gap-3 px-4 py-4 sm:px-5">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary-fill/15 text-foreground">
          <Trophy className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id="reward-builder-title" className="text-base font-semibold">
            {msg("reward_builder.title")}
          </h3>
          <p className="text-xs text-muted-foreground">{msg("reward_builder.desc")}</p>
        </div>
        {!readOnly && (
          <div className="flex shrink-0 items-center gap-1.5">
            <TooltipButton tooltip={msg("reward_builder.import.title")}>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label={msg("reward_builder.import.title")}
                onClick={() => setImporting(true)}
              >
                <UploadSimple />
              </Button>
            </TooltipButton>
            <ExportMenu rewards={build.rewards} />
          </div>
        )}
      </header>

      {!readOnly && build.rewards.length === 0 && (
        <p role="status" className="px-4 pb-3 text-xs text-[var(--warning)] sm:px-5">
          {msg("reward_builder.empty")}
        </p>
      )}
      <ul
        aria-label={msg("reward_builder.title")}
        className="divide-y divide-border/40 border-t border-border/50"
      >
        {build.rewards.map((entry, index) => (
          <RewardRow
            key={`${entry.name}-${index}`}
            entry={entry}
            readOnly={readOnly}
            onEdit={() =>
              setEditing({
                index,
                entry,
                mode: entry.source === "bundled" ? "customize" : "edit",
              })
            }
            onRemove={() =>
              change({ ...build, rewards: build.rewards.filter((_, i) => i !== index) })
            }
            onWeight={(weight) =>
              change({
                ...build,
                rewards: build.rewards.map((r, i) => (i === index ? { ...r, weight } : r)),
              })
            }
          />
        ))}
      </ul>
      <ul
        aria-label={msg("reward_builder.parts")}
        className="divide-y divide-border/40 border-y border-border/50"
      >
        <PartRow part="speed" build={build} readOnly={readOnly} onChange={change} />
        <PartRow part="cost" build={build} readOnly={readOnly} onChange={change} />
      </ul>
      {!readOnly && issues.length > 0 && (
        <ul role="status" className="space-y-1 px-4 pt-3 text-xs text-[var(--warning)] sm:px-5">
          {issues.map((issue, i) => (
            <li key={i}>{issueText(issue)}</li>
          ))}
        </ul>
      )}

      {(!readOnly || tryIt) && (
        <div className="space-y-4 p-4 sm:p-5">
          {!readOnly && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" className="w-full" disabled={full}>
                  <Plus />
                  {msg("reward_builder.add")}
                  <CaretDown className="ms-auto opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="w-[var(--radix-dropdown-menu-trigger-width)]"
              >
                {addable.map((entry) => {
                  const Icon = TYPE_ICON[entry.rule.type];
                  return (
                    <DropdownMenuItem
                      key={entry.name}
                      onSelect={() => add([entry])}
                      className="items-start"
                    >
                      <Icon className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
                      <span className="flex min-w-0 flex-col">
                        <bdi dir="ltr" className="font-mono text-xs">
                          {entry.name}
                        </bdi>
                        <span className="text-[0.6875rem] text-muted-foreground">
                          {bundledText(entry.name)}
                        </span>
                      </span>
                    </DropdownMenuItem>
                  );
                })}
                {addable.length > 0 && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  onSelect={() => {
                    const entry = customReward("exact_match", expectedField);
                    setEditing({
                      index: null,
                      entry: { ...entry, name: uniqueName(entry.name, names) },
                      mode: "new",
                    });
                  }}
                  className="items-start"
                >
                  <PencilSimple className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
                  <span className="flex min-w-0 flex-col">
                    <span className="text-xs font-medium">{msg("reward_builder.add.custom")}</span>
                    <span className="text-[0.6875rem] text-muted-foreground">
                      {msg("reward_builder.add.custom_desc")}
                    </span>
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {tryIt && <RewardTryIt build={build} expectedField={expectedField} samples={samples} />}
        </div>
      )}

      {!readOnly && (
        <>
          <RewardRuleEditor
            entry={editing?.entry ?? null}
            mode={editing?.mode}
            taken={names.filter((_, i) => i !== editing?.index)}
            expectedField={expectedField}
            onClose={() => setEditing(null)}
            onSave={(entry) => {
              const at = editing?.index ?? null;
              change({
                ...build,
                rewards:
                  at === null
                    ? [...build.rewards, entry]
                    : build.rewards.map((r, i) => (i === at ? entry : r)),
              });
              setEditing(null);
            }}
          />
          <ImportDialog
            open={importing}
            onClose={() => setImporting(false)}
            onImport={add}
            expectedField={expectedField}
          />
        </>
      )}
    </section>
  );
}
