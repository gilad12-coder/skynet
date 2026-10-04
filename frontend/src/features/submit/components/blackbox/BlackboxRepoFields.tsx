"use client";

import { useEffect, useState } from "react";
import { toast } from "react-toastify";

import { FloppyDisk, GitBranch, GithubLogo, Plus, Trash } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { Input } from "@/shared/ui/primitives/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/primitives/select";
import { TOUCH_FIELD } from "@/shared/ui/touch";
import { useConnectors } from "@/features/connectors";
import {
  listGithubBranches,
  listSavedSecrets,
  saveSecret,
  startConnectorOAuth,
  type SavedSecret,
} from "@/shared/lib/api";
import { msg } from "@/shared/lib/messages";

import {
  REPO_NAME_PATTERN,
  REPO_SECRET_NAME_PATTERN,
  type BlackboxWizardContext,
  type RepoSecretRow,
} from "../../hooks/use-blackbox-wizard";
import { RepoPathTree } from "./RepoPathTree";
import { RepoPicker } from "./RepoPicker";
import { Field } from "./shared";

// The select's value for a row whose secret is typed into this run only.
const TYPED = "__typed__";

/**
 * The Goal stage of a repository run: which GitHub repository, which of its
 * paths the agent may edit, how a checkout is prepared, and the secrets the
 * scorer reads. The GitHub link itself lives in Settings; this offers it
 * when it is missing.
 */
export function BlackboxRepoFields({ w }: { w: BlackboxWizardContext }) {
  const {
    repoName,
    setRepoName,
    repoBranch,
    setRepoBranch,
    repoPaths,
    setRepoPaths,
    repoSetup,
    setRepoSetup,
    repoSecrets,
    setRepoSecrets,
  } = w;
  const { byProvider, loading } = useConnectors();
  const github = byProvider("github");
  const linked = github?.connected === true && github.status !== "invalid";
  const [saved, setSaved] = useState<SavedSecret[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [savingRow, setSavingRow] = useState<number | null>(null);
  const repoChosen = linked && REPO_NAME_PATTERN.test(repoName.trim());

  useEffect(() => {
    let cancelled = false;
    listSavedSecrets()
      .then((res) => {
        if (!cancelled) setSaved(res.secrets);
      })
      .catch(() => {
        // Without the list every row is typed in.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const connect = async () => {
    setConnecting(true);
    try {
      const { authorize_url } = await startConnectorOAuth("github");
      // The draft is saved as the page leaves, so the setup returns intact.
      window.location.assign(authorize_url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : msg("submit.blackbox.repo.connect_failed"));
      setConnecting(false);
    }
  };

  const updateRow = (index: number, patch: Partial<RepoSecretRow>) =>
    setRepoSecrets(repoSecrets.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const pickSource = (index: number, value: string) => {
    if (value === TYPED) {
      updateRow(index, { savedSecretId: null });
      return;
    }
    const secret = saved.find((s) => s.id === value);
    const row = repoSecrets[index];
    updateRow(index, {
      savedSecretId: value,
      value: "",
      // A blank name takes the saved secret's own.
      name: row?.name.trim() ? row.name : (secret?.name ?? ""),
    });
  };

  const saveRow = async (index: number) => {
    const row = repoSecrets[index];
    if (!row || !REPO_SECRET_NAME_PATTERN.test(row.name.trim()) || !row.value) return;
    setSavingRow(index);
    try {
      const secret = await saveSecret(row.name.trim(), row.value);
      setSaved((prev) => [...prev.filter((s) => s.id !== secret.id), secret]);
      updateRow(index, { savedSecretId: secret.id, value: "" });
      toast.success(msg("submit.blackbox.repo.secret_saved"));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : msg("submit.blackbox.repo.secret_save_failed"),
      );
    } finally {
      setSavingRow(null);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {!loading && !linked && (
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            {msg("submit.blackbox.repo.connect_hint")}
          </p>
          <Button
            type="button"
            onClick={() => void connect()}
            disabled={connecting || github?.oauth_available === false}
            className="min-h-11 shrink-0 gap-2"
          >
            <GithubLogo className="size-4" aria-hidden="true" />
            {msg("submit.blackbox.repo.connect")}
          </Button>
        </div>
      )}

      {linked && (
        <Field label={msg("submit.blackbox.repo.repository_label")}>
          <RepoPicker
            value={repoName}
            onPick={(repo) => {
              if (repo.full_name === repoName.trim()) return;
              setRepoName(repo.full_name);
              // Another repository's branch and paths mean nothing here.
              setRepoBranch("");
              setRepoPaths(".");
            }}
          />
        </Field>
      )}

      {repoChosen && (
        <>
          <Field
            label={msg("submit.blackbox.repo.branch_label")}
            htmlFor="bb-repo-branch"
            hint={msg("submit.blackbox.repo.branch_tip")}
          >
            <BranchSelect
              repo={repoName.trim()}
              branch={repoBranch}
              onBranchChange={setRepoBranch}
            />
          </Field>
          <Field
            label={msg("submit.blackbox.repo.paths_label")}
            hint={msg("submit.blackbox.repo.paths_tip")}
          >
            <RepoPathTree
              repo={repoName.trim()}
              branch={repoBranch.trim()}
              paths={repoPaths}
              onPathsChange={setRepoPaths}
            />
          </Field>
        </>
      )}

      <Field
        label={msg("submit.blackbox.repo.setup_label")}
        htmlFor="bb-repo-setup"
        hint={msg("submit.blackbox.repo.setup_hint")}
      >
        <Input
          id="bb-repo-setup"
          value={repoSetup}
          onChange={(e) => setRepoSetup(e.target.value)}
          placeholder="pip install -e ."
          autoComplete="off"
          spellCheck={false}
          className={`${TOUCH_FIELD} font-mono`}
        />
      </Field>

      <Field
        label={msg("submit.blackbox.repo.secrets_label")}
        hint={msg("submit.blackbox.repo.secrets_hint")}
      >
        <div id="bb-repo-secrets" tabIndex={-1} className="flex flex-col gap-2 outline-none">
          {repoSecrets.map((row, index) => (
            <div
              key={index}
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-xl border border-border p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)_auto]"
            >
              <Input
                aria-label={msg("submit.blackbox.repo.secret_name")}
                value={row.name}
                onChange={(e) => updateRow(index, { name: e.target.value })}
                placeholder="API_KEY"
                autoComplete="off"
                spellCheck={false}
                className={`${TOUCH_FIELD} font-mono`}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={msg("submit.blackbox.repo.secret_remove")}
                onClick={() => setRepoSecrets(repoSecrets.filter((_, i) => i !== index))}
                className="size-11 text-muted-foreground hover:text-destructive sm:order-last sm:size-9"
              >
                <Trash className="size-4" />
              </Button>
              <Select
                value={row.savedSecretId ?? TYPED}
                onValueChange={(value) => pickSource(index, value)}
              >
                <SelectTrigger
                  aria-label={msg("submit.blackbox.repo.secret_source")}
                  className={`${TOUCH_FIELD} col-span-2 w-full sm:col-span-1`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={TYPED}>{msg("submit.blackbox.repo.secret_typed")}</SelectItem>
                  {saved.map((secret) => (
                    <SelectItem key={secret.id} value={secret.id}>
                      {secret.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {row.savedSecretId ? (
                <p className="col-span-2 self-center text-xs text-muted-foreground sm:col-span-1">
                  {msg("submit.blackbox.repo.secret_from_account")}
                </p>
              ) : (
                <div className="col-span-2 flex gap-2 sm:col-span-1">
                  <Input
                    type="password"
                    aria-label={msg("submit.blackbox.repo.secret_value")}
                    value={row.value}
                    onChange={(e) => updateRow(index, { value: e.target.value })}
                    placeholder={msg("submit.blackbox.repo.secret_value")}
                    autoComplete="new-password"
                    className={TOUCH_FIELD}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={msg("submit.blackbox.repo.secret_save")}
                    title={msg("submit.blackbox.repo.secret_save")}
                    disabled={
                      savingRow !== null ||
                      !row.value ||
                      !REPO_SECRET_NAME_PATTERN.test(row.name.trim())
                    }
                    onClick={() => void saveRow(index)}
                    className="size-11 shrink-0 sm:size-9"
                  >
                    <FloppyDisk className="size-4" />
                  </Button>
                </div>
              )}
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              setRepoSecrets([...repoSecrets, { name: "", value: "", savedSecretId: null }])
            }
            className="min-h-11 w-full gap-2 rounded-lg border-dashed bg-transparent shadow-none"
          >
            <Plus className="size-4" aria-hidden="true" />
            {msg("submit.blackbox.repo.secret_add")}
          </Button>
        </div>
      </Field>
    </div>
  );
}

/**
 * The repository's branches as a select, opening on the default branch. An
 * empty value is the default branch, as the run reads it; when the list
 * cannot load, the branch is typed instead.
 */
function BranchSelect({
  repo,
  branch,
  onBranchChange,
}: {
  repo: string;
  branch: string;
  onBranchChange: (branch: string) => void;
}) {
  const [data, setData] = useState<{ default_branch: string | null; branches: string[] } | null>(
    null,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setFailed(false);
    listGithubBranches(repo)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [repo]);

  if (failed) {
    return (
      <Input
        id="bb-repo-branch"
        value={branch}
        onChange={(e) => onBranchChange(e.target.value)}
        placeholder={msg("submit.blackbox.repo.branch_default")}
        autoComplete="off"
        spellCheck={false}
        className={`${TOUCH_FIELD} font-mono`}
      />
    );
  }

  const fallback = data?.default_branch ?? "";
  const value = branch.trim() || fallback;
  const options = data ? data.branches : [];
  // A branch restored from a draft stays choosable even past the list's cap.
  const names = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <Select
      value={value}
      onValueChange={(next) => onBranchChange(next === fallback ? "" : next)}
      disabled={!data}
    >
      <SelectTrigger id="bb-repo-branch" className={`${TOUCH_FIELD} w-full font-mono`}>
        <span className="flex min-w-0 items-center gap-2">
          <GitBranch className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <SelectValue placeholder={msg("submit.blackbox.repo.branch_loading")} />
        </span>
      </SelectTrigger>
      <SelectContent>
        {names.map((name) => (
          <SelectItem key={name} value={name} className="font-mono">
            {name}
            {name === fallback && (
              <span className="ms-2 font-sans text-xs text-muted-foreground">
                {msg("submit.blackbox.repo.branch_default")}
              </span>
            )}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
