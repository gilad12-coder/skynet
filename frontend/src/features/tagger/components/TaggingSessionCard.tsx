"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CircleNotch, PencilSimple, Tag, Trash } from "@/shared/ui/icons";
import { toast } from "react-toastify";

import { Badge } from "@/shared/ui/primitives/badge";
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
import { SelectCheckbox } from "@/shared/ui/select-checkbox";
import { TooltipButton } from "@/shared/ui/tooltip-button";
import {
  LIST_ROW_ACTION_DIVIDER_CLASS,
  LIST_ROW_ACTIONS_CLASS,
  LIST_ROW_CLASS,
  LIST_ROW_ICON_CLASS,
  LIST_ROW_META_CLASS,
  LIST_ROW_META_DOT_CLASS,
  LIST_ROW_SELECTED_CLASS,
  LIST_ROW_TITLE_CLASS,
} from "@/shared/ui/list-row";
import {
  deleteTaggerSession,
  renameTaggerSession,
  type TaggerSessionSummary,
} from "@/shared/lib/api";
import { formatMsg, msg, type MessageKey } from "@/shared/lib/messages";
import { formatRelativeTime } from "@/shared/lib/formatters";
import { cn } from "@/shared/lib/utils";
import { TAGGER_SESSIONS_CHANGED } from "../hooks/use-tagger";
import { TaggingSessionShareDialog } from "./TaggingSessionShareDialog";

const MODE_LABEL_KEYS: Record<string, MessageKey> = {
  manual: "tagger.assist.setup.manual_label",
  copilot: "tagger.assist.setup.copilot_label",
  autopilot: "tagger.assist.setup.autopilot_label",
};

/** Human status for a session card, derived from phase and progress. */
function sessionStatus(session: TaggerSessionSummary): string {
  if (session.phase === "interview") return msg("tagger.session.status.setup");
  if (session.phase === "calibration" || session.phase === "review") {
    return msg("tagger.session.status.review");
  }
  if (session.phase === "autotagging") return msg("tagger.session.status.autotagging");
  if (
    session.phase === "complete" ||
    (session.row_count > 0 && session.tagged_count >= session.row_count)
  ) {
    return msg("tagger.session.status.done");
  }
  return msg("tagger.session.status.in_progress");
}

/**
 * Render one saved text-labeling session in the Tagger session chooser.
 *
 * Clicking the card resumes at ``/tagger/[id]``; the trailing actions rename
 * or delete it. Mutations fire {@link TAGGER_SESSIONS_CHANGED} so any other
 * open list refreshes too.
 */
export function TaggingSessionCard({
  session,
  onChanged,
  selected,
  onToggleSelect,
}: {
  session: TaggerSessionSummary;
  onChanged: () => void;
  selected: boolean;
  /** ``shiftKey`` is true on shift-click, extending the panel's range anchor. */
  onToggleSelect: (shiftKey: boolean) => void;
}) {
  const router = useRouter();
  const isOwner = session.role === "owner";
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [renameValue, setRenameValue] = React.useState(session.name);
  const [renaming, setRenaming] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  const displayName = session.name?.trim() || msg("tagger.session.untitled");
  const modeKey = session.mode ? MODE_LABEL_KEYS[session.mode] : undefined;
  const modeLabel = modeKey ? msg(modeKey) : null;
  const progress =
    session.row_count > 0 ? Math.min(100, (session.tagged_count / session.row_count) * 100) : 0;
  const done = session.row_count > 0 && session.tagged_count >= session.row_count;

  const notifyChanged = () => {
    window.dispatchEvent(new Event(TAGGER_SESSIONS_CHANGED));
    onChanged();
  };

  const resume = () => router.push(`/tagger/${session.id}`);

  const handleRename = async () => {
    const name = renameValue.trim();
    if (!name || renaming) return;
    setRenaming(true);
    try {
      await renameTaggerSession(session.id, name);
      setRenameOpen(false);
      notifyChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : msg("datasets.toast.rename_failed"));
    } finally {
      setRenaming(false);
    }
  };

  const handleDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await deleteTaggerSession(session.id);
      setDeleteOpen(false);
      notifyChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : msg("datasets.toast.delete_failed"));
    } finally {
      setDeleting(false);
    }
  };

  // Trailing-action clicks must not also resume the session.
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={resume}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            resume();
          }
        }}
        aria-label={displayName}
        className={cn(LIST_ROW_CLASS, selected && LIST_ROW_SELECTED_CLASS)}
      >
        {/* Shared-in sessions can't be bulk-deleted, so their checkbox is an
            invisible placeholder that keeps the rows column-aligned. */}
        <span className={cn("flex shrink-0 items-center", !isOwner && "invisible")}>
          <SelectCheckbox
            checked={selected}
            onToggle={onToggleSelect}
            disabled={!isOwner}
            ariaLabel={formatMsg("shared.selection.select_named", { name: displayName })}
          />
        </span>
        <span className={LIST_ROW_ICON_CLASS}>
          <Tag className="size-4" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className={LIST_ROW_TITLE_CLASS} dir="auto">
              {displayName}
            </p>
            {!isOwner && (
              <Badge variant="secondary" size="sm">
                {msg("datasets.shared_badge")}
              </Badge>
            )}
          </div>
          <div className={LIST_ROW_META_CLASS}>
            <span className="shrink-0">{sessionStatus(session)}</span>
            {modeLabel && (
              <>
                <span aria-hidden className={LIST_ROW_META_DOT_CLASS}>
                  ·
                </span>
                <span className="shrink-0">{modeLabel}</span>
              </>
            )}
            {session.source_name && (
              <>
                <span aria-hidden className={LIST_ROW_META_DOT_CLASS}>
                  ·
                </span>
                <span className="min-w-0 truncate" dir="auto">
                  {session.source_name}
                </span>
              </>
            )}
            <span aria-hidden className={LIST_ROW_META_DOT_CLASS}>
              ·
            </span>
            <span className="shrink-0">{formatRelativeTime(session.updated_at)}</span>
          </div>
        </div>

        <div className="flex w-20 shrink-0 flex-col items-end gap-1.5">
          <span className="text-xs font-medium text-foreground tabular-nums">
            {session.tagged_count}
            <span className="text-muted-foreground">/{session.row_count}</span>
          </span>
          <span aria-hidden="true" className="h-1 w-full overflow-hidden rounded-full bg-muted">
            <span
              className={cn(
                "block h-full rounded-full transition-[width] duration-300 ease-out",
                done ? "bg-[var(--success)]" : "bg-primary/70",
              )}
              style={{ width: `${progress}%` }}
            />
          </span>
        </div>

        {isOwner && (
          <div className={LIST_ROW_ACTIONS_CLASS} onClick={stop}>
            <TaggingSessionShareDialog sessionId={session.id} />
            <TooltipButton tooltip={msg("datasets.action.rename")}>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-[44px] text-muted-foreground hover:text-foreground lg:size-8"
                onClick={() => {
                  setRenameValue(displayName);
                  setRenameOpen(true);
                }}
                aria-label={msg("datasets.action.rename")}
              >
                <PencilSimple className="size-4" />
              </Button>
            </TooltipButton>
            <span aria-hidden="true" className={LIST_ROW_ACTION_DIVIDER_CLASS} />
            <TooltipButton tooltip={msg("datasets.action.delete")}>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-[44px] text-muted-foreground hover:text-destructive lg:size-8"
                onClick={() => setDeleteOpen(true)}
                aria-label={msg("datasets.action.delete")}
              >
                <Trash className="size-4" />
              </Button>
            </TooltipButton>
          </div>
        )}
      </div>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="w-[min(28rem,92vw)] max-w-[min(28rem,92vw)] sm:max-w-md">
          <DialogHeader className="text-start">
            <DialogTitle>{msg("tagger.session.rename_title")}</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleRename();
              }
            }}
            aria-label={msg("datasets.rename.label")}
            autoFocus
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRenameOpen(false)}
              disabled={renaming}
              className="w-full justify-center"
            >
              {msg("datasets.rename.cancel")}
            </Button>
            <Button
              onClick={handleRename}
              disabled={renaming || renameValue.trim().length === 0}
              className="w-full justify-center shadow-xs"
            >
              {renaming ? (
                <CircleNotch className="size-4 animate-spin" />
              ) : (
                msg("datasets.rename.save")
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent
          className="w-[min(28rem,92vw)] max-w-[min(28rem,92vw)] sm:max-w-md"
          showCloseButton={false}
        >
          <DialogHeader>
            <DialogTitle>{msg("tagger.session.delete_title")}</DialogTitle>
            <DialogDescription>
              {msg("tagger.session.delete_body")}{" "}
              <span className="break-words font-semibold text-foreground" dir="auto">
                {displayName}
              </span>
              ? {msg("delete.irreversible")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-2 gap-3">
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={deleting}
              className="w-full justify-center"
            >
              {msg("datasets.delete.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
              className="w-full justify-center shadow-xs"
            >
              {deleting ? (
                <CircleNotch className="size-4 animate-spin" />
              ) : (
                msg("datasets.delete.confirm")
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
