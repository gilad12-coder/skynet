"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Dialog as DialogPrimitive } from "radix-ui";
import { MagnifyingGlass } from "@/shared/ui/icons";
import { Kbd } from "@/shared/ui/kbd";
import { cn } from "@/shared/lib/utils";

interface SearchEntry {
  href: string;
  title: string;
  section: string;
  headings: Array<{ id: string; text: string }>;
  text: string;
}

interface SearchHit {
  key: string;
  href: string;
  title: string;
  context: string;
  snippet: string;
  score: number;
}

const MAX_HITS = 12;
const indexes = new Map<string, Promise<SearchEntry[]>>();

/** Load a locale's search index once per page view. */
function loadIndex(locale: string): Promise<SearchEntry[]> {
  let pending = indexes.get(locale);
  if (!pending) {
    pending = fetch(`/docs-search?locale=${locale}`).then((res) => {
      if (!res.ok) throw new Error(`search index: ${res.status}`);
      return res.json() as Promise<SearchEntry[]>;
    });
    pending.catch(() => indexes.delete(locale));
    indexes.set(locale, pending);
  }
  return pending;
}

/** A short piece of text around the first match. */
function snippetAround(text: string, term: string): string {
  const at = text.toLowerCase().indexOf(term);
  if (at < 0) return "";
  const start = Math.max(0, at - 50);
  const end = Math.min(text.length, at + term.length + 90);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** Rank pages and headings for a query. Every word in the query must match. */
function search(entries: SearchEntry[], query: string): SearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const all = (value: string) => terms.every((t) => value.toLowerCase().includes(t));
  const hits: SearchHit[] = [];
  for (const entry of entries) {
    const inTitle = all(entry.title);
    const inBody = all(`${entry.title} ${entry.text}`);
    if (inTitle || inBody) {
      hits.push({
        key: entry.href,
        href: entry.href,
        title: entry.title,
        context: entry.section,
        snippet: inTitle ? "" : snippetAround(entry.text, terms[0] ?? ""),
        score: inTitle ? 100 : 10,
      });
    }
    for (const heading of entry.headings) {
      if (!all(heading.text)) continue;
      hits.push({
        key: `${entry.href}#${heading.id}`,
        href: `${entry.href}#${heading.id}`,
        title: heading.text,
        context: entry.title,
        snippet: "",
        score: 50,
      });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, MAX_HITS);
}

/** The docs search: a header button, Cmd/Ctrl+K, and a results dialog. */
export function DocsSearch({
  locale,
  dir,
  labels,
}: {
  locale: string;
  dir: "ltr" | "rtl";
  labels: { search: string; searchPlaceholder: string; searchEmpty: string; searchLoading: string; searchError: string };
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [entries, setEntries] = React.useState<SearchEntry[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [selected, setSelected] = React.useState(0);
  const listId = React.useId();

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  React.useEffect(() => {
    if (!open || entries) return;
    let live = true;
    setFailed(false);
    loadIndex(locale).then(
      (index) => live && setEntries(index),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [open, entries, locale]);

  const hits = React.useMemo(() => (entries ? search(entries, query) : []), [entries, query]);

  const go = (hit: SearchHit | undefined) => {
    if (!hit) return;
    setOpen(false);
    setQuery("");
    router.push(hit.href);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") setSelected((i) => Math.min(i + 1, hits.length - 1));
    else if (event.key === "ArrowUp") setSelected((i) => Math.max(i - 1, 0));
    else if (event.key === "Enter") go(hits[selected]);
    else return;
    event.preventDefault();
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger asChild>
        <button
          type="button"
          className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-2.5 text-sm text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground sm:w-56"
        >
          <MagnifyingGlass className="size-4 shrink-0" aria-hidden="true" />
          <span className="flex-1 text-start">{labels.search}</span>
          <Kbd className="hidden sm:inline-flex" dir="ltr">
            {"⌘K"}
          </Kbd>
        </button>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <DialogPrimitive.Content
          dir={dir}
          aria-describedby={undefined}
          className="fixed inset-x-3 top-[12vh] z-50 mx-auto max-w-xl overflow-hidden rounded-xl border border-border bg-background shadow-[var(--shadow-float)] outline-none"
        >
          <DialogPrimitive.Title className="sr-only">{labels.search}</DialogPrimitive.Title>
          <div className="flex items-center gap-2 border-b border-border px-3">
            <MagnifyingGlass className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              autoFocus
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelected(0);
              }}
              onKeyDown={onKeyDown}
              placeholder={labels.searchPlaceholder}
              aria-label={labels.searchPlaceholder}
              role="combobox"
              aria-expanded={hits.length > 0}
              aria-controls={listId}
              aria-activedescendant={hits[selected] ? `${listId}-${selected}` : undefined}
              className="h-12 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="max-h-[60vh] overflow-y-auto p-2">
            {failed ? (
              <p className="p-4 text-sm text-muted-foreground">{labels.searchError}</p>
            ) : !entries && query ? (
              <p className="p-4 text-sm text-muted-foreground">{labels.searchLoading}</p>
            ) : query && !hits.length ? (
              <p className="p-4 text-sm text-muted-foreground">{labels.searchEmpty}</p>
            ) : (
              <ul id={listId} role="listbox" aria-label={labels.search}>
                {hits.map((hit, i) => (
                  <li
                    key={hit.key}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === selected}
                    onMouseMove={() => setSelected(i)}
                    onClick={() => go(hit)}
                    className={cn(
                      "cursor-pointer rounded-lg px-3 py-2",
                      i === selected ? "bg-muted" : undefined,
                    )}
                  >
                    <div className="text-xs text-muted-foreground">{hit.context}</div>
                    <div className="text-sm font-medium text-foreground">{hit.title}</div>
                    {hit.snippet && (
                      <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{hit.snippet}</div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
