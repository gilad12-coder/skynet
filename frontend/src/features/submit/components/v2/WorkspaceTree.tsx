"use client";

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { FileTreeList } from "@/shared/ui/file-tree";
import { buildFileTree, treeFolders, type FileTreeNode } from "@/shared/ui/file-tree-model";
import { Plus, Trash } from "@/shared/ui/icons";
import { cn } from "@/shared/lib/utils";
import { FIXED_FILES, workspacePathIssue } from "../../lib/wizard-v2";
import { v2Msg } from "./ArtifactConfirmCard";

/**
 * The Metric step's file list: run.py, metric.py and the extra files run.py
 * imports. Clicking a file opens it in the editor beside the tree; extra files
 * can be added and deleted, the two fixed ones cannot.
 */
export function WorkspaceTree({
  paths,
  files,
  selected,
  onSelect,
  onAdd,
  onDelete,
  writing,
  problems,
  guided,
}: {
  /** Every file's path, fixed files included. */
  paths: readonly string[];
  /** The extra files, for checking a new name against them. */
  files: Readonly<Record<string, string>>;
  selected: string;
  onSelect: (path: string) => void;
  onAdd: (path: string) => void;
  onDelete: (path: string) => void;
  /** Files the agent is writing right now. */
  writing: ReadonlySet<string>;
  /** How many errors each file's console shows. */
  problems: Readonly<Record<string, number>>;
  guided: boolean;
}) {
  const root = useMemo(() => buildFileTree(paths.map((path) => ({ path }))), [paths]);
  const open = useMemo(() => treeFolders(root), [root]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [issue, setIssue] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const closeAdd = () => {
    setAdding(false);
    setName("");
    setIssue(null);
  };
  const submitAdd = () => {
    const path = name.trim();
    const problem = workspacePathIssue(path, files);
    if (problem) {
      setIssue(problem);
      inputRef.current?.focus();
      return;
    }
    onAdd(path);
    closeAdd();
  };
  const onNameKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitAdd();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeAdd();
    }
  };

  const look = (node: FileTreeNode) => {
    if (node.type !== "file") return undefined;
    const count = problems[node.path] ?? 0;
    const deletable = !FIXED_FILES.includes(node.path);
    const isWriting = writing.has(node.path);
    return {
      nameClassName: cn(isWriting && "agent-shimmer-text"),
      trailing: (
        <span className="flex shrink-0 items-center gap-1">
          {isWriting && (
            <span
              className="size-1.5 rounded-full bg-primary-fill motion-safe:animate-pulse"
              role="img"
              aria-label={v2Msg("submit.v2.metric.files.writing", guided)}
            />
          )}
          {count > 0 && (
            <span
              className="rounded-full bg-destructive/10 px-1.5 font-mono text-[0.625rem] tabular-nums text-destructive"
              aria-label={v2Msg("submit.v2.metric.files.errors", guided, { count })}
            >
              {count}
            </span>
          )}
          {deletable && (
            <button
              type="button"
              className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover/row:opacity-100 any-pointer-coarse:opacity-100"
              aria-label={v2Msg("submit.v2.metric.files.delete", guided, { file: node.path })}
              title={v2Msg("submit.v2.metric.files.delete", guided, { file: node.path })}
              onClick={(event) => {
                event.stopPropagation();
                onDelete(node.path);
              }}
            >
              <Trash className="size-3" aria-hidden="true" />
            </button>
          )}
        </span>
      ),
    };
  };

  return (
    <div className="flex min-h-0 flex-col gap-1">
      <div className="flex items-center justify-between gap-2 px-1">
        <h4 className="text-xs font-medium text-muted-foreground">
          {v2Msg("submit.v2.metric.files.label", guided)}
        </h4>
        <button
          type="button"
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted/70 hover:text-foreground any-pointer-coarse:min-h-11"
          onClick={() => {
            setAdding(true);
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
        >
          <Plus className="size-3" aria-hidden="true" />
          {v2Msg("submit.v2.metric.files.add", guided)}
        </button>
      </div>
      <FileTreeList
        root={root}
        baseOpen={open}
        selected={selected}
        label={v2Msg("submit.v2.metric.files.label", guided)}
        look={look}
        onSelect={onSelect}
      />
      {adding && (
        <div className="space-y-1 px-1">
          <input
            ref={inputRef}
            dir="ltr"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setIssue(null);
            }}
            onKeyDown={onNameKey}
            onBlur={() => {
              if (!name.trim()) closeAdd();
            }}
            aria-label={v2Msg("submit.v2.metric.files.name_label", guided)}
            aria-invalid={issue !== null}
            aria-describedby={issue ? "v2-workspace-new-file-issue" : undefined}
            placeholder="helpers.py"
            spellCheck={false}
            autoComplete="off"
            className="h-7 w-full rounded-md border border-border bg-background px-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 any-pointer-coarse:h-11"
          />
          {issue && (
            <p id="v2-workspace-new-file-issue" className="text-xs text-destructive">
              {v2Msg(issue, guided)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
