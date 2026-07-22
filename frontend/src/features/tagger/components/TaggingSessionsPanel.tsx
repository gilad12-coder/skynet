"use client";

import * as React from "react";
import { CircleAlert, Loader2, Plus, Search, Tags } from "lucide-react";
import { toast } from "react-toastify";

import {
  bulkDeleteTaggerSessions,
  listTaggerSessions,
  type TaggerSessionSummary,
} from "@/shared/lib/api";
import { formatMsg, msg } from "@/shared/lib/messages";
import { Button } from "@/shared/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/primitives/dialog";
import { EmptyState } from "@/shared/ui/empty-state";
import { SearchField } from "@/shared/ui/search-field";
import { SelectionBar } from "@/shared/ui/selection-bar";
import { TAGGER_SESSIONS_CHANGED } from "../hooks/use-tagger";
import { TaggingSessionCard } from "./TaggingSessionCard";

/**
 * Let the caller resume a saved labeling session or begin a new one.
 *
 * Fetches its own list and refreshes on {@link TAGGER_SESSIONS_CHANGED}, fired
 * whenever a session is renamed or deleted.
 */
export function TaggingSessionsPanel({ onStartNew }: { onStartNew: () => void }) {
  const [sessions, setSessions] = React.useState<TaggerSessionSummary[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = React.useState(false);
  const [bulkDeleting, setBulkDeleting] = React.useState(false);

  const fetchSessions = React.useCallback(async () => {
    try {
      const res = await listTaggerSessions({ limit: 200 });
      const items = res.items.filter((session) => session.phase !== "complete");
      setSessions(items);
      // Drop selections that no longer resolve to a listed session (deleted
      // elsewhere or completed since), so the bar never counts ghosts.
      setSelectedIds((prev) => {
        const next = new Set([...prev].filter((id) => items.some((s) => s.id === id)));
        return next.size === prev.size ? prev : next;
      });
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoaded(true);
    }
  }, []);

  const toggleSelected = React.useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const confirmBulkDelete = async () => {
    if (bulkDeleting) return;
    setBulkDeleting(true);
    try {
      const res = await bulkDeleteTaggerSessions([...selectedIds]);
      if (res.skipped.length > 0) {
        toast.warn(formatMsg("shared.selection.delete_skipped", { count: res.skipped.length }));
      }
      setBulkOpen(false);
      setSelectedIds(new Set());
      window.dispatchEvent(new Event(TAGGER_SESSIONS_CHANGED));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : msg("datasets.toast.delete_failed"));
    } finally {
      setBulkDeleting(false);
    }
  };

  React.useEffect(() => {
    void fetchSessions();
    const onChanged = () => void fetchSessions();
    window.addEventListener(TAGGER_SESSIONS_CHANGED, onChanged);
    return () => window.removeEventListener(TAGGER_SESSIONS_CHANGED, onChanged);
  }, [fetchSessions]);

  const filteredSessions = React.useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return sessions;
    return sessions.filter((session) => session.name.toLowerCase().includes(query));
  }, [search, sessions]);

  if (!loaded) {
    return (
      <section
        className="flex min-h-64 w-full items-center justify-center"
        aria-live="polite"
        aria-busy="true"
      >
        <div role="status">
          <Loader2 className="size-6 animate-spin text-primary" />
          <span className="sr-only">{msg("tagger.session.loading")}</span>
        </div>
      </section>
    );
  }

  if (loadFailed && sessions.length === 0) {
    return (
      <section className="w-full pb-16">
        <div className="mt-5 rounded-xl border border-dashed border-transparent" aria-live="polite">
          <EmptyState
            icon={CircleAlert}
            iconWrap="tile"
            title={msg("tagger.session.load_failed")}
            description={msg("tagger.session.load_failed_body")}
            action={{ label: msg("tagger.session.retry"), onClick: fetchSessions }}
          />
        </div>
      </section>
    );
  }

  if (sessions.length === 0) {
    return (
      <section className="w-full pb-16">
        <div className="mt-5 rounded-xl border border-dashed border-transparent">
          <EmptyState
            icon={Tags}
            iconWrap="tile"
            title={msg("tagger.session.empty_title")}
            description={msg("tagger.session.empty_body")}
            action={{ label: msg("tagger.session.start_new"), onClick: onStartNew }}
          />
        </div>
      </section>
    );
  }

  return (
    <section className="w-full pb-16">
      <div className="flex items-center gap-2.5">
        <SearchField
          value={search}
          onValueChange={setSearch}
          placeholder={msg("tagger.session.search_placeholder")}
          className="flex-1"
        />
        <Button variant="outline" onClick={onStartNew} className="h-11 shrink-0 rounded-2xl">
          <Plus className="size-4" aria-hidden="true" />
          {msg("tagger.session.start_new")}
        </Button>
      </div>

      <div className="mt-5 rounded-xl border border-dashed border-transparent">
        {filteredSessions.length === 0 ? (
          <EmptyState icon={Search} title={msg("tagger.session.search_empty")} />
        ) : (
          <div className="flex flex-col gap-2.5 p-0.5">
            {filteredSessions.map((session) => (
              <TaggingSessionCard
                key={session.id}
                session={session}
                onChanged={fetchSessions}
                selected={selectedIds.has(session.id)}
                onToggleSelect={() => toggleSelected(session.id)}
              />
            ))}
          </div>
        )}
      </div>

      <SelectionBar
        count={selectedIds.size}
        onClear={() => setSelectedIds(new Set())}
        onDelete={() => setBulkOpen(true)}
      />

      <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <DialogContent
          className="w-[min(28rem,92vw)] max-w-[min(28rem,92vw)] sm:max-w-md"
          showCloseButton={false}
        >
          <DialogHeader>
            <DialogTitle>{msg("tagger.session.bulk_delete_title")}</DialogTitle>
            <DialogDescription>
              {formatMsg("tagger.session.bulk_delete_body", { count: selectedIds.size })}{" "}
              {msg("delete.irreversible")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-2 gap-3">
            <Button
              variant="outline"
              onClick={() => setBulkOpen(false)}
              disabled={bulkDeleting}
              className="w-full justify-center"
            >
              {msg("datasets.delete.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={confirmBulkDelete}
              disabled={bulkDeleting}
              className="w-full justify-center shadow-xs"
            >
              {bulkDeleting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                msg("datasets.delete.confirm")
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
