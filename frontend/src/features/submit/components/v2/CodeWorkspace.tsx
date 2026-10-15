"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { LazyCodeEditor as CodeEditor } from "@/shared/ui/lazy-code-editor";
import { Button } from "@/shared/ui/primitives/button";
import { ArrowsOut } from "@/shared/ui/icons";
import { contractCheckMessage } from "@/shared/lib/i18n";
import type { ContractCheckItem, ContractCheckResponse } from "@/shared/types/unified-run";
import { contractConsole } from "../../lib/contract-console";
import { withScorerImports } from "../../lib/scorer-dependencies";
import { METRIC_FILE, RUN_FILE } from "../../lib/wizard-v2";
import { ArtifactStatusChip } from "../steps/AuthoringShell";
import { v2Msg } from "./ArtifactConfirmCard";
import { WorkspaceTree } from "./WorkspaceTree";

// The IDE pop-up and VS Code behind it load only when the pop-up opens.
const IdeDialog = dynamic(() => import("../../ide/IdeDialog").then((module) => module.IdeDialog), {
  ssr: false,
});

/** One failed check as a line in an editor's console. */
function contractConsoleLine(item: ContractCheckItem, guided: boolean): string {
  const where =
    item.sample_index != null
      ? `${v2Msg("submit.v2.metric.check.sample_title", guided, { index: item.sample_index + 1 })}: `
      : "";
  const head = `${where}${contractCheckMessage(item)}`;
  return item.detail ? `${head}\n${item.detail}` : head;
}

// The one editor fills the screen beside the tree; 22rem leaves room for the
// wizard chrome and the contract hint line, which a 1440x900 screen clipped.
const EDITOR_HEIGHT = "max(18rem, calc(100svh - 22rem))";
// Grammar names as @codemirror/language-data knows them; Python is the default.
const TEXT_GRAMMARS: Record<string, string> = {
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  md: "Markdown",
  toml: "TOML",
  ini: "Properties files",
  cfg: "Properties files",
  csv: "CSV",
  txt: "Text",
};

function grammarFor(path: string): string | undefined {
  return TEXT_GRAMMARS[path.slice(path.lastIndexOf(".") + 1).toLowerCase()];
}

// What the black-box runner calls on a repository run, with the checkout's path.
const REPO_SCORER_SIGNATURE = "def score(repo_path, case=None) -> float | dict";

// What a person writing the code by hand must define, straight from the
// contract the coding agent writes under; nothing when the catalog is unknown.
function ContractHint({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  return (
    <p dir="ltr" className="font-mono text-xs text-muted-foreground">
      {text}
    </p>
  );
}

function EditorBlock({
  id,
  title,
  writing,
  children,
}: {
  id: string;
  title: string;
  writing: boolean;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-label`} className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={`${id}-label`} className="text-sm font-medium">
          {title}
        </h4>
        <ArtifactStatusChip status={writing ? "writing" : "idle"} />
      </div>
      {children}
    </section>
  );
}

/** Which code the docked agent's coding tool is streaming in right now. */
export interface WorkspaceWriting {
  run: boolean;
  metric: boolean;
  files: readonly string[];
}

/**
 * The workspace like a small IDE: a file tree (run.py, metric.py and the
 * extra files run.py imports) and one editor for the open file. Every program
 * uses the same contract: the agent's coding tool writes the files, the user
 * can edit any of them, add files and delete the extra ones.
 */
export function CodeWorkspace({
  runCode,
  metricCode,
  files,
  onFileChange,
  onFileDelete,
  writing,
  guided,
  runEntry,
  metricSignature,
  checkResult,
  onCheck,
  repo = false,
  children,
}: {
  runCode: string;
  metricCode: string;
  /** The extra files, path to text. */
  files: Readonly<Record<string, string>>;
  /** Write one file's text, creating an extra file that does not exist yet. */
  onFileChange: (path: string, text: string) => void;
  onFileDelete: (path: string) => void;
  writing: WorkspaceWriting;
  guided: boolean;
  /** The run code's entry point for the artifact kind, from the optimizer catalog. */
  runEntry?: string | null;
  /** The metric's signature for the chosen optimizer, from the optimizer catalog. */
  metricSignature?: string | null;
  /** The last sandboxed contract check; each file's console shows its own failures. */
  checkResult: ContractCheckResponse | null;
  /** Runs the contract check from the editor's Run button. */
  onCheck: () => Promise<ContractCheckResponse | null>;
  /**
   * A repository run: the checkout is the candidate, so there is no run code
   * and no tree, and the scorer is checked on the server at submit.
   */
  repo?: boolean;
  /** Rendered above the metric editor (the metric model row). */
  children?: ReactNode;
}) {
  const extraPaths = useMemo(() => Object.keys(files).sort(), [files]);
  const paths = useMemo(() => [RUN_FILE, METRIC_FILE, ...extraPaths], [extraPaths]);
  const [chosen, setChosen] = useState<string>(repo ? METRIC_FILE : RUN_FILE);
  const [ideOpen, setIdeOpen] = useState(false);
  const open = repo ? METRIC_FILE : paths.includes(chosen) ? chosen : RUN_FILE;

  const writingPaths = useMemo(
    () =>
      new Set([
        ...(writing.run ? [RUN_FILE] : []),
        ...(writing.metric ? [METRIC_FILE] : []),
        ...writing.files,
      ]),
    [writing],
  );
  // Follow the agent to the file it starts writing, so its code is seen streaming in.
  const seenWriting = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const started = [...writingPaths].find((path) => !seenWriting.current.has(path));
    seenWriting.current = writingPaths;
    if (started && !repo) setChosen(started);
  }, [writingPaths, repo]);

  const consoleFor = useCallback(
    (result: ContractCheckResponse | null, path: string) =>
      contractConsole(result, path, (item) => contractConsoleLine(item, guided), extraPaths),
    [guided, extraPaths],
  );
  const problems = useMemo(
    () =>
      Object.fromEntries(
        paths.map((path) => [path, consoleFor(checkResult, path)?.errors.length ?? 0]),
      ),
    [paths, consoleFor, checkResult],
  );
  const openConsole = useMemo(() => consoleFor(checkResult, open), [consoleFor, checkResult, open]);
  const runCheck = useCallback(async () => consoleFor(await onCheck(), open), [consoleFor, onCheck, open]);
  const runLabel = v2Msg("submit.v2.metric.check.run", guided);
  const runningLabel = v2Msg("submit.v2.metric.check.running", guided);

  const text = open === RUN_FILE ? runCode : open === METRIC_FILE ? metricCode : (files[open] ?? "");
  const onChange = useCallback((code: string) => onFileChange(open, code), [onFileChange, open]);
  const title =
    open === RUN_FILE
      ? v2Msg("submit.v2.metric.run_label", guided)
      : open === METRIC_FILE
        ? v2Msg("submit.v2.metric.metric_label", guided)
        : open;
  const isWriting = writingPaths.has(open);

  const editor = (
    <EditorBlock id="v2-workspace-file" title={title} writing={isWriting}>
      {/* Above the editor: the editor fills the card's height, so a line under
          it falls past the card's bottom edge on a laptop screen. */}
      {open === RUN_FILE && <ContractHint text={runEntry} />}
      {open === METRIC_FILE && <ContractHint text={repo ? REPO_SCORER_SIGNATURE : metricSignature} />}
      {open !== RUN_FILE && open !== METRIC_FILE && (
        <p className="text-xs text-muted-foreground">
          {v2Msg("submit.v2.metric.files.extra_hint", guided)}
        </p>
      )}
      {open === METRIC_FILE && children}
      <div
        tabIndex={-1}
        className="outline-none"
        onBlur={(event) => {
          // The sandbox still injects `llm` for old scorers; making the
          // import explicit keeps the code honest about what it calls.
          if (open !== METRIC_FILE || event.currentTarget.contains(event.relatedTarget)) return;
          const code = withScorerImports(metricCode);
          if (code !== metricCode) onFileChange(METRIC_FILE, code);
        }}
      >
        <CodeEditor
          key={open}
          value={text}
          onChange={onChange}
          height={EDITOR_HEIGHT}
          language={grammarFor(open)}
          onRun={repo ? undefined : runCheck}
          runLabel={runLabel}
          runningLabel={runningLabel}
          validationResult={repo ? undefined : openConsole}
          streaming={isWriting}
        />
      </div>
    </EditorBlock>
  );

  if (repo) return <div className="space-y-5 px-4 py-4 sm:px-6">{editor}</div>;
  // The pane is narrow while the agent is docked beside it, so the tree sits
  // above the editor until the pane itself is wide enough for both.
  return (
    <div className="@container px-4 py-4 sm:px-6">
      <div className="flex flex-col gap-4 @2xl:flex-row @2xl:items-start">
        <div className="space-y-2 @2xl:sticky @2xl:top-0 @2xl:w-48 @2xl:shrink-0">
          <Button size="xs" variant="outline" className="w-full" onClick={() => setIdeOpen(true)}>
            <ArrowsOut aria-hidden />
            {v2Msg("submit.v2.ide.open", guided)}
          </Button>
          <WorkspaceTree
            paths={paths}
            files={files}
            selected={open}
            onSelect={setChosen}
            onAdd={(path) => {
              onFileChange(path, "");
              setChosen(path);
            }}
            onDelete={(path) => {
              if (open === path) setChosen(RUN_FILE);
              onFileDelete(path);
            }}
            writing={writingPaths}
            problems={problems}
            guided={guided}
          />
        </div>
        <div className="min-w-0 flex-1">{editor}</div>
      </div>
      {ideOpen && (
        <IdeDialog
          runCode={runCode}
          metricCode={metricCode}
          files={files}
          onFileChange={onFileChange}
          onFileDelete={(path) => {
            if (open === path) setChosen(RUN_FILE);
            onFileDelete(path);
          }}
          onCheck={onCheck}
          consoleFor={consoleFor}
          onClose={() => setIdeOpen(false)}
          guided={guided}
        />
      )}
    </div>
  );
}
