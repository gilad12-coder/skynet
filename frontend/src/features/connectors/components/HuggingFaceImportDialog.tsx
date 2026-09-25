"use client";

import * as React from "react";
import { HuggingFace } from "@lobehub/icons";
import { toast } from "react-toastify";
import {
  ArrowLeft,
  ArrowSquareOut,
  CircleNotch,
  DownloadSimple,
  Lock,
  MagnifyingGlass,
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
import { useConnectors } from "../hooks/use-connectors";

/** Props for {@link HuggingFaceImportDialog}. */
export interface HuggingFaceImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the library record once the split has been saved (or deduplicated). */
  onImported: (dataset: DatasetSummary) => void;
}

const SEARCH_DEBOUNCE_MS = 300;
const PREVIEW_COLUMNS = 6;
const CELL_MAX_CHARS = 80;

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

/** Render one preview cell: images inline, everything else as clipped text. */
function PreviewCell({ value, isImage }: { value: unknown; isImage: boolean }) {
  if (value == null) return <span className="text-muted-foreground/50">—</span>;
  if (isImage && typeof value === "string" && value.startsWith("data:")) {
    return <img src={value} alt="" className="size-10 rounded object-cover" loading="lazy" />;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const clipped = text.length > CELL_MAX_CHARS ? `${text.slice(0, CELL_MAX_CHARS)}…` : text;
  return (
    <span
      className="line-clamp-2 break-words"
      title={text.length > CELL_MAX_CHARS ? text : undefined}
    >
      {clipped}
    </span>
  );
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
  const [name, setName] = React.useState("");
  const [importing, setImporting] = React.useState(false);

  const connected = huggingFace?.connected ?? false;
  const trimmedQuery = query.trim();
  const looksLikeRepo = /^[\w.-]+\/[\w.-]+$/.test(trimmedQuery);

  React.useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
      setSearchFailed(false);
      setRepoId(null);
      setSplits([]);
      setSplitKey("");
      setPreview(null);
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

  const imageColumns = React.useMemo(
    () => new Set((preview?.columns ?? []).filter((c) => /image/i.test(c.type)).map((c) => c.name)),
    [preview],
  );
  const visibleColumns = preview?.columns.slice(0, PREVIEW_COLUMNS) ?? [];
  const hiddenColumnCount = Math.max(0, (preview?.columns.length ?? 0) - PREVIEW_COLUMNS);
  const rowTotal = selectedSplit?.num_rows ?? preview?.num_rows_total ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(40rem,94vw)] max-w-[min(40rem,94vw)] gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="px-5 pt-5 text-start">
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
              className="inline-flex cursor-pointer items-center gap-0.5 font-medium underline-offset-2 hover:underline"
            >
              {msg("hf_import.connect_link")}
              <ArrowSquareOut className="size-3" />
            </button>
          </div>
        )}

        {repoId === null ? (
          <div className="px-5 pb-5 pt-4">
            <div className="relative">
              <Input
                dir="ltr"
                autoFocus
                placeholder={msg("hf_import.search_placeholder")}
                aria-label={msg("hf_import.search_placeholder")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && looksLikeRepo) setRepoId(trimmedQuery);
                }}
                className="h-[44px] pe-9 sm:h-9 [@media(hover:none)_and_(pointer:coarse)]:h-[44px]"
              />
              <span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                {searching ? (
                  <CircleNotch className="size-4 animate-spin" />
                ) : (
                  <MagnifyingGlass className="size-4" />
                )}
              </span>
            </div>

            <div className="mt-3 max-h-[min(24rem,55vh)] space-y-1.5 overflow-y-auto">
              {looksLikeRepo && !results.some((d) => d.id === trimmedQuery) && (
                <button
                  type="button"
                  onClick={() => setRepoId(trimmedQuery)}
                  className="group flex w-full cursor-pointer items-center gap-3 rounded-lg border border-dashed border-[#C8B9A8]/70 px-3 py-2.5 text-start transition-colors hover:bg-[#F8F4EF]"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#3D2E22]/8 text-[#3D2E22]">
                    <ArrowSquareOut className="size-4" />
                  </span>
                  <span dir="ltr" className="min-w-0 flex-1 truncate text-sm font-medium">
                    {formatMsg("hf_import.open_repo", { repo: trimmedQuery })}
                  </span>
                </button>
              )}
              {searchFailed ? (
                <p className="px-1 py-6 text-center text-sm text-muted-foreground">
                  {msg("hf_import.search_error")}
                </p>
              ) : !searching && results.length === 0 && !looksLikeRepo ? (
                <p className="px-1 py-6 text-center text-sm text-muted-foreground">
                  {msg("hf_import.search_empty")}
                </p>
              ) : (
                results.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => setRepoId(d.id)}
                    className="group flex w-full cursor-pointer items-center gap-3 rounded-lg border border-[#DDD4C8]/60 bg-gradient-to-b from-white/95 to-[#F8F4EF] px-3 py-2.5 text-start transition-colors hover:border-[#C8B9A8]/70"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#3D2E22]/8 text-[#3D2E22]">
                      {d.gated || d.private ? (
                        <Lock className="size-4" />
                      ) : (
                        <HuggingFace.Color size={16} />
                      )}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span dir="ltr" className="truncate text-sm font-medium text-foreground">
                        {d.id}
                      </span>
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.6875rem] text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <DownloadSimple className="size-3" />
                          {formatMsg("hf_import.downloads", { count: formatCount(d.downloads) })}
                        </span>
                        {d.gated && (
                          <span className="rounded-full bg-[#C8A882]/15 px-1.5 py-px font-medium text-[#8a6d44]">
                            {msg("hf_import.gated")}
                          </span>
                        )}
                        {d.private && (
                          <span className="rounded-full bg-muted px-1.5 py-px font-medium text-muted-foreground">
                            {msg("hf_import.private")}
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                ))
              )}
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
                className="size-[44px] shrink-0 sm:size-8 [@media(hover:none)_and_(pointer:coarse)]:size-[44px]"
              >
                <ArrowLeft className="size-4 rtl:-scale-x-100" />
              </Button>
              <a
                href={`https://huggingface.co/datasets/${repoId}`}
                target="_blank"
                rel="noreferrer noopener"
                dir="ltr"
                className="inline-flex min-w-0 items-center gap-1 truncate text-sm font-medium text-foreground underline-offset-2 hover:underline"
              >
                <span className="truncate">{repoId}</span>
                <ArrowSquareOut className="size-3.5 shrink-0 text-muted-foreground" />
              </a>
            </div>

            {splitsLoading ? (
              <div className="flex items-center justify-center py-10">
                <CircleNotch className="size-5 animate-spin text-primary" />
              </div>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="hf-split" className="text-xs">
                      {msg("hf_import.split_label")}
                    </Label>
                    <Select value={splitKey} onValueChange={setSplitKey}>
                      <SelectTrigger
                        id="hf-split"
                        dir="ltr"
                        className="h-[44px] w-full sm:h-9 [@media(hover:none)_and_(pointer:coarse)]:h-[44px]"
                      >
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
                      className="h-[44px] sm:h-9 [@media(hover:none)_and_(pointer:coarse)]:h-[44px]"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-foreground">
                      {msg("hf_import.preview_title")}
                    </span>
                    {rowTotal != null && (
                      <span className="text-[0.6875rem] text-muted-foreground tabular-nums">
                        {formatMsg("hf_import.rows_total", { count: rowTotal.toLocaleString() })}
                      </span>
                    )}
                  </div>
                  <div
                    dir="ltr"
                    className={cn(
                      "max-h-[min(16rem,40vh)] overflow-auto rounded-lg border border-border/50",
                      previewLoading && "opacity-60",
                    )}
                  >
                    {previewLoading && !preview ? (
                      <div className="flex items-center justify-center py-8">
                        <CircleNotch className="size-4 animate-spin text-primary" />
                      </div>
                    ) : !preview || preview.rows.length === 0 ? (
                      <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                        {msg("hf_import.preview_empty")}
                      </p>
                    ) : (
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-[#F8F4EF] text-start">
                          <tr>
                            {visibleColumns.map((c) => (
                              <th
                                key={c.name}
                                className="whitespace-nowrap px-2.5 py-1.5 text-start font-medium text-muted-foreground"
                                title={c.type}
                              >
                                {c.name}
                              </th>
                            ))}
                            {hiddenColumnCount > 0 && (
                              <th className="whitespace-nowrap px-2.5 py-1.5 text-start font-normal text-muted-foreground/70">
                                {formatMsg("hf_import.more_columns", { count: hiddenColumnCount })}
                              </th>
                            )}
                          </tr>
                        </thead>
                        <tbody>
                          {preview.rows.map((row, i) => (
                            <tr key={i} className="border-t border-border/40 align-top">
                              {visibleColumns.map((c) => (
                                <td key={c.name} className="max-w-[16rem] px-2.5 py-1.5">
                                  <PreviewCell
                                    value={row[c.name]}
                                    isImage={imageColumns.has(c.name)}
                                  />
                                </td>
                              ))}
                              {hiddenColumnCount > 0 && <td />}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>

                <DialogFooter className="gap-2 sm:gap-2">
                  <Button
                    variant="outline"
                    onClick={() => onOpenChange(false)}
                    className="min-h-[44px] sm:min-h-0 [@media(hover:none)_and_(pointer:coarse)]:min-h-[44px]"
                  >
                    {msg("hf_import.cancel")}
                  </Button>
                  <Button
                    onClick={handleImport}
                    disabled={!selectedSplit || importing}
                    className="min-h-[44px] sm:min-h-0 [@media(hover:none)_and_(pointer:coarse)]:min-h-[44px]"
                  >
                    {importing ? (
                      <CircleNotch className="size-4 animate-spin" />
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
