"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { contractCheckMessage } from "@/shared/lib/i18n";
import { Button } from "@/shared/ui/primitives/button";
import {
  ArrowsIn,
  ArrowsOut,
  CheckCircle,
  CircleNotch,
  ListChecks,
  XCircle,
} from "@/shared/ui/icons";
import type { ContractCheckItem, ContractCheckResponse } from "@/shared/types/unified-run";
import { contractConsole, type ContractConsole } from "../lib/contract-console";
import { blankEntryFile, diffWorkspace, workspaceTexts } from "../lib/ide-workspace";
import { METRIC_FILE, RUN_FILE } from "../lib/wizard-v2";
import { v2Msg } from "../components/v2/ArtifactConfirmCard";
import { park, unpark } from "./park";
import type { RepoSource } from "./repo-files";
import type { IdeWorkbench } from "./workbench";

function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

/** One failed check as a line under its file. */
function checkLine(item: ContractCheckItem, guided: boolean): string {
  const where =
    item.sample_index != null
      ? `${v2Msg("submit.v2.metric.check.sample_title", guided, { index: item.sample_index + 1 })}: `
      : "";
  const head = `${where}${contractCheckMessage(item)}`;
  return item.detail ? `${head}\n${item.detail}` : head;
}

/** What the last Check found in one file. */
interface FileCheck {
  path: string;
  console: ContractConsole;
}

function CheckResults({
  results,
  failed,
  emptyFile,
  guided,
  onOpen,
}: {
  results: FileCheck[];
  failed: boolean;
  /** The entry file that was empty, so the check was not sent. */
  emptyFile: string | null;
  guided: boolean;
  onOpen: (path: string) => void;
}) {
  if (emptyFile) {
    return (
      <p className="px-4 py-2 text-xs text-destructive">
        {v2Msg("submit.v2.ide.check.empty", guided, { path: emptyFile })}
      </p>
    );
  }
  if (failed) {
    return (
      <p className="px-4 py-2 text-xs text-destructive">
        {v2Msg("submit.v2.ide.check.failed", guided)}
      </p>
    );
  }
  return (
    <ul className="max-h-48 divide-y divide-border/40 overflow-y-auto text-xs">
      {results.map(({ path, console: result }) => (
        <li key={path} className="px-4 py-2">
          <button
            type="button"
            onClick={() => onOpen(path)}
            className="flex items-center gap-2 font-mono hover:underline"
            dir="ltr"
          >
            {result.valid ? (
              <CheckCircle className="size-4 text-[var(--success)]" aria-hidden />
            ) : (
              <XCircle className="size-4 text-destructive" aria-hidden />
            )}
            {path}
            <span className="font-sans text-muted-foreground">
              {result.valid
                ? v2Msg("submit.v2.ide.check.passed", guided)
                : v2Msg("submit.v2.metric.files.errors", guided, { count: result.errors.length })}
            </span>
          </button>
          {result.errors.length > 0 && (
            <pre dir="ltr" className="mt-1 whitespace-pre-wrap ps-6 font-mono text-destructive">
              {result.errors.join("\n\n")}
            </pre>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The Metric step's workspace as VS Code's workbench: explorer, tabs, search
 * and the command palette over the wizard's own files, with the coding agent
 * docked beside it. Full screen moves the page's one workbench into a
 * pop-up and back, so nothing reloads. Edits go straight into the wizard's
 * state, and the wizard's changes (the agent writing a file) show up here.
 */
export function IdeWorkspace({
  runCode,
  metricCode,
  files,
  onFileChange,
  onFileDelete,
  onCheck,
  checkResult,
  hint,
  repo,
  strip,
  sidePanel,
  guided,
}: {
  runCode: string;
  metricCode: string;
  files: Readonly<Record<string, string>>;
  onFileChange: (path: string, text: string) => void;
  onFileDelete: (path: string) => void;
  /** Run Check; null for a repository run, whose scorer is checked when it is submitted. */
  onCheck: (() => Promise<ContractCheckResponse | null>) | null;
  /** The last Check (or the static check while it is fresher); each file gets its line. */
  checkResult: ContractCheckResponse | null;
  /** What the entry files must define, from the contract. */
  hint: string | null;
  /** A repository run's checkout, shown read-only in the explorer. */
  repo: RepoSource | null;
  /** Shown above the editor (the metric model row). */
  strip?: ReactNode;
  /** The end-side region: the coding agent's chat. */
  sidePanel?: ReactNode;
  guided: boolean;
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [workbench, setWorkbench] = useState<IdeWorkbench | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const [checking, setChecking] = useState(false);
  // What the toolbar's own Check found that the wizard's result cannot say,
  // until the next result (the agent's own Check, say) replaces it.
  const [issue, setIssue] = useState<{
    after: ContractCheckResponse | null;
    emptyFile?: string;
    failed?: boolean;
  } | null>(null);
  const checkIssue = issue && issue.after === checkResult ? issue : null;

  const texts = useMemo(
    () => workspaceTexts(runCode, metricCode, files),
    [runCode, metricCode, files],
  );
  // The IDE reports the whole workspace after each edit; the wizard gets only
  // what differs from what it holds now.
  const latest = useRef(texts);
  const sinks = useRef({ onFileChange, onFileDelete, guided });
  useLayoutEffect(() => {
    latest.current = texts;
    sinks.current = { onFileChange, onFileDelete, guided };
  });

  useEffect(() => {
    let cancelled = false;
    // The workbench outlives this step, so a refusal reads the current mode.
    const describe = (issue: string) => v2Msg(issue, sinks.current.guided);
    import("./workbench")
      .then(({ bootWorkbench }) => bootWorkbench(isDark(), describe))
      .then((booted) => {
        if (!cancelled) setWorkbench(booted);
      })
      .catch((error: unknown) => {
        console.error("IDE workbench failed to load", error);
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!workbench) return;
    workbench.load(latest.current);
    workbench.onEdit((next) => {
      const { writes, deletes } = diffWorkspace(latest.current, next);
      // Keep the ref ahead of the re-render, so a second edit before it
      // lands diffs against this one.
      latest.current = next;
      for (const [path, text] of writes) sinks.current.onFileChange(path, text);
      for (const path of deletes) sinks.current.onFileDelete(path);
    });
    const theme = new MutationObserver(() => workbench.setDark(isDark()));
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    workbench.setDark(isDark());
    return () => {
      theme.disconnect();
      workbench.onEdit(null);
    };
  }, [workbench]);

  // Full screen renders a new host; the one workbench moves into it, and back.
  useEffect(() => {
    if (!workbench || !host) return;
    unpark(workbench.element, host);
    workbench.layout();
    const observer = new ResizeObserver(() => workbench.layout());
    observer.observe(host);
    return () => {
      observer.disconnect();
      // VS Code boots once per page, so between hosts it waits in the
      // document, fully hidden.
      park(workbench.element, document.body);
    };
  }, [workbench, host]);

  useEffect(() => {
    workbench?.load(texts);
  }, [workbench, texts]);

  useEffect(() => {
    workbench?.setRepo(repo);
  }, [workbench, repo]);
  useEffect(() => () => workbench?.setRepo(null), [workbench]);

  const toggleFullScreen = useCallback(async () => {
    await workbench?.saveAll();
    setFullScreen((open) => !open);
  }, [workbench]);

  const runCheck = useCallback(async () => {
    if (!onCheck) return;
    setChecking(true);
    try {
      await workbench?.saveAll();
      const emptyFile = blankEntryFile(
        latest.current[RUN_FILE] ?? "",
        latest.current[METRIC_FILE] ?? "",
      );
      if (emptyFile) {
        setIssue({ after: checkResult, emptyFile });
        return;
      }
      setIssue(null);
      if (!(await onCheck())) setIssue({ after: checkResult, failed: true });
    } finally {
      setChecking(false);
    }
  }, [workbench, onCheck, checkResult]);

  const extraPaths = useMemo(() => Object.keys(files).sort(), [files]);
  const results = useMemo<FileCheck[]>(() => {
    if (!checkResult) return [];
    const out: FileCheck[] = [];
    for (const path of [RUN_FILE, METRIC_FILE, ...extraPaths]) {
      const result = contractConsole(checkResult, path, (item) => checkLine(item, guided), extraPaths);
      // The entry files always get a line; a helper file only when it has a problem.
      if (result && (path === RUN_FILE || path === METRIC_FILE || !result.valid))
        out.push({ path, console: result });
    }
    return out;
  }, [checkResult, extraPaths, guided]);
  const showResults = checkIssue !== null || results.length > 0;

  const checkLabel = checking
    ? v2Msg("submit.v2.metric.check.running", guided)
    : v2Msg("submit.v2.metric.check.run", guided);
  const fullScreenLabel = fullScreen
    ? v2Msg("submit.v2.ide.exit_full_screen", guided)
    : v2Msg("submit.v2.ide.full_screen", guided);

  const body = (
    <>
      <header className="flex shrink-0 items-center gap-3 border-b border-border/60 px-4 py-2">
        <h2 id="ide-workspace-title" className="shrink-0 text-sm font-medium">
          {v2Msg("submit.v2.metric.title", guided)}
        </h2>
        {hint && (
          <p dir="ltr" title={hint} className="min-w-0 truncate font-mono text-xs text-muted-foreground">
            {hint}
          </p>
        )}
        <div className="ms-auto flex shrink-0 items-center gap-1">
          {onCheck && (
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={runCheck}
              disabled={!workbench || checking}
              aria-label={checkLabel}
            >
              {checking ? (
                <CircleNotch className="size-4 animate-spin" aria-hidden />
              ) : (
                <ListChecks className="size-4" aria-hidden />
              )}
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={toggleFullScreen}
            disabled={!workbench}
            aria-label={fullScreenLabel}
          >
            {fullScreen ? (
              <ArrowsIn className="size-4" aria-hidden />
            ) : (
              <ArrowsOut className="size-4" aria-hidden />
            )}
          </Button>
        </div>
      </header>
      {showResults && (
        <div aria-live="polite" className="shrink-0 border-b border-border/60">
          <CheckResults
            results={results}
            failed={checkIssue?.failed ?? false}
            emptyFile={checkIssue?.emptyFile ?? null}
            guided={guided}
            onOpen={(path) => void workbench?.openFile(path)}
          />
        </div>
      )}
      {strip && <div className="shrink-0 border-b border-border/60 px-4 py-2">{strip}</div>}
      <div className="flex min-h-0 flex-1">
        {/* VS Code lays out left to right whatever the page direction. */}
        <div dir="ltr" className="relative min-w-0 flex-1">
          <div ref={setHost} className="absolute inset-0" />
          {!workbench && (
            <p className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">
              {loadFailed
                ? v2Msg("submit.v2.ide.load_failed", guided)
                : v2Msg("submit.v2.ide.loading", guided)}
            </p>
          )}
        </div>
        {sidePanel && (
          <aside className="relative w-80 shrink-0 border-s border-border/60 xl:w-96">
            {sidePanel}
          </aside>
        )}
      </div>
    </>
  );

  if (!fullScreen) {
    return (
      <section aria-labelledby="ide-workspace-title" className="flex h-full min-h-0 flex-col">
        {body}
      </section>
    );
  }
  // On body, not in place: the wizard's card has a backdrop filter, which
  // makes it the containing block of a fixed child, and the agent chat's own
  // tooltips and popovers portal to body at z-index 50, so the pop-up takes
  // the same layer and they open above it.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="ide-workspace-title"
      className="fixed inset-0 flex flex-col bg-background"
      style={{ zIndex: 50 }}
    >
      {body}
    </div>,
    document.body,
  );
}
