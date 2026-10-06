"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  CaretRight,
  DotsThree,
  File,
  FileC,
  FileCode,
  FileCpp,
  FileCss,
  FileCsv,
  FileHtml,
  FileImage,
  FileJs,
  FileLock,
  FileMd,
  FilePy,
  FileRs,
  FileSql,
  FileSvg,
  FileTs,
  FileTsx,
  FileTxt,
  FileZip,
  Folder,
  FolderOpen,
  MagnifyingGlass,
} from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { Input } from "@/shared/ui/primitives/input";
import { Skeleton } from "@/shared/ui/skeleton";
import { TOUCH_FIELD_SM } from "@/shared/ui/touch";
import { RenderedText } from "@/shared/ui/rendered-text";
import { getRepositoryFile, getRepositoryTree } from "@/shared/lib/api";
import { formatMsg, msg } from "@/shared/lib/messages";
import { getActiveDir } from "@/shared/lib/runtime-locale";
import { cn } from "@/shared/lib/utils";
import { CODE_HIGHLIGHT_SPECS } from "@/shared/ui/code-highlight-style";
import type { RepositoryFileResponse, RepositoryTreeResponse } from "@/shared/types/api";
import type { CandidateVersion } from "../lib/blackbox-versions";
import { foldRows, fullDiffRows, numberRows, type DiffRow } from "../lib/blackbox-diff";
import { applyFilePatch, parsePatch, type ApplyResult, type FilePatch } from "../lib/repo-patch";
import {
  ancestors,
  buildRepoTree,
  changedFolders,
  hasFile,
  repoFileKind,
  visibleRows,
  type RepoNode,
  type RepoRow,
} from "../lib/repo-browser";
import type { HighlightToken } from "../lib/repo-highlight";
import {
  ADDED_BG,
  ADDED_EMPHASIS_BG,
  ADDED_FG,
  REMOVED_BG,
  REMOVED_EMPHASIS_BG,
  REMOVED_FG,
} from "./diff-colors";

// Unchanged lines kept on each side of a change when only the changes show.
const DIFF_CONTEXT_LINES = 3;

// Past this size a file shows as plain source: tokenising it would stall the tab.
const MAX_HIGHLIGHT_CHARS = 200_000;
const MAX_HIGHLIGHT_LINES = 5_000;

type Loaded<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error" };

/** Fetch keyed data; a null key means nothing to fetch. `load` must be stable. */
function useLoaded<T>(key: string | null, load: (key: string) => Promise<T>): Loaded<T> | null {
  const [state, setState] = useState<{ key: string; value: Loaded<T> } | null>(null);
  useEffect(() => {
    if (key == null) return;
    let cancelled = false;
    load(key)
      .then((data) => {
        if (!cancelled) setState({ key, value: { status: "ready", data } });
      })
      .catch(() => {
        if (!cancelled) setState({ key, value: { status: "error" } });
      });
    return () => {
      cancelled = true;
    };
  }, [key, load]);
  if (key == null) return null;
  return state?.key === key ? state.value : { status: "loading" };
}

function useHighlight(path: string, text: string | null): HighlightToken[][] | null {
  const tooLarge =
    text == null ||
    text.length > MAX_HIGHLIGHT_CHARS ||
    text.split("\n", MAX_HIGHLIGHT_LINES + 1).length > MAX_HIGHLIGHT_LINES;
  const [state, setState] = useState<{ path: string; text: string; lines: HighlightToken[][] | null } | null>(null);
  useEffect(() => {
    if (tooLarge || text == null) return;
    let cancelled = false;
    void import("../lib/repo-highlight")
      .then((m) => m.highlightLines(path, text))
      .then((lines) => {
        if (!cancelled) setState({ path, text, lines });
      })
      .catch(() => {
        if (!cancelled) setState({ path, text, lines: null });
      });
    return () => {
      cancelled = true;
    };
  }, [path, text, tooLarge]);
  return state && state.path === path && state.text === text ? state.lines : null;
}

const SPEC_STYLE: CSSProperties[] = CODE_HIGHLIGHT_SPECS.map((spec) => ({
  color: spec.color,
  fontWeight: spec.fontWeight,
  fontStyle: spec.fontStyle,
}));

const ICON_BY_EXTENSION: Record<string, typeof File> = {
  c: FileC,
  h: FileC,
  cc: FileCpp,
  cpp: FileCpp,
  hpp: FileCpp,
  css: FileCss,
  scss: FileCss,
  csv: FileCsv,
  tsv: FileCsv,
  html: FileHtml,
  htm: FileHtml,
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  webp: FileImage,
  js: FileJs,
  mjs: FileJs,
  cjs: FileJs,
  jsx: FileJs,
  lock: FileLock,
  md: FileMd,
  mdx: FileMd,
  py: FilePy,
  pyi: FilePy,
  rs: FileRs,
  sql: FileSql,
  svg: FileSvg,
  ts: FileTs,
  mts: FileTs,
  tsx: FileTsx,
  txt: FileTxt,
  zip: FileZip,
  gz: FileZip,
  tar: FileZip,
  json: FileCode,
  yaml: FileCode,
  yml: FileCode,
  toml: FileCode,
  go: FileCode,
  java: FileCode,
  rb: FileCode,
  sh: FileCode,
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function trimFinalNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function ChangeCounts({ added, removed }: { added: number; removed: number }) {
  return (
    <span
      className="shrink-0 font-mono text-[0.625rem] tabular-nums"
      aria-label={formatMsg("optimization.blackbox.repo.browser.counts_aria", { added, removed })}
      dir="ltr"
    >
      {added > 0 && <span style={{ color: ADDED_FG }}>+{added}</span>}
      {added > 0 && removed > 0 && " "}
      {removed > 0 && <span style={{ color: REMOVED_FG }}>−{removed}</span>}
    </span>
  );
}

/* ── Tree ─────────────────────────────────────────────────────────────── */

function FileTree({
  root,
  selected,
  onSelect,
  loading,
  failed,
  truncated,
}: {
  root: RepoNode;
  selected: string | null;
  onSelect: (path: string) => void;
  loading: boolean;
  failed: boolean;
  truncated: boolean;
}) {
  const [filter, setFilter] = useState("");
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [focused, setFocused] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const expanded = useMemo(() => {
    const open = changedFolders(root);
    if (selected) ancestors(selected).forEach((path) => open.add(path));
    for (const [path, isOpen] of overrides) {
      if (isOpen) open.add(path);
      else open.delete(path);
    }
    return open;
  }, [root, selected, overrides]);
  const rows = useMemo(() => visibleRows(root, expanded, filter), [root, expanded, filter]);
  const focusIndex = Math.max(
    0,
    rows.findIndex((row) => row.node.path === (focused ?? selected)),
  );

  const toggle = (path: string, open?: boolean) =>
    setOverrides((prev) => new Map(prev).set(path, open ?? !expanded.has(path)));

  const focusRow = (row: RepoRow | undefined) => {
    if (!row) return;
    setFocused(row.node.path);
    rowRefs.current.get(row.node.path)?.focus();
  };

  const activate = (row: RepoRow) => {
    if (row.node.type === "dir") toggle(row.node.path);
    else onSelect(row.node.path);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const row = rows[focusIndex];
    if (!row) return;
    const rtl = getActiveDir() === "rtl";
    const inward = rtl ? "ArrowLeft" : "ArrowRight";
    const outward = rtl ? "ArrowRight" : "ArrowLeft";
    let handled = true;
    if (event.key === "ArrowDown") focusRow(rows[focusIndex + 1]);
    else if (event.key === "ArrowUp") focusRow(rows[focusIndex - 1]);
    else if (event.key === "Home") focusRow(rows[0]);
    else if (event.key === "End") focusRow(rows[rows.length - 1]);
    else if (event.key === "Enter" || event.key === " ") activate(row);
    else if (event.key === inward) {
      if (row.node.type === "dir" && !row.expanded) toggle(row.node.path, true);
      else if (row.node.type === "dir") focusRow(rows[focusIndex + 1]);
    } else if (event.key === outward) {
      if (row.node.type === "dir" && row.expanded && !filter) toggle(row.node.path, false);
      else {
        const parentPath = ancestors(row.node.path).pop();
        focusRow(rows.find((r) => r.node.path === parentPath));
      }
    } else handled = false;
    if (handled) {
      // Keeps the arrows from also stepping the version behind the tree.
      event.preventDefault();
      event.stopPropagation();
    }
  };

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="relative">
        <MagnifyingGlass
          className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && filter) {
              event.stopPropagation();
              setFilter("");
            }
          }}
          placeholder={msg("optimization.blackbox.repo.browser.filter")}
          aria-label={msg("optimization.blackbox.repo.browser.filter_aria")}
          className={cn(TOUCH_FIELD_SM, "ps-8 text-xs md:text-xs")}
        />
      </div>
      {loading ? (
        <div className="space-y-1.5 px-1" aria-hidden="true">
          {Array.from({ length: 7 }, (_, i) => (
            <Skeleton key={i} height={14} borderRadius={4} />
          ))}
        </div>
      ) : (
        <>
          {failed && (
            <p className="px-1 text-xs text-muted-foreground">
              {msg("optimization.blackbox.repo.browser.tree_error")}
            </p>
          )}
          {rows.length === 0 && filter && (
            <p className="px-1 text-xs text-muted-foreground">
              {msg("optimization.blackbox.repo.browser.no_match")}
            </p>
          )}
          <div
            role="tree"
            aria-label={msg("optimization.blackbox.repo.browser.tree_aria")}
            onKeyDown={onKeyDown}
            className="max-h-[22rem] min-h-0 overflow-auto rounded-md md:max-h-[32rem]"
          >
            {rows.map((row, i) => (
              <TreeRow
                key={row.node.path}
                row={row}
                selected={row.node.path === selected}
                tabbable={i === focusIndex}
                rowRef={(el) => {
                  if (el) rowRefs.current.set(row.node.path, el);
                  else rowRefs.current.delete(row.node.path);
                }}
                onActivate={() => {
                  setFocused(row.node.path);
                  activate(row);
                }}
              />
            ))}
          </div>
          {truncated && (
            <p className="px-1 text-[0.6875rem] text-muted-foreground">
              {msg("optimization.blackbox.repo.browser.truncated")}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function TreeRow({
  row,
  selected,
  tabbable,
  rowRef,
  onActivate,
}: {
  row: RepoRow;
  selected: boolean;
  tabbable: boolean;
  rowRef: (el: HTMLDivElement | null) => void;
  onActivate: () => void;
}) {
  const { node, depth, expanded } = row;
  const isDir = node.type === "dir";
  const Icon = isDir ? (expanded ? FolderOpen : Folder) : (ICON_BY_EXTENSION[extensionOf(node.name)] ?? File);
  const change = node.change;
  const changed = node.changedCount > 0;
  return (
    <div
      ref={rowRef}
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={isDir ? expanded : undefined}
      aria-selected={isDir ? undefined : selected}
      tabIndex={tabbable ? 0 : -1}
      onClick={onActivate}
      className={cn(
        "flex min-h-8 cursor-pointer select-none items-center gap-1.5 rounded-md pe-2 text-xs transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8A882]/45 lg:min-h-7",
        selected ? "bg-accent/70 text-foreground" : "text-foreground/80 hover:bg-muted/70",
      )}
      style={{ paddingInlineStart: `${depth * 0.75 + 0.25}rem` }}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center" aria-hidden="true">
        {isDir && (
          <CaretRight
            className={cn(
              "size-3 text-muted-foreground transition-transform duration-150 rtl:-scale-x-100",
              expanded && "rotate-90 rtl:-rotate-90",
            )}
          />
        )}
      </span>
      <Icon
        className={cn("size-3.5 shrink-0", isDir ? "text-primary/80" : "text-muted-foreground")}
        aria-hidden="true"
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate font-mono",
          node.removed && "line-through decoration-1",
          changed && !isDir && "font-medium text-foreground",
        )}
        style={node.removed ? { color: REMOVED_FG } : undefined}
        dir="ltr"
        title={node.path}
      >
        {node.name}
      </span>
      {isDir && changed && (
        <span
          className="size-1.5 shrink-0 rounded-full bg-primary/60"
          role="img"
          aria-label={msg("optimization.blackbox.repo.browser.changed_folder")}
        />
      )}
      {!isDir && change && (
        <ChangeCounts
          added={node.removed && change.status === "renamed" ? 0 : change.added}
          removed={change.removed}
        />
      )}
    </div>
  );
}

/* ── File view ────────────────────────────────────────────────────────── */

type Compare = "base" | "parent";
type Mode = "source" | "rendered";
export type DiffView = "full" | "changes";

/** A small two-way switch: a radio group of pressed-style buttons. */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex items-center gap-0.5 rounded-md bg-muted p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "min-h-8 cursor-pointer rounded px-2 text-[0.6875rem] font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8A882]/45 lg:min-h-6",
            o.value === value
              ? "bg-background text-foreground shadow-[0_1px_2px_oklch(0.25_0.04_45/.12)]"
              : "text-foreground/60 hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Breadcrumb({ repository, path }: { repository: string | null; path: string }) {
  const parts = [...(repository ? [repository] : []), ...path.split("/")];
  return (
    <nav aria-label={msg("optimization.blackbox.repo.browser.breadcrumb_aria")} className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1 font-mono text-xs text-muted-foreground" dir="ltr">
        {parts.map((part, i) => (
          <li key={i} className={cn("flex min-w-0 items-center gap-1", i === parts.length - 1 ? "shrink" : "shrink-[2]")}>
            {i > 0 && (
              <CaretRight className="size-2.5 shrink-0 opacity-60" aria-hidden="true" />
            )}
            <span
              className={cn("truncate", i === parts.length - 1 && "font-semibold text-foreground")}
              aria-current={i === parts.length - 1 ? "page" : undefined}
            >
              {part}
            </span>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function Notice({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border/60 px-6 py-8 text-center">
      <p className="max-w-md text-sm text-muted-foreground">{children}</p>
      {action}
    </div>
  );
}

function RawPatch({ text }: { text: string }) {
  return (
    <pre
      className="max-h-[32rem] overflow-auto whitespace-pre rounded-lg border border-border/50 bg-muted/30 p-3 font-mono text-[0.8125rem] leading-relaxed"
      dir="ltr"
    >
      {text}
    </pre>
  );
}

function SegmentsLine({ row }: { row: DiffRow }) {
  return (
    <>
      {row.segments.map((seg, j) =>
        seg.changed ? (
          <mark
            key={j}
            className="rounded-sm text-inherit"
            style={{ background: row.kind === "added" ? ADDED_EMPHASIS_BG : REMOVED_EMPHASIS_BG }}
          >
            {seg.text}
          </mark>
        ) : (
          <span key={j}>{seg.text}</span>
        ),
      )}
    </>
  );
}

function TokensLine({ tokens }: { tokens: HighlightToken[] }) {
  return (
    <>
      {tokens.map((token, j) => (
        <span key={j} style={token.spec == null ? undefined : SPEC_STYLE[token.spec]}>
          {token.text}
        </span>
      ))}
    </>
  );
}

/**
 * The file as this version leaves it, its changes inline: added lines tinted,
 * removed lines in place. The full view keeps every unchanged line; the
 * changes view folds long unchanged runs, each opening on click.
 */
function SourceDiff({
  path,
  before,
  after,
  changesOnly,
}: {
  path: string;
  before: string;
  after: string;
  changesOnly: boolean;
}) {
  const shownBefore = trimFinalNewline(before);
  const shownAfter = trimFinalNewline(after);
  const rows = useMemo(
    () => numberRows(fullDiffRows(shownBefore, shownAfter)),
    [shownBefore, shownAfter],
  );
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const shown = useMemo(
    () => (changesOnly ? foldRows(rows, DIFF_CONTEXT_LINES, expanded) : rows),
    [changesOnly, rows, expanded],
  );
  const highlighted = useHighlight(path, shownAfter);
  return (
    <div
      className="max-h-[32rem] overflow-auto rounded-lg border border-border/50 bg-muted/30 py-2 font-mono text-[0.8125rem] leading-relaxed"
      dir="ltr"
    >
      {shown.map((row) => {
        if ("gap" in row) {
          return (
            <button
              key={`gap-${row.start}`}
              type="button"
              onClick={() => setExpanded((prev) => new Set(prev).add(row.start))}
              className="my-0.5 flex min-h-8 w-full cursor-pointer items-center gap-2 bg-muted/60 ps-4 pe-3 text-start font-sans text-[0.6875rem] text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#C8A882]/45 lg:min-h-6"
            >
              <DotsThree className="size-3.5 shrink-0" aria-hidden="true" />
              <span dir="auto">
                {formatMsg("optimization.blackbox.repo.browser.folded_lines", { count: row.hidden })}
              </span>
            </button>
          );
        }
        const style =
          row.kind === "added"
            ? { background: ADDED_BG, color: ADDED_FG }
            : row.kind === "removed"
              ? { background: REMOVED_BG, color: REMOVED_FG }
              : undefined;
        const marker = row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " ";
        const tokens = row.kind === "same" && row.newLine != null ? highlighted?.[row.newLine - 1] : undefined;
        return (
          <div key={`${row.oldLine}-${row.newLine}`} className="flex min-h-[1.5em] pe-3" style={style}>
            <span
              className="w-10 shrink-0 select-none pe-2 text-end tabular-nums opacity-50"
              aria-hidden="true"
            >
              {row.oldLine ?? ""}
            </span>
            <span
              className="w-10 shrink-0 select-none pe-2 text-end tabular-nums opacity-50"
              aria-hidden="true"
            >
              {row.newLine ?? ""}
            </span>
            <span className="w-4 shrink-0 select-none opacity-70" aria-hidden="true">
              {marker}
            </span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
              {tokens ? <TokensLine tokens={tokens} /> : <SegmentsLine row={row} />}
              {row.segments.every((s) => s.text === "") && !tokens?.length && " "}
            </span>
          </div>
        );
      })}
    </div>
  );
}

interface FileSides {
  /** The file at the pinned commit; null for a file the version adds. */
  basePath: string | null;
  /** This version's patch entry for the file, if it changes it. */
  change: FilePatch | null;
  /** The version deletes the file or renames it away. */
  removed: boolean;
}

function sidesOf(path: string, files: FilePatch[]): FileSides {
  const own = files.find((f) => f.path === path);
  if (own) {
    return {
      basePath: own.status === "added" ? null : own.oldPath,
      change: own,
      removed: own.status === "deleted",
    };
  }
  const renamedAway = files.find((f) => f.status === "renamed" && f.oldPath === path);
  if (renamedAway) return { basePath: path, change: renamedAway, removed: true };
  return { basePath: path, change: null, removed: false };
}

type FileText =
  | { state: "loading" }
  | { state: "ready"; text: string }
  | { state: "binary" }
  | { state: "too_large" }
  | { state: "failed" }
  | { state: "conflict" };

/** The file's text after `sides`' change, given its text at the pinned commit. */
function resolveText(sides: FileSides, base: Loaded<RepositoryFileResponse> | null): FileText {
  if (sides.change?.binary) return { state: "binary" };
  let baseText = "";
  if (sides.basePath != null) {
    if (!base || base.status === "loading") return { state: "loading" };
    if (base.status === "error") return { state: "failed" };
    const file = base.data;
    if (file.binary) return { state: "binary" };
    if (file.too_large) return { state: "too_large" };
    baseText = file.content ?? "";
  }
  if (sides.removed) return { state: "ready", text: "" };
  if (!sides.change) return { state: "ready", text: baseText };
  const applied: ApplyResult = applyFilePatch(baseText, sides.change);
  return applied.ok ? { state: "ready", text: applied.text } : { state: "conflict" };
}

/** The pinned commit's text of the file `sides` start from. */
function baseTextOf(sides: FileSides, base: Loaded<RepositoryFileResponse> | null): FileText {
  if (sides.basePath == null) return { state: "ready", text: "" };
  if (!base || base.status === "loading") return { state: "loading" };
  if (base.status === "error") return { state: "failed" };
  if (base.data.binary) return { state: "binary" };
  if (base.data.too_large) return { state: "too_large" };
  return { state: "ready", text: base.data.content ?? "" };
}

function FileView({
  optimizationId,
  repository,
  path,
  files,
  parent,
  parentFiles,
  diffView,
  onDiffView,
  onText,
}: {
  optimizationId: string;
  repository: string | null;
  path: string;
  files: FilePatch[];
  parent: CandidateVersion | null;
  parentFiles: FilePatch[];
  diffView: DiffView;
  onDiffView: (view: DiffView) => void;
  onText: (text: string | null) => void;
}) {
  const kind = repoFileKind(path);
  const renderable = kind === "markdown" || kind === "html";
  const [compare, setCompare] = useState<Compare>("base");
  const [mode, setMode] = useState<Mode>("source");
  const [showPatch, setShowPatch] = useState(false);
  const loadFile = useCallback((p: string) => getRepositoryFile(optimizationId, p), [optimizationId]);

  const sides = sidesOf(path, files);
  const base = useLoaded(sides.basePath, loadFile);
  const after = resolveText(sides, base);
  const before = baseTextOf(sides, base);

  const useParent = compare === "parent" && parent != null;
  const parentSides = sidesOf(path, parentFiles);
  // Without a parent entry the parent leaves the file as the commit has it,
  // which is this version's own base (or nothing, for a file it adds).
  const parentOwnBase = parentSides.change ? parentSides : { ...sides, change: null, removed: false };
  const parentBase = useLoaded(useParent ? parentOwnBase.basePath : null, loadFile);
  const parentText = useParent ? resolveText(parentOwnBase, parentBase) : before;

  const afterText = after.state === "ready" ? after.text : null;
  useEffect(() => {
    onText(afterText);
  }, [afterText, onText]);

  const change = sides.change;
  const statusNote = sides.removed
    ? msg("optimization.blackbox.repo.browser.deleted")
    : change?.status === "added"
      ? msg("optimization.blackbox.repo.browser.added")
      : change?.status === "renamed" && change.oldPath
        ? formatMsg("optimization.blackbox.repo.browser.renamed", { from: change.oldPath })
        : !change
          ? msg("optimization.blackbox.repo.browser.unchanged_file")
          : null;

  const patchAction = change ? (
    <Button type="button" variant="outline" size="sm" onClick={() => setShowPatch((v) => !v)}>
      {msg(
        showPatch
          ? "optimization.blackbox.repo.browser.hide_patch"
          : "optimization.blackbox.repo.browser.show_patch",
      )}
    </Button>
  ) : undefined;

  const showingSource = !(renderable && mode === "rendered");
  // A file the version adds or deletes is one change top to bottom, so there
  // is nothing to fold away.
  const foldable = !sides.removed && (useParent || (change != null && change.status !== "added"));

  const blocked = [after, parentText].find((t) => t.state !== "ready" && t.state !== "loading");
  const loading = after.state === "loading" || parentText.state === "loading";
  let body: ReactNode;
  if (blocked?.state === "binary") {
    body = <Notice>{msg("optimization.blackbox.repo.browser.binary")}</Notice>;
  } else if (blocked) {
    const key =
      blocked.state === "too_large"
        ? "optimization.blackbox.repo.browser.too_large"
        : blocked.state === "conflict"
          ? "optimization.blackbox.repo.browser.apply_failed"
          : "optimization.blackbox.repo.browser.fetch_failed";
    body = <Notice action={patchAction}>{msg(key)}</Notice>;
  } else if (loading) {
    body = <Skeleton height={240} borderRadius={8} />;
  } else if (after.state === "ready" && parentText.state === "ready") {
    body =
      renderable && mode === "rendered" && !sides.removed ? (
        <RenderedText text={after.text} kind={kind} title={path} />
      ) : (
        <SourceDiff
          path={path}
          before={parentText.text}
          after={after.text}
          changesOnly={foldable && diffView === "changes"}
        />
      );
  }

  return (
    <div className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Breadcrumb repository={repository} path={path} />
        {change && !sides.removed && <ChangeCounts added={change.added} removed={change.removed} />}
        <div className="ms-auto flex flex-wrap items-center gap-1.5">
          {parent && (
            <Segmented<Compare>
              label={msg("optimization.blackbox.repo.browser.compare_label")}
              value={compare}
              onChange={setCompare}
              options={[
                { value: "base", label: msg("optimization.blackbox.repo.browser.compare_base") },
                {
                  value: "parent",
                  label: formatMsg("optimization.blackbox.repo.browser.compare_parent", {
                    n: parent.number,
                  }),
                },
              ]}
            />
          )}
          {foldable && showingSource && (
            <Segmented<DiffView>
              label={msg("optimization.blackbox.repo.browser.diff_view_label")}
              value={diffView}
              onChange={onDiffView}
              options={[
                { value: "full", label: msg("optimization.blackbox.repo.browser.diff_view_full") },
                {
                  value: "changes",
                  label: msg("optimization.blackbox.repo.browser.diff_view_changes"),
                },
              ]}
            />
          )}
          {renderable && !sides.removed && (
            <Segmented<Mode>
              label={msg("optimization.blackbox.repo.browser.mode_label")}
              value={mode}
              onChange={setMode}
              options={[
                { value: "source", label: msg("optimization.blackbox.repo.browser.mode_source") },
                { value: "rendered", label: msg("optimization.blackbox.repo.browser.mode_rendered") },
              ]}
            />
          )}
        </div>
      </div>
      {statusNote && <p className="text-[0.6875rem] text-muted-foreground">{statusNote}</p>}
      {body}
      {showPatch && change && <RawPatch text={change.raw} />}
    </div>
  );
}

const DIFF_VIEW_STORAGE_KEY = "skynet:repo-browser:diff-view";

/** The reader's full-file or changes-only choice, remembered across files, versions and visits. */
function useDiffView(): readonly [DiffView, (view: DiffView) => void] {
  const [view, setView] = useState<DiffView>("full");
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(DIFF_VIEW_STORAGE_KEY);
      if (stored === "full" || stored === "changes") setView(stored);
    } catch {
      // Storage can be blocked; the view still works, it just isn't remembered.
    }
  }, []);
  const update = useCallback((next: DiffView) => {
    setView(next);
    try {
      window.localStorage.setItem(DIFF_VIEW_STORAGE_KEY, next);
    } catch {
      // As above.
    }
  }, []);
  return [view, update] as const;
}

/* ── Browser ──────────────────────────────────────────────────────────── */

/**
 * A repository version browsed like an editor's explorer: the tree at the
 * pinned commit (plus what the version adds) on the inline-end side, the
 * open file with its changes inline in the main area.
 */
export function RepoVersionBrowser({
  optimizationId,
  version,
  parent,
  path,
  onPathChange,
  onOpenFile,
}: {
  optimizationId: string;
  version: CandidateVersion;
  /** The version this one was proposed from, when the run recorded it. */
  parent: CandidateVersion | null;
  /** The reader's last pick; kept across versions while the file exists. */
  path: string | null;
  onPathChange: (path: string) => void;
  /** The open file and its text as this version leaves it, for copying; null while unknown. */
  onOpenFile: (file: { path: string; text: string } | null) => void;
}) {
  const [diffView, setDiffView] = useDiffView();
  const files = useMemo(() => parsePatch(version.text), [version.text]);
  const parentFiles = useMemo(() => (parent ? parsePatch(parent.text) : []), [parent]);
  const tree = useLoaded<RepositoryTreeResponse>(optimizationId, getRepositoryTree);
  const entries = tree?.status === "ready" ? tree.data.entries : null;
  const root = useMemo(() => buildRepoTree(entries ?? [], files), [entries, files]);

  const firstChanged = files[0]?.path ?? null;
  const selected =
    path != null && (hasFile(root, path) || (entries == null && tree?.status === "loading"))
      ? path
      : firstChanged;

  const onText = useCallback(
    (text: string | null) => onOpenFile(selected != null && text != null ? { path: selected, text } : null),
    [selected, onOpenFile],
  );
  useEffect(() => {
    if (selected == null) onOpenFile(null);
  }, [selected, onOpenFile]);

  return (
    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_15rem] lg:grid-cols-[minmax(0,1fr)_17rem]">
      <div className="min-w-0">
        {selected ? (
          <FileView
            key={selected}
            optimizationId={optimizationId}
            repository={tree?.status === "ready" ? tree.data.repository : null}
            path={selected}
            files={files}
            parent={parent}
            parentFiles={parentFiles}
            diffView={diffView}
            onDiffView={setDiffView}
            onText={onText}
          />
        ) : (
          <Notice>
            {msg(
              files.length === 0
                ? "optimization.blackbox.repo.unchanged"
                : "optimization.blackbox.repo.browser.pick_file",
            )}
          </Notice>
        )}
      </div>
      <aside className="order-first min-w-0 md:order-none md:border-s md:border-border/50 md:ps-3">
        <FileTree
          root={root}
          selected={selected}
          onSelect={onPathChange}
          loading={tree?.status === "loading" && files.length === 0}
          failed={tree?.status === "error"}
          truncated={tree?.status === "ready" && tree.data.truncated}
        />
      </aside>
    </div>
  );
}
