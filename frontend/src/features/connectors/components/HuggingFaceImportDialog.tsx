"use client";

import { EmptyState } from "@/shared/ui/empty-state";
import { LoadingState } from "@/shared/ui/loading-state";
import { Badge } from "@/shared/ui/primitives/badge";
import * as React from "react";
import { HuggingFace } from "@lobehub/icons";
import { toast } from "react-toastify";
import {
  ArrowLeft,
  ArrowSquareOut,
  ArrowUpRight,
  CaretRight,
  CircleNotch,
  DownloadSimple,
  Lock,
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
import { Input } from "@/shared/ui/primitives/input";
import { Label } from "@/shared/ui/primitives/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/primitives/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/primitives/tooltip";
import {
  getHuggingFaceSplits,
  importHuggingFaceDataset,
  isStorageQuotaError,
  previewHuggingFaceSplit,
  searchHuggingFaceDatasets,
  type DatasetSummary,
  type HubDataset,
  type HubPreview,
  type HubSplit,
} from "@/shared/lib/api";
import { formatMsg, msg } from "@/shared/lib/messages";
import { cn } from "@/shared/lib/utils";
import { useSettingsModal } from "@/features/settings";
import { DatasetPreviewPanel } from "@/features/datasets";
import { useConnectors } from "../hooks/use-connectors";
import { BROWSE_CARET_CLASS, BROWSE_LIST_CLASS, BROWSE_ROW_CLASS } from "./browse-list";
import { SearchInput } from "@/shared/ui/search-input";
import { TOUCH_FIELD } from "@/shared/ui/touch";

/** Props for {@link HuggingFaceImportDialog}. */
export interface HuggingFaceImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the library record once the split has been saved (or deduplicated). */
  onImported: (dataset: DatasetSummary) => void;
}

const SEARCH_DEBOUNCE_MS = 300;

/** Turn a Hub repo id into a URL path, escaping each segment separately so the slash survives. */
function encodeRepoId(repoId: string) {
  return repoId.split("/").map(encodeURIComponent).join("/");
}

/** Compact "12.3k" style formatting for download counts. */
function formatCount(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}
/**
 * Two-step picker: search the Hugging Face Hub, then choose a split, glance at
 * the first rows, name it and import. Search works anonymously; the second
 * step uses the caller's linked account so gated and private datasets resolve
 * when they are entitled to them.
 */
export function HuggingFaceImportDialog({
  open,
  onOpenChange,
  onImported,
}: HuggingFaceImportDialogProps) {
  const { huggingFace, loading: connectorsLoading } = useConnectors(open);
  const settingsModal = useSettingsModal();

  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<HubDataset[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [searchFailed, setSearchFailed] = React.useState(false);

  const [repoId, setRepoId] = React.useState<string | null>(null);
  const [splits, setSplits] = React.useState<HubSplit[]>([]);
  const [splitsLoading, setSplitsLoading] = React.useState(false);
  const [splitKey, setSplitKey] = React.useState<string>("");
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

  const connected = huggingFace?.connected ?? false;
  const trimmedQuery = query.trim();
  const looksLikeRepo = /^[\w.-]+\/[\w.-]+$/.test(trimmedQuery);
  const showOpenRepo = looksLikeRepo && !results.some((d) => d.id === trimmedQuery);

  React.useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
      setSearchFailed(false);
      setRepoId(null);
      setSplits([]);
      setSplitKey("");
      setPreview(null);
      setPreviewExpanded(false);
      setName("");
      setImporting(false);
    }
  }, [open]);

  React.useEffect(() => {
    if (!open || repoId) return;
    let cancelled = false;
    setSearching(true);
    setSearchFailed(false);
    const handle = window.setTimeout(() => {
      searchHuggingFaceDatasets(trimmedQuery)
        .then((res) => {
          if (!cancelled) setResults(res.datasets);
        })
        .catch(() => {
          if (!cancelled) setSearchFailed(true);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [open, repoId, trimmedQuery]);

  const selectedSplit = React.useMemo(
    () => splits.find((s) => `${s.config}\u0000${s.split}` === splitKey) ?? null,
    [splits, splitKey],
  );

  React.useEffect(() => {
    if (!repoId) return;
    let cancelled = false;
    setSplitsLoading(true);
    setSplits([]);
    setSplitKey("");
    setPreview(null);
    setPreviewExpanded(false);
    getHuggingFaceSplits(encodeRepoId(repoId))
      .then((res) => {
        if (cancelled) return;
        setSplits(res.splits);
        const preferred =
          res.splits.find((s) => s.split === "train") ??
          res.splits.find((s) => s.split === "test") ??
          res.splits[0];
        if (preferred) setSplitKey(`${preferred.config}\u0000${preferred.split}`);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        toast.error(err instanceof Error ? err.message : msg("hf_import.splits_error"));
        setRepoId(null);
      })
      .finally(() => {
        if (!cancelled) setSplitsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId]);

  React.useEffect(() => {
    if (!repoId || !selectedSplit) return;
    let cancelled = false;
    setPreviewLoading(true);
    setName(`${repoId} · ${selectedSplit.split}`);
    previewHuggingFaceSplit(encodeRepoId(repoId), selectedSplit.config, selectedSplit.split)
      .then((res) => {
        if (!cancelled) setPreview(res);
      })
      .catch(() => {
        if (!cancelled) setPreview({ columns: [], rows: [], num_rows_total: null });
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId, selectedSplit]);

  const handleImport = async () => {
    if (!repoId || !selectedSplit || importing) return;
    setImporting(true);
    try {
      const res = await importHuggingFaceDataset({
        repo_id: repoId,
        config: selectedSplit.config,
        split: selectedSplit.split,
        name: name.trim() || undefined,
      });
      toast.success(
        res.deduplicated ? msg("hf_import.toast.deduplicated") : msg("hf_import.toast.imported"),
      );
      onImported(res.dataset);
      onOpenChange(false);
    } catch (err) {
      if (!isStorageQuotaError(err)) {
        toast.error(err instanceof Error ? err.message : msg("hf_import.toast.failed"));
      }
    } finally {
      setImporting(false);
    }
  };

  const openConnectors = () => {
    onOpenChange(false);
    settingsModal.openTo("connectors");
  };

  const rowTotal = selectedSplit?.num_rows ?? preview?.num_rows_total ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "gap-0 overflow-y-auto p-0 transition-[max-width,width] duration-200 ease-out motion-reduce:transition-none",
          // Same footprint as the dataset detail dialog so the two read as one family.
          previewExpanded
            ? "max-h-[85vh] w-[96vw] max-w-[96vw] sm:max-w-[96vw]"
            : "max-h-[85vh] w-[min(72rem,94vw)] max-w-[min(72rem,94vw)] sm:max-w-[min(72rem,94vw)]",
        )}
      >
        <DialogHeader className="px-5 pt-5">
          <div className="flex items-center gap-2.5">
            <HuggingFace.Avatar size={28} />
            <div className="min-w-0">
              <DialogTitle className="text-base">{msg("hf_import.title")}</DialogTitle>
              <DialogDescription className="mt-0.5 text-xs">
                {msg("hf_import.subtitle")}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {!connectorsLoading && !connected && (
          <div className="mx-5 mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#C8A882]/40 bg-[#C8A882]/10 px-3 py-2 text-xs text-[#6b5232]">
            <span className="flex items-center gap-1.5">
              <Plug className="size-3.5 shrink-0" />
              {msg("hf_import.anonymous")}
            </span>
            <button
              type="button"
              onClick={openConnectors}
              className="inline-flex cursor-pointer items-center gap-0.5 rounded-sm font-medium text-[#8A6D44] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8A882]/45"
            >
              {msg("hf_import.connect_link")}
              <ArrowSquareOut className="size-3" />
            </button>
          </div>
        )}

        {repoId === null ? (
          <div className="px-5 pb-5 pt-4">
            <SearchInput
              dir="ltr"
              autoFocus
              placeholder={msg("hf_import.search_placeholder")}
              aria-label={msg("hf_import.search_placeholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && looksLikeRepo) setRepoId(trimmedQuery);
              }}
              busy={searching}
            />

            <div className="mt-3 max-h-[min(36rem,60vh)] overflow-y-auto">
              {searchFailed ? (
                <p className="px-1 py-6 text-center text-sm text-muted-foreground">
                  {msg("hf_import.search_error")}
                </p>
              ) : !searching && results.length === 0 && !showOpenRepo ? (
                <EmptyState variant="list" title={msg("hf_import.search_empty")} />
              ) : results.length > 0 || showOpenRepo ? (
                <ul className={BROWSE_LIST_CLASS}>
                  {showOpenRepo && (
                    <li>
                      <button
                        type="button"
                        onClick={() => setRepoId(trimmedQuery)}
                        className={BROWSE_ROW_CLASS}
                      >
                        <span
                          dir="ltr"
                          className="min-w-0 flex-1 truncate text-sm font-medium text-primary"
                        >
                          {formatMsg("hf_import.open_repo", { repo: trimmedQuery })}
                        </span>
                        <CaretRight className={BROWSE_CARET_CLASS} aria-hidden="true" />
                      </button>
                    </li>
                  )}
                  {results.map((d) => {
                    const slash = d.id.indexOf("/");
                    const owner = slash > 0 ? d.id.slice(0, slash + 1) : "";
                    const repoName = d.id.slice(owner.length);
                    return (
                      <li key={d.id}>
                        <button
                          type="button"
                          onClick={() => setRepoId(d.id)}
                          className={BROWSE_ROW_CLASS}
                        >
                          <span
                            dir="ltr"
                            className="flex min-w-0 flex-1 items-center gap-2 text-sm"
                          >
                            <span className="truncate">
                              <span className="text-muted-foreground">{owner}</span>
                              <span className="font-medium text-foreground">{repoName}</span>
                            </span>
                            {d.gated && (
                              <Badge variant="tint" size="sm">
                                <Lock aria-hidden="true" />
                                {msg("hf_import.gated")}
                              </Badge>
                            )}
                            {d.private && (
                              <Badge variant="secondary" size="sm">
                                <Lock aria-hidden="true" />
                                {msg("hf_import.private")}
                              </Badge>
                            )}
                          </span>
                          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums">
                            <DownloadSimple className="size-3.5" aria-hidden="true" />
                            {formatMsg("hf_import.downloads", { count: formatCount(d.downloads) })}
                          </span>
                          <CaretRight className={BROWSE_CARET_CLASS} aria-hidden="true" />
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
                onClick={() => setRepoId(null)}
                aria-label={msg("hf_import.back")}
                className="shrink-0"
              >
                <ArrowLeft className="size-4 rtl:rotate-180" />
              </Button>
              <span
                dir="ltr"
                className="min-w-0 flex-1 truncate text-start text-sm font-medium text-foreground"
              >
                {repoId}
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    asChild
                    variant="ghost"
                    size="icon-sm"
                    aria-label={msg("hf_import.view_on_hub")}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <a
                      href={`https://huggingface.co/datasets/${repoId}`}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      <ArrowUpRight className="size-4" />
                    </a>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{msg("hf_import.view_on_hub")}</TooltipContent>
              </Tooltip>
            </div>

            {splitsLoading ? (
              <LoadingState />
            ) : (
              <>
                <div className="grid gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="hf-split" className="text-xs">
                      {msg("hf_import.split_label")}
                    </Label>
                    <Select value={splitKey} onValueChange={setSplitKey}>
                      <SelectTrigger id="hf-split" dir="ltr" className={cn(TOUCH_FIELD, "w-full")}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {splits.map((s) => (
                          <SelectItem
                            key={`${s.config}\u0000${s.split}`}
                            value={`${s.config}\u0000${s.split}`}
                          >
                            <span dir="ltr" className="flex items-center gap-2">
                              {formatMsg("hf_import.split_option", {
                                config: s.config,
                                split: s.split,
                              })}
                              {s.num_rows != null && (
                                <span className="text-[0.6875rem] text-muted-foreground tabular-nums">
                                  {formatMsg("hf_import.rows_total", {
                                    count: s.num_rows.toLocaleString(),
                                  })}
                                </span>
                              )}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="hf-name" className="text-xs">
                      {msg("hf_import.name_label")}
                    </Label>
                    <Input
                      id="hf-name"
                      dir="ltr"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className={TOUCH_FIELD}
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-xs font-medium text-foreground">
                      {previewRows?.rows.length ? msg("datasets.detail.row_reader.hint") : null}
                    </span>
                    {rowTotal != null && (
                      <span className="shrink-0 whitespace-nowrap text-[0.6875rem] text-muted-foreground tabular-nums">
                        {formatMsg("hf_import.rows_total", { count: rowTotal.toLocaleString() })}
                      </span>
                    )}
                  </div>
                  <DatasetPreviewPanel
                    rows={previewRows}
                    emptyTitle={msg("hf_import.preview_empty")}
                    expanded={previewExpanded}
                    onExpandedChange={setPreviewExpanded}
                    className="h-80"
                    expandedClassName="h-80"
                  />
                </div>

                <DialogFooter>
                  <Button variant="outline" onClick={() => onOpenChange(false)}>
                    {msg("hf_import.cancel")}
                  </Button>
                  <Button onClick={handleImport} disabled={!selectedSplit || importing}>
                    {importing ? (
                      <CircleNotch
                        className="animate-spin motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                    ) : (
                      <DownloadSimple className="size-4" />
                    )}
                    {importing ? msg("hf_import.importing") : msg("hf_import.import")}
                  </Button>
                </DialogFooter>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
