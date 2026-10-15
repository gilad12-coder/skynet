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
import { Button } from "@/shared/ui/primitives/button";
import { CheckCircle, CircleNotch, X, XCircle } from "@/shared/ui/icons";
import type { ContractCheckResponse } from "@/shared/types/unified-run";
import type { ContractConsole } from "../lib/contract-console";
import { blankEntryFile, diffWorkspace, workspaceTexts } from "../lib/ide-workspace";
import { METRIC_FILE, RUN_FILE } from "../lib/wizard-v2";
import { v2Msg } from "../components/v2/ArtifactConfirmCard";
import { park, unpark } from "./park";
import type { IdeWorkbench } from "./workbench";

function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
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
 * The workspace in VS Code's workbench, full screen: explorer, tabs, search
 * and the command palette over the wizard's own files. Edits go straight into
 * the wizard's state, and the wizard's changes (the agent writing a file)
 * show up here, so closing the pop-up loses nothing.
 */
export function IdeDialog({
  runCode,
  metricCode,
  files,
  onFileChange,
  onFileDelete,
  onCheck,
  consoleFor,
  onClose,
  guided,
  sidePanel,
}: {
  runCode: string;
  metricCode: string;
  files: Readonly<Record<string, string>>;
  onFileChange: (path: string, text: string) => void;
  onFileDelete: (path: string) => void;
  onCheck: () => Promise<ContractCheckResponse | null>;
  consoleFor: (result: ContractCheckResponse | null, path: string) => ContractConsole | null;
  onClose: () => void;
  guided: boolean;
  /** The end-side region: the coding agent's chat. */
  sidePanel?: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [workbench, setWorkbench] = useState<IdeWorkbench | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<{
    result: ContractCheckResponse | null;
    emptyFile?: string;
  } | null>(null);

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
    // The workbench outlives this pop-up, so a refusal reads the current mode.
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
    const into = host.current;
    if (!workbench || !into) return;
    workbench.load(latest.current);
    workbench.onEdit((next) => {
      const { writes, deletes } = diffWorkspace(latest.current, next);
      // Keep the ref ahead of the re-render, so a second edit before it
      // lands diffs against this one.
      latest.current = next;
      for (const [path, text] of writes) sinks.current.onFileChange(path, text);
      for (const path of deletes) sinks.current.onFileDelete(path);
    });
    unpark(workbench.element, into);
    workbench.layout();
    const observer = new ResizeObserver(() => workbench.layout());
    observer.observe(into);
    const theme = new MutationObserver(() => workbench.setDark(isDark()));
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    workbench.setDark(isDark());
    return () => {
      observer.disconnect();
      theme.disconnect();
      workbench.onEdit(null);
      // The workbench lives for the whole page (VS Code boots once), so it
      // waits in the document, fully hidden, until the next open.
      park(workbench.element, document.body);
    };
  }, [workbench]);

  useEffect(() => {
    workbench?.load(texts);
  }, [workbench, texts]);

  const close = useCallback(async () => {
    await workbench?.saveAll();
    onClose();
  }, [workbench, onClose]);

  const runCheck = useCallback(async () => {
    setChecking(true);
    try {
      await workbench?.saveAll();
      const emptyFile = blankEntryFile(
        latest.current[RUN_FILE] ?? "",
        latest.current[METRIC_FILE] ?? "",
      );
      setCheck(emptyFile ? { result: null, emptyFile } : { result: await onCheck() });
    } finally {
      setChecking(false);
    }
  }, [workbench, onCheck]);

  const results = useMemo<FileCheck[]>(() => {
    if (!check?.result) return [];
    const out: FileCheck[] = [];
    for (const path of [RUN_FILE, METRIC_FILE, ...Object.keys(files).sort()]) {
      const result = consoleFor(check.result, path);
      // The entry files always get a line; a helper file only when it has a problem.
      if (result && (path === RUN_FILE || path === METRIC_FILE || !result.valid))
        out.push({ path, console: result });
    }
    return out;
  }, [check, consoleFor, files]);

  // On body, not in place: the wizard's card has a backdrop filter, which
  // makes it the containing block of a fixed child, and the agent chat's own
  // tooltips, popovers and drawer portal to body at z-index 50, so the pop-up
  // takes the same layer and they open above it.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="ide-dialog-title"
      className="fixed inset-0 flex flex-col bg-background"
      style={{ zIndex: 50 }}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2">
        <h2 id="ide-dialog-title" className="text-sm font-medium">
          {v2Msg("submit.v2.ide.title", guided)}
        </h2>
        <div className="ms-auto flex items-center gap-2">
          <Button size="sm" onClick={runCheck} disabled={!workbench || checking}>
            {checking && <CircleNotch className="size-4 animate-spin" aria-hidden />}
            {checking
              ? v2Msg("submit.v2.metric.check.running", guided)
              : v2Msg("submit.v2.metric.check.run", guided)}
          </Button>
          <Button size="sm" variant="ghost" onClick={close}>
            <X className="size-4" aria-hidden />
            {v2Msg("submit.v2.ide.close", guided)}
          </Button>
        </div>
      </header>
      {check && (
        <div aria-live="polite" className="shrink-0 border-b border-border/60">
          <CheckResults
            results={results}
            failed={!check.result}
            emptyFile={check.emptyFile ?? null}
            guided={guided}
            onOpen={(path) => void workbench?.openFile(path)}
          />
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {/* VS Code lays out left to right whatever the page direction. */}
        <div dir="ltr" className="relative min-w-0 flex-1">
          <div ref={host} className="absolute inset-0" />
          {!workbench && (
            <p className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">
              {loadFailed
                ? v2Msg("submit.v2.ide.load_failed", guided)
                : v2Msg("submit.v2.ide.loading", guided)}
            </p>
          )}
        </div>
        {sidePanel && (
          <aside className="relative w-96 shrink-0 border-s border-border/60">{sidePanel}</aside>
        )}
      </div>
    </div>,
    document.body,
  );
}
