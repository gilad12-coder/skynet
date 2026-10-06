"use client";

import { useState } from "react";
import { versionForPrompt, type CandidateVersion } from "../lib/blackbox-versions";
import { RepoVersionBrowser } from "./RepoVersionBrowser";

const ignoreOpenFile = () => {};

/** A candidate-tree node of a repository run, browsed as files like the Versions tab. */
export function RepoCandidateBrowser({
  optimizationId,
  versions,
  prompt,
  parentPrompt,
}: {
  optimizationId: string;
  versions: CandidateVersion[];
  prompt: Record<string, string>;
  parentPrompt: Record<string, string>;
}) {
  const [path, setPath] = useState<string | null>(null);
  const version = versionForPrompt(versions, prompt);
  const parent = versionForPrompt(versions, parentPrompt);
  if (!version) return null;
  return (
    <RepoVersionBrowser
      optimizationId={optimizationId}
      version={version}
      // The compare switch names the parent by version number, so a parent that
      // never became a version is left to the starting-commit view.
      parent={parent && parent.number >= 0 ? parent : null}
      path={path}
      onPathChange={setPath}
      onOpenFile={ignoreOpenFile}
    />
  );
}
