"use client";

import * as React from "react";
import { msg, type MessageKey } from "@/shared/lib/messages";
import { rewardFormatters, rewardPartLabel } from "@/shared/lib/reward-format";
import { rewardFromMarkdown, rewardToMarkdown } from "@/shared/lib/reward-md";
import {
  RULE_TYPES,
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
  Check,
  Coins,
  DotsThree,
  Hash,
  Play,
  Plus,
  Ruler,
  TextT,
  Timer,
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/primitives/dropdown-menu";
import { Input } from "@/shared/ui/primitives/input";
import { Label } from "@/shared/ui/primitives/label";
import { Textarea } from "@/shared/ui/primitives/textarea";
import { RewardRuleEditor } from "./reward-rule-editor";
import { importErrorText, plain, ruleSummary, ruleTypeLabel } from "./reward-text";
import { RewardTryIt, type RewardSample } from "./reward-try-it";

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
      className={cn("h-7 w-14 px-1.5 text-center font-mono text-xs", className)}
    />
  );
}

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
  const Icon = TYPE_ICON[entry.rule.type];
  const { copy } = useCopyToClipboard();
  const markdown = () => rewardToMarkdown(entry);
  return (
    <li data-reward={entry.name} className="flex items-start gap-2 px-3 py-2">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          {readOnly ? (
            <bdi dir="ltr" className="truncate font-mono text-xs font-medium">
              {entry.name}
            </bdi>
          ) : (
            <button
              type="button"
              onClick={onEdit}
              className="truncate font-mono text-xs font-medium hover:underline"
            >
              <bdi dir="ltr">{entry.name}</bdi>
            </button>
          )}
          <span
            className={cn(
              "shrink-0 rounded-full px-1.5 text-[0.625rem] font-medium",
              entry.source === "bundled"
                ? "bg-muted text-muted-foreground"
                : "bg-primary-fill/15 text-foreground",
            )}
          >
            {msg(entry.source === "bundled" ? "reward_builder.bundled" : "reward_builder.yours")}
          </span>
        </div>
        <p className="text-[0.6875rem] text-muted-foreground">{ruleSummary(entry.rule)}</p>
      </div>
      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        <span aria-hidden>×</span>
        {readOnly ? (
          <span className="font-mono tabular-nums text-foreground">{plain(entry.weight)}</span>
        ) : (
          <InlineNumber
            value={entry.weight}
            onChange={onWeight}
            label={msg("reward_builder.weight_of", { name: entry.name })}
          />
        )}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={msg("reward_builder.row_menu", { name: entry.name })}
          >
            <DotsThree className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {!readOnly && (
            <DropdownMenuItem onSelect={onEdit}>{msg("reward_builder.edit")}</DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => void copy(markdown())}>
            {msg("reward_builder.export.copy")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => download(`${entry.name}.md`, markdown())}>
            {msg("reward_builder.export.download")}
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
  const Icon = part === "speed" ? Timer : Coins;
  const value = build[part];
  const label = rewardPartLabel(part);
  const set = (next: Partial<typeof value>) =>
    onChange({ ...build, [part]: { ...value, ...next } });
  return (
    <li data-part={part} className="flex items-start gap-2 px-3 py-2">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-xs font-medium">{label}</p>
        <div className="flex flex-wrap items-center gap-1 text-[0.6875rem] text-muted-foreground">
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
              className="w-20"
            />
          )}
        </div>
      </div>
      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        <span aria-hidden>×</span>
        {readOnly ? (
          <span className="font-mono tabular-nums text-foreground">{plain(value.weight)}</span>
        ) : (
          <InlineNumber
            value={value.weight}
            onChange={(weight) => set({ weight })}
            label={msg("reward_builder.weight_of", { name: label })}
          />
        )}
      </span>
      {!readOnly && <span className="size-7 shrink-0" aria-hidden />}
    </li>
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
  onImport: (entries: RewardEntry[]) => void;
  expectedField: string;
}) {
  const id = React.useId();
  const [text, setText] = React.useState("");
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
    if (entries.length > 0) onImport(entries);
    if (failed.length === 0) {
      setText("");
      onClose();
    }
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
 * The reward builder (SKY-84), after Unsloth Studio's Rewards card: one row
 * per reward with its summary and weight, a Speed and a Cost row for the
 * SKY-69 reward, bundled and custom rewards to add, REWARD.md import and
 * export, and "Try it". Read-only, it lists the same rows for a finished run.
 *
 * Args:
 *   build: The rewards.
 *   onChange: Keep a changed build; omit for a read-only view.
 *   expectedField: The run's expected column.
 *   samples: Cases for "Try it".
 *   tryIt: Whether the header opens "Try it" in a dialog.
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
  const [editing, setEditing] = React.useState<{ index: number; entry: RewardEntry } | null>(null);
  const [importing, setImporting] = React.useState(false);
  const [trying, setTrying] = React.useState(false);
  const change = onChange ?? (() => undefined);
  const names = build.rewards.map((r) => r.name);
  const issues = buildIssues(build);

  const add = (entries: RewardEntry[]) => {
    const taken = [...names];
    const added = entries.map((entry) => {
      const name = uniqueName(entry.name, taken);
      taken.push(name);
      return { ...entry, name };
    });
    change({ ...build, rewards: [...build.rewards, ...added] });
    return added;
  };
  const addCustom = (type: RuleType) => {
    const [entry] = add([customReward(type, expectedField)]);
    if (entry) setEditing({ index: build.rewards.length, entry });
  };

  return (
    <section
      aria-labelledby="reward-builder-title"
      className={cn("flex min-h-0 flex-col", className)}
    >
      <header className="flex items-center gap-1 border-b border-border/60 px-3 py-2">
        <h3 id="reward-builder-title" className="flex-1 text-sm font-semibold">
          {msg("reward_builder.title")}
        </h3>
        {tryIt && (
          <Button type="button" variant="ghost" size="xs" onClick={() => setTrying(true)}>
            <Play />
            {msg("reward_builder.try.open")}
          </Button>
        )}
        {!readOnly && (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={msg("reward_builder.import.title")}
              onClick={() => setImporting(true)}
            >
              <UploadSimple />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" size="xs">
                  <Plus />
                  {msg("reward_builder.add")}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel>{msg("reward_builder.add.bundled")}</DropdownMenuLabel>
                {bundledRewards(expectedField).map((entry) => (
                  <DropdownMenuItem key={entry.name} onSelect={() => add([entry])}>
                    <span className="flex min-w-0 flex-col">
                      <bdi dir="ltr" className="font-mono text-xs">
                        {entry.name}
                      </bdi>
                      <span className="text-[0.6875rem] text-muted-foreground">
                        {msg(
                          `reward_builder.bundled.${entry.name.replace(/-/g, "_")}` as MessageKey,
                        )}
                      </span>
                    </span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{msg("reward_builder.add.custom")}</DropdownMenuLabel>
                {RULE_TYPES.map((type) => {
                  const Icon = TYPE_ICON[type];
                  return (
                    <DropdownMenuItem key={type} onSelect={() => addCustom(type)}>
                      <Icon className="size-3.5" aria-hidden />
                      {ruleTypeLabel(type)}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {build.rewards.length === 0 ? (
          <div className="space-y-2 px-3 py-4 text-xs text-muted-foreground">
            <p>{msg("reward_builder.empty")}</p>
            {!readOnly && (
              <Button
                type="button"
                size="xs"
                onClick={() => add(bundledRewards(expectedField).slice(0, 1))}
              >
                {msg("reward_builder.empty.start")}
              </Button>
            )}
          </div>
        ) : (
          <ul aria-label={msg("reward_builder.title")} className="divide-y divide-border/40">
            {build.rewards.map((entry, index) => (
              <RewardRow
                key={`${entry.name}-${index}`}
                entry={entry}
                readOnly={readOnly}
                onEdit={() => setEditing({ index, entry })}
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
        )}
        <ul
          aria-label={msg("reward_builder.parts")}
          className="divide-y divide-border/40 border-t border-border/60"
        >
          <PartRow part="speed" build={build} readOnly={readOnly} onChange={change} />
          <PartRow part="cost" build={build} readOnly={readOnly} onChange={change} />
        </ul>
        {!readOnly && issues.length > 0 && (
          <ul
            role="status"
            className="space-y-1 border-t border-border/60 px-3 py-2 text-xs text-[var(--warning)]"
          >
            {issues.map((issue, i) => (
              <li key={i}>{issueText(issue)}</li>
            ))}
          </ul>
        )}
      </div>

      {!readOnly && (
        <>
          <RewardRuleEditor
            entry={editing?.entry ?? null}
            taken={names.filter((_, i) => i !== editing?.index)}
            expectedField={expectedField}
            onClose={() => setEditing(null)}
            onSave={(entry) => {
              const at = editing?.index ?? -1;
              change({ ...build, rewards: build.rewards.map((r, i) => (i === at ? entry : r)) });
              setEditing(null);
            }}
          />
          <ImportDialog
            open={importing}
            onClose={() => setImporting(false)}
            onImport={(entries) => void add(entries)}
            expectedField={expectedField}
          />
        </>
      )}
      {tryIt && (
        <Dialog open={trying} onOpenChange={setTrying}>
          <DialogContent className="sm:max-w-[min(36rem,92vw)]">
            <DialogHeader className="sr-only">
              <DialogTitle>{msg("reward_builder.try.title")}</DialogTitle>
              <DialogDescription>{msg("reward_builder.try.how")}</DialogDescription>
            </DialogHeader>
            <RewardTryIt build={build} expectedField={expectedField} samples={samples} />
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}
