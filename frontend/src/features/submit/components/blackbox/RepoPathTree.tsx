"use client";

import { useEffect, useMemo, useState } from "react";

import {
  CaretDown,
  CaretRight,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
} from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { Skeleton } from "@/shared/ui/skeleton";
import { InlineErrorRow } from "@/shared/ui/inline-error-row";
import { SelectCheckbox } from "@/shared/ui/select-checkbox";
import { getGithubTree } from "@/shared/lib/api";
import { msg } from "@/shared/lib/messages";
import { cn } from "@/shared/lib/utils";

import { parseEditablePaths } from "../../hooks/use-blackbox-wizard";
import {
  buildRepoTree,
  checkState,
  foldersToReveal,
  togglePath,
  WHOLE_REPOSITORY,
  type RepoTreeNode,
} from "../../lib/repo-tree";

/**
 * The editable paths of a repository run, chosen from the repository's own
 * file tree: checking a folder hands the agent the whole folder. The
 * selection is kept in the wizard's newline-separated ``repoPaths`` form.
 */
export function RepoPathTree({
  repo,
  branch,
  paths,
  onPathsChange,
}: {
  repo: string;
  branch: string;
  paths: string;
  onPathsChange: (paths: string) => void;
}) {
  const [roots, setRoots] = useState<RepoTreeNode[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const selected = useMemo(() => parseEditablePaths(paths), [paths]);

  useEffect(() => {
    let cancelled = false;
    setRoots(null);
    setFailed(false);
    getGithubTree(repo, branch)
      .then((res) => {
        if (cancelled) return;
        setRoots(buildRepoTree(res.entries));
        setTruncated(res.truncated);
        // A restored selection opens onto itself rather than hiding in folds.
        setOpen(new Set(foldersToReveal(parseEditablePaths(paths))));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // Only a new repository or branch refetches; the selection is read once to reveal it.
  }, [repo, branch, attempt]);

  const write = (next: string[]) => onPathsChange(next.join("\n"));
  const whole = selected.includes(WHOLE_REPOSITORY);

  const toggleOpen = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const renderNodes = (nodes: readonly RepoTreeNode[], depth: number) => (
    <ul className="flex flex-col">
      {nodes.map((node) => {
        const state = checkState(node, selected);
        const isDir = node.type === "dir";
        const expanded = isDir && open.has(node.path);
        const Icon = isDir ? (expanded ? FolderOpen : Folder) : FileText;
        return (
          <li key={node.path}>
            <div
              className="flex min-h-11 items-center gap-2 rounded-lg pe-2 hover:bg-muted/40 lg:min-h-9"
              style={{ paddingInlineStart: `${0.5 + depth * 1.25}rem` }}
            >
              {isDir ? (
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-label={node.name}
                  onClick={() => toggleOpen(node.path)}
                  className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8A882]/45"
                >
                  {expanded ? (
                    <CaretDown className="size-3.5" aria-hidden="true" />
                  ) : (
                    <CaretRight className="size-3.5 rtl:-scale-x-100" aria-hidden="true" />
                  )}
                </button>
              ) : (
                <span aria-hidden="true" className="size-8 shrink-0" />
              )}
              <SelectCheckbox
                checked={state === "checked"}
                indeterminate={state === "mixed"}
                onToggle={() => write(togglePath(selected, node, roots ?? []))}
                ariaLabel={node.path}
              />
              <Icon
                className={cn(
                  "size-4 shrink-0",
                  isDir ? "text-[#C8A882]" : "text-muted-foreground",
                )}
                aria-hidden="true"
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate font-mono text-[0.8125rem]",
                  state === "checked" ? "text-foreground" : "text-foreground/75",
                )}
                dir="ltr"
                title={node.path}
              >
                {node.name}
              </span>
            </div>
            {expanded && node.children.length > 0 && renderNodes(node.children, depth + 1)}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="flex flex-col gap-3">
      {selected.length === 0 && (
        <p className="text-xs text-muted-foreground">{msg("submit.blackbox.repo.paths_none")}</p>
      )}

      {/* The wizard's validation focuses this when no path is chosen. */}
      <div
        id="bb-repo-paths"
        tabIndex={-1}
        className="overflow-hidden rounded-xl border border-border bg-background outline-none focus-visible:ring-2 focus-visible:ring-[#C8A882]/45"
      >
        <div className="flex min-h-12 items-center gap-2 border-b border-border bg-muted/30 px-3">
          <SelectCheckbox
            checked={whole}
            indeterminate={!whole && selected.length > 0}
            onToggle={() => write(whole ? [] : [WHOLE_REPOSITORY])}
            ariaLabel={msg("submit.blackbox.repo.whole")}
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {msg("submit.blackbox.repo.whole")}
          </span>
          <span
            className="inline-flex min-w-0 items-center gap-1 truncate font-mono text-[0.6875rem] text-muted-foreground"
            dir="ltr"
          >
            <GitBranch className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{repo}</span>
          </span>
        </div>
        <div className="max-h-80 overflow-y-auto overscroll-contain p-1">
          {failed ? (
            <InlineErrorRow
              className="m-2"
              message={msg("submit.blackbox.repo.tree_failed")}
              action={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setAttempt((n) => n + 1)}
                  className="min-h-11 shrink-0 lg:min-h-8"
                >
                  {msg("submit.blackbox.repo.retry")}
                </Button>
              }
            />
          ) : roots === null ? (
            <div className="flex flex-col gap-2 p-2" aria-busy="true">
              {[70, 55, 62, 40, 50].map((width, i) => (
                <Skeleton key={i} width={`${width}%`} height={14} />
              ))}
            </div>
          ) : roots.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {msg("submit.blackbox.repo.tree_empty")}
            </p>
          ) : (
            <div role="group" aria-label={msg("submit.blackbox.repo.paths_label")}>
              {renderNodes(roots, 0)}
            </div>
          )}
        </div>
      </div>
      {truncated && (
        <p className="text-xs text-muted-foreground">
          {msg("submit.blackbox.repo.tree_truncated")}
        </p>
      )}
    </div>
  );
}
