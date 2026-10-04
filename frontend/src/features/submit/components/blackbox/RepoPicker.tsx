"use client";

import { useEffect, useMemo, useState } from "react";

import { GithubLogo, Lock, Globe } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { SearchField } from "@/shared/ui/search-field";
import { Skeleton } from "@/shared/ui/skeleton";
import { InlineErrorRow } from "@/shared/ui/inline-error-row";
import { listGithubRepositories, type GithubRepository } from "@/shared/lib/api";
import { formatRelativeTime } from "@/shared/lib/formatters";
import { msg } from "@/shared/lib/messages";
import { cn } from "@/shared/lib/utils";

import { REPO_NAME_PATTERN } from "../../hooks/use-blackbox-wizard";

// Long enough that typing a whole owner/name asks GitHub once, not per key.
const LOOKUP_DELAY_MS = 400;

function VisibilityBadge({ repo }: { repo: GithubRepository }) {
  const Icon = repo.private ? Lock : Globe;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-[0.6875rem] font-medium text-muted-foreground">
      <Icon className="size-3" aria-hidden="true" />
      {repo.private ? msg("submit.blackbox.repo.private") : msg("submit.blackbox.repo.public")}
    </span>
  );
}

function RepoSummary({ repo }: { repo: GithubRepository }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1 text-start">
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate font-mono text-sm font-semibold" dir="ltr">
          {repo.full_name}
        </span>
        <VisibilityBadge repo={repo} />
      </span>
      {repo.description && (
        <span className="line-clamp-2 text-xs text-muted-foreground" dir="auto">
          {repo.description}
        </span>
      )}
      {(repo.language || repo.pushed_at) && (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem] text-muted-foreground">
          {repo.language && (
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="size-2 rounded-full bg-[#C8A882]" />
              {repo.language}
            </span>
          )}
          {repo.pushed_at && (
            <span>
              {msg("submit.blackbox.repo.pushed", { when: formatRelativeTime(repo.pushed_at) })}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

/**
 * The linked account's repositories as a searchable list. Typing a full
 * ``owner/name`` the list lacks asks GitHub for it, so a public repository
 * outside the account can still be chosen.
 */
export function RepoPicker({
  value,
  onPick,
}: {
  value: string;
  onPick: (repo: GithubRepository) => void;
}) {
  const [repos, setRepos] = useState<GithubRepository[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [search, setSearch] = useState("");
  const [offer, setOffer] = useState<GithubRepository | null>(null);
  // A chosen repository folds the list away until the user asks to change it.
  const [browsing, setBrowsing] = useState(() => !REPO_NAME_PATTERN.test(value.trim()));

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    listGithubRepositories("")
      .then((res) => {
        if (!cancelled) setRepos(res.repositories);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const needle = search.trim().toLowerCase();
  const matches = useMemo(
    () => (repos ?? []).filter((repo) => repo.full_name.toLowerCase().includes(needle)),
    [repos, needle],
  );
  const listed = matches.some((repo) => repo.full_name.toLowerCase() === needle);
  const lookup = repos !== null && REPO_NAME_PATTERN.test(search.trim()) && !listed;

  useEffect(() => {
    setOffer(null);
    if (!lookup) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      listGithubRepositories(search.trim())
        .then((res) => {
          const found = res.repositories.find((repo) => repo.full_name.toLowerCase() === needle);
          if (!cancelled) setOffer(found ?? null);
        })
        .catch(() => {
          // The list still works; only the typed repository goes unoffered.
        });
    }, LOOKUP_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [lookup, search, needle]);

  const current = (repos ?? []).find((repo) => repo.full_name === value.trim()) ?? null;

  if (!browsing && value.trim()) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-border bg-background p-3">
        <GithubLogo className="mt-0.5 size-5 shrink-0 text-[#3D2E22]" aria-hidden="true" />
        {current ? (
          <RepoSummary repo={current} />
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono text-sm font-semibold" dir="ltr">
            {value}
          </span>
        )}
        <Button
          id="bb-repo-name"
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setBrowsing(true)}
          className="min-h-11 shrink-0 lg:min-h-8"
        >
          {msg("submit.blackbox.repo.change")}
        </Button>
      </div>
    );
  }

  const rows = offer ? [offer, ...matches] : matches;
  const pick = (repo: GithubRepository) => {
    onPick(repo);
    setBrowsing(false);
    setSearch("");
  };

  return (
    <div className="flex flex-col gap-2">
      {/* The wizard's validation focuses this when the repository is missing. */}
      <div id="bb-repo-name" tabIndex={-1} className="outline-none">
        <SearchField
          value={search}
          onValueChange={setSearch}
          placeholder={msg("submit.blackbox.repo.search")}
        />
      </div>
      {failed ? (
        <InlineErrorRow
          message={msg("submit.blackbox.repo.repos_failed")}
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
      ) : repos === null ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-xl border border-border/60 p-3">
              <Skeleton width="45%" height={14} />
              <Skeleton width="80%" height={10} className="mt-2" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          {lookup
            ? msg("submit.blackbox.repo.repos_lookup")
            : msg("submit.blackbox.repo.repos_empty")}
        </p>
      ) : (
        <ul
          aria-label={msg("submit.blackbox.repo.repository_label")}
          className="flex max-h-80 flex-col gap-1.5 overflow-y-auto overscroll-contain rounded-xl"
        >
          {rows.map((repo) => {
            const selected = repo.full_name === value.trim();
            return (
              <li key={repo.full_name}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => pick(repo)}
                  className={cn(
                    "flex min-h-11 w-full cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8A882]/45",
                    selected
                      ? "border-foreground/40 bg-muted/60"
                      : "border-border bg-background hover:border-[#C8A882] hover:bg-muted/30",
                  )}
                >
                  <GithubLogo
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <RepoSummary repo={repo} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
