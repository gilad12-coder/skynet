"use client";

import { EmptyState } from "@/shared/ui/empty-state";
import { LoadingState } from "@/shared/ui/loading-state";
import * as React from "react";
import { toast } from "react-toastify";
import {
  ArrowLeft,
  ArrowSquareOut,
  CaretRight,
  CircleNotch,
  DotsThree,
  DownloadSimple,
  FileText,
  Folder,
  Plug,
} from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/primitives/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/primitives/dropdown-menu";
import { Input } from "@/shared/ui/primitives/input";
import { Label } from "@/shared/ui/primitives/label";
import {
  browseConnector,
  importConnectorRef,
  isStorageQuotaError,
  previewConnectorRef,
  type ConnectorEntry,
  type ConnectorProvider,
  type DatasetSummary,
  type HubPreview,
} from "@/shared/lib/api";
import { formatMsg, msg } from "@/shared/lib/messages";
import { cn } from "@/shared/lib/utils";
import { useSettingsModal } from "@/features/settings";
import { DatasetPreviewPanel } from "@/features/datasets";
import { useConnectors } from "../hooks/use-connectors";
import { BROWSE_CARET_CLASS, BROWSE_LIST_CLASS, BROWSE_ROW_CLASS } from "./browse-list";
import { providerMeta } from "./providers";
import { SearchInput } from "@/shared/ui/search-input";
import { TOUCH_FIELD } from "@/shared/ui/touch";
import { TooltipButton } from "@/shared/ui/tooltip-button";

/** Props for {@link ConnectorImportDialog}. */
export interface ConnectorImportDialogProps {
  provider: ConnectorProvider;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the library record once the file has been saved (or deduplicated). */
  onImported: (dataset: DatasetSummary) => void;
}

const SEARCH_DEBOUNCE_MS = 300;
const TOUCH_BUTTON =
  "min-h-[44px] sm:min-h-0 [@media(hover:none)_and_(pointer:coarse)]:min-h-[44px]";

// Deeper paths keep the root and the last two folders visible and fold the
// middle into a menu, so the trail stays on one line.
const MAX_VISIBLE_CRUMBS = 3;
const CRUMB_CLASS =
  "max-w-[12rem] cursor-pointer truncate rounded-md px-1.5 py-1 hover:bg-accent hover:text-foreground";
const CURRENT_CRUMB_CLASS = "cursor-default font-medium text-foreground hover:bg-transparent";

interface Crumb {
  ref: string;
  name: string;
}

/** "1.2 MB" style formatting for object sizes. */
function formatBytes(n: number) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** Providers whose ``size`` is a row count (sheet tabs, tables, examples) rather than bytes. */
const ROW_COUNT_PROVIDERS = new Set<ConnectorProvider>(["google_sheets", "langsmith", "snowflake"]);

/** Secondary text of a listing row: size for objects, row count for tables. */
function entryDetail(provider: ConnectorProvider, entry: ConnectorEntry) {
  if (entry.kind === "file" && entry.size != null) {
    return ROW_COUNT_PROVIDERS.has(provider)
      ? formatMsg("connector_import.size_rows", { count: entry.size.toLocaleString() })
      : formatBytes(entry.size);
  }
  if (entry.modified) {
    const date = new Date(entry.modified);
    if (!Number.isNaN(date.getTime())) return date.toLocaleDateString();
  }
  return null;
}

/**
 * Two-step picker for the browse-style connectors: walk the account's
 * buckets, repositories or spreadsheets down to one file, then glance at its
 * first rows, name it and import it. Everything goes through the caller's
 * linked account, so the dialog asks for one when none is linked yet.
 */
export function ConnectorImportDialog({
  provider,
  open,
  onOpenChange,
  onImported,
}: ConnectorImportDialogProps) {
  const meta = providerMeta(provider);
  const { byProvider, loading: connectorsLoading } = useConnectors(open);
  const settingsModal = useSettingsModal();
  const connected = byProvider(provider)?.connected ?? false;

  const [path, setPath] = React.useState<Crumb[]>([]);
  const [entries, setEntries] = React.useState<ConnectorEntry[]>([]);
  const [browsing, setBrowsing] = React.useState(false);
  const [browseFailed, setBrowseFailed] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [attempt, setAttempt] = React.useState(0);

  const [selected, setSelected] = React.useState<ConnectorEntry | null>(null);
  const [preview, setPreview] = React.useState<HubPreview | null>(null);
  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [previewExpanded, setPreviewExpanded] = React.useState(false);
  const previewRows = React.useMemo(
    () =>
      previewLoading
        ? null
        : { columns: preview?.columns.map((c) => c.name) ?? [], rows: preview?.rows ?? [] },
    [preview, previewLoading],
  );
  const [name, setName] = React.useState("");
  const [importing, setImporting] = React.useState(false);

  const location = path.at(-1)?.ref ?? "";
  const trimmedQuery = query.trim();

  React.useEffect(() => {
    if (!open) {
      setPath([]);
      setEntries([]);
      setBrowseFailed(false);
      setQuery("");
      setSelected(null);
      setPreview(null);
      setPreviewExpanded(false);
      setName("");
      setImporting(false);
    }
  }, [open]);

  // Only the root listing is searched server-side; inside a folder the
  // listing is small enough to filter locally, so the query is not resent.
  React.useEffect(() => {
    if (!open || !connected || selected) return;
    let cancelled = false;
    setBrowsing(true);
    setBrowseFailed(false);
    const delay = location ? 0 : SEARCH_DEBOUNCE_MS;
    const handle = window.setTimeout(() => {
      browseConnector(provider, location, location ? "" : trimmedQuery)
        .then((res) => {
          if (!cancelled) setEntries(res.entries);
        })
        .catch(() => {
          if (!cancelled) setBrowseFailed(true);
        })
        .finally(() => {
          if (!cancelled) setBrowsing(false);
        });
    }, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [open, connected, selected, provider, location, trimmedQuery, attempt]);

  React.useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setPreviewLoading(true);
    setPreview(null);
    setPreviewExpanded(false);
    setName(selected.name);
    previewConnectorRef(provider, selected.ref)
      .then((res) => {
        if (!cancelled) setPreview(res);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        toast.error(err instanceof Error ? err.message : msg("connector_import.browse_error"));
        setPreview({ columns: [], rows: [], num_rows_total: null });
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [provider, selected]);

  const visibleEntries = React.useMemo(() => {
    const needle = trimmedQuery.toLowerCase();
    const matches =
      needle && location ? entries.filter((e) => e.name.toLowerCase().includes(needle)) : entries;
    // Folders first, keeping the provider's own order within each group.
    return [...matches].sort((a, b) => Number(b.kind === "folder") - Number(a.kind === "folder"));
  }, [entries, location, trimmedQuery]);

  const openEntry = (entry: ConnectorEntry) => {
    if (entry.kind === "folder") {
      setPath((prev) => [...prev, { ref: entry.ref, name: entry.name }]);
      setQuery("");
      setEntries([]);
    } else {
      setSelected(entry);
    }
  };

  const jumpTo = (index: number) => {
    setPath((prev) => prev.slice(0, index));
    setQuery("");
    setEntries([]);
  };

  const goUp = () => {
    if (path.length > 0) jumpTo(path.length - 1);
  };

  const collapsed = path.length > MAX_VISIBLE_CRUMBS;
  const hiddenCrumbs = collapsed ? path.slice(0, -2) : [];
  const shownCrumbs = collapsed ? path.slice(-2) : path;
  const shownOffset = path.length - shownCrumbs.length;

  const handleImport = async () => {
    if (!selected || importing) return;
    setImporting(true);
    try {
      const res = await importConnectorRef(provider, selected.ref, name.trim() || undefined);
      toast.success(
        res.deduplicated
          ? msg("connector_import.toast.deduplicated")
          : msg("connector_import.toast.imported"),
      );
      onImported(res.dataset);
      onOpenChange(false);
    } catch (err) {
      if (!isStorageQuotaError(err)) {
        toast.error(err instanceof Error ? err.message : msg("connector_import.toast.failed"));
      }
    } finally {
      setImporting(false);
    }
  };

  const openConnectors = () => {
    onOpenChange(false);
    settingsModal.openTo("connectors");
  };

  const rowTotal = preview?.num_rows_total ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "gap-0 overflow-y-auto p-0 transition-[max-width,width] duration-200 ease-out motion-reduce:transition-none",
          previewExpanded
            ? "max-h-[85vh] w-[96vw] max-w-[96vw] sm:max-w-[96vw]"
            : "max-h-[85vh] w-[min(72rem,94vw)] max-w-[min(72rem,94vw)] sm:max-w-[min(72rem,94vw)]",
        )}
      >
        <DialogHeader className="px-5 pt-5">
          <div className="flex items-center gap-2.5">
            <meta.Avatar size={28} />
            <div className="min-w-0">
              <DialogTitle className="text-base">
                {formatMsg("connector_import.title", { provider: meta.name })}
              </DialogTitle>
              <DialogDescription className="mt-0.5 text-xs">
                {msg("connector_import.subtitle")}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {connectorsLoading ? (
          <LoadingState className="py-14" />
        ) : !connected ? (
          <div className="px-5 pb-5 pt-4">
            <div className="flex flex-col items-center gap-3 rounded-lg border border-[#C8A882]/40 bg-[#C8A882]/10 px-4 py-8 text-center text-sm text-[#6b5232]">
              <Plug className="size-5" />
              <p>{formatMsg("connector_import.not_connected", { provider: meta.name })}</p>
              <Button size="sm" onClick={openConnectors} className={TOUCH_BUTTON}>
                {formatMsg("connector_import.connect_link", { provider: meta.name })}
                <ArrowSquareOut className="size-3.5" />
              </Button>
            </div>
          </div>
        ) : selected === null ? (
          <div className="px-5 pb-5 pt-4">
            <div className="mb-3 flex min-w-0 items-center gap-1.5">
              <TooltipButton tooltip={msg("connector_import.up")}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={goUp}
                  disabled={path.length === 0}
                  aria-label={msg("connector_import.up")}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                >
                  <ArrowLeft className="size-4 rtl:-scale-x-100" />
                </Button>
              </TooltipButton>
              <nav
                aria-label={msg("connector_import.breadcrumb")}
                className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-xs text-muted-foreground"
              >
                <button
                  type="button"
                  onClick={() => jumpTo(0)}
                  disabled={path.length === 0}
                  aria-current={path.length === 0 ? "location" : undefined}
                  className={cn(CRUMB_CLASS, "shrink-0", path.length === 0 && CURRENT_CRUMB_CLASS)}
                >
                  {meta.name}
                </button>
                {collapsed && (
                  <>
                    <CaretRight className="size-3 shrink-0 rtl:-scale-x-100" />
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label={msg("connector_import.more_folders")}
                          className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-accent hover:text-foreground"
                        >
                          <DotsThree className="size-4" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="max-w-[18rem]">
                        {hiddenCrumbs.map((crumb, index) => (
                          <DropdownMenuItem
                            key={crumb.ref}
                            onSelect={() => jumpTo(index + 1)}
                            className="gap-2"
                          >
                            <Folder className="size-4 shrink-0 text-muted-foreground" />
                            <span dir="ltr" className="truncate">
                              {crumb.name}
                            </span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                )}
                {shownCrumbs.map((crumb, index) => {
                  const depth = shownOffset + index + 1;
                  const last = depth === path.length;
                  return (
                    <React.Fragment key={crumb.ref}>
                      <CaretRight className="size-3 shrink-0 rtl:-scale-x-100" />
                      <button
                        type="button"
                        dir="ltr"
                        onClick={() => jumpTo(depth)}
                        disabled={last}
                        aria-current={last ? "location" : undefined}
                        title={crumb.name}
                        className={cn(CRUMB_CLASS, "min-w-0", last && CURRENT_CRUMB_CLASS)}
                      >
                        {crumb.name}
                      </button>
                    </React.Fragment>
                  );
                })}
              </nav>
            </div>

            <SearchInput
              dir="ltr"
              autoFocus
              placeholder={msg("connector_import.search_placeholder")}
              aria-label={msg("connector_import.search_placeholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Backspace on an empty filter steps up a folder, like a file manager.
                if (e.key === "Backspace" && query === "" && path.length > 0) {
                  e.preventDefault();
                  goUp();
                }
              }}
              busy={browsing}
            />

            <div className="mt-3 max-h-[min(24rem,55vh)] overflow-y-auto">
              {browseFailed ? (
                <div className="flex flex-col items-center gap-2 px-1 py-6 text-center text-sm text-muted-foreground">
                  {msg("connector_import.browse_error")}
                  <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
                    {msg("connectors.retry")}
                  </Button>
                </div>
              ) : !browsing && visibleEntries.length === 0 ? (
                <EmptyState variant="list" title={msg("connector_import.empty")} />
              ) : visibleEntries.length > 0 ? (
                <ul className={BROWSE_LIST_CLASS}>
                  {visibleEntries.map((entry) => {
                    const detail = entryDetail(provider, entry);
                    const EntryIcon = entry.kind === "folder" ? Folder : FileText;
                    return (
                      <li key={entry.ref}>
                        <button
                          type="button"
                          onClick={() => openEntry(entry)}
                          className={BROWSE_ROW_CLASS}
                        >
                          <EntryIcon
                            className="size-4 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                          />
                          <span
                            dir="ltr"
                            className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
                          >
                            {entry.name}
                          </span>
                          {detail && (
                            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                              {detail}
                            </span>
                          )}
                          <CaretRight
                            className={cn(
                              BROWSE_CARET_CLASS,
                              entry.kind !== "folder" && "invisible",
                            )}
                            aria-hidden="true"
                          />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4 px-5 pb-5 pt-4">
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setSelected(null)}
                aria-label={msg("connector_import.back")}
                className="shrink-0 max-lg:size-[44px]"
              >
                <ArrowLeft className="size-4 rtl:rotate-180" />
              </Button>
              <span dir="ltr" className="min-w-0 truncate text-sm font-medium text-foreground">
                {selected.ref}
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="connector-import-name" className="text-xs">
                {msg("connector_import.name_label")}
              </Label>
              <Input
                id="connector-import-name"
                dir="ltr"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={TOUCH_FIELD}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-xs font-medium text-foreground">
                  {previewRows?.rows.length ? msg("datasets.detail.row_reader.hint") : null}
                </span>
                {rowTotal != null && (
                  <span className="shrink-0 whitespace-nowrap text-[0.6875rem] text-muted-foreground tabular-nums">
                    {formatMsg("connector_import.size_rows", { count: rowTotal.toLocaleString() })}
                  </span>
                )}
              </div>
              <DatasetPreviewPanel
                rows={previewRows}
                emptyTitle={msg("connector_import.preview_empty")}
                expanded={previewExpanded}
                onExpandedChange={setPreviewExpanded}
                className="h-80"
                expandedClassName="h-80"
              />
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {msg("connector_import.cancel")}
              </Button>
              <Button onClick={handleImport} disabled={importing}>
                {importing ? (
                  <CircleNotch
                    className="animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : (
                  <DownloadSimple className="size-4" />
                )}
                {importing ? msg("connector_import.importing") : msg("connector_import.import")}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
