import { AnimatePresence, motion } from "framer-motion";
import * as React from "react";
import { Copy, PushPin, PushPinSlash, Square, Trash, Users, X } from "@/shared/ui/icons";
import { TooltipButton } from "@/shared/ui/tooltip-button";
import { TERMS } from "@/shared/lib/terms";
import { msg } from "@/shared/lib/messages";
import { cn } from "@/shared/lib/utils";
import { ShareDialog } from "@/features/optimizations";

type BulkActionBarProps = {
  canDelete: boolean;
  canManageShare: boolean;
  canStop: boolean;
  canTogglePin: boolean;
  selectedJobId: string | null;
  selectedCount: number;
  willPin: boolean;
  actionPending: boolean;
  onClear: () => void;
  onClone: () => void;
  onStop: () => void;
  onTogglePin: () => void;
  onRequestBulkDelete: () => void;
};

function SelectionAction({
  label,
  onClick,
  disabled,
  destructive,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <TooltipButton tooltip={label} side="top" delayDuration={150}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cn(
          "flex size-[44px] cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-all active:scale-95 disabled:pointer-events-none disabled:opacity-50 lg:size-8",
          destructive
            ? "hover:bg-destructive/10 hover:text-destructive"
            : "hover:bg-accent hover:text-foreground",
        )}
        aria-label={label}
      >
        {children}
      </button>
    </TooltipButton>
  );
}

export function BulkActionBar({
  canDelete,
  canManageShare,
  canStop,
  canTogglePin,
  selectedJobId,
  selectedCount,
  willPin,
  actionPending,
  onClear,
  onClone,
  onStop,
  onTogglePin,
  onRequestBulkDelete,
}: BulkActionBarProps) {
  const [shareOpen, setShareOpen] = React.useState(false);

  return (
    <AnimatePresence>
      {selectedCount > 0 && (
        <motion.div
          initial={{ y: 24, opacity: 0, scale: 0.96 }}
          animate={{ y: 0, opacity: 1, scale: 1 }}
          exit={{ y: 24, opacity: 0, scale: 0.96 }}
          transition={{
            type: "spring",
            stiffness: 380,
            damping: 30,
            mass: 0.8,
          }}
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50"
          data-tutorial="bulk-action-bar"
        >
          <div className="flex max-w-[92vw] flex-wrap items-center justify-center gap-1 rounded-full border border-border/60 bg-background/95 backdrop-blur-xl px-3 py-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.18)]">
            <span className="min-w-0 px-1 text-sm text-foreground">
              {selectedCount === 1 ? (
                <>
                  {msg("auto.features.dashboard.components.bulkactionbar.1")}
                  {TERMS.optimization}
                  {msg("auto.features.dashboard.components.bulkactionbar.2")}
                </>
              ) : (
                <>
                  {msg("auto.features.dashboard.components.bulkactionbar.3")}
                  <span className="font-semibold tabular-nums">{selectedCount}</span>{" "}
                  {TERMS.optimizationPlural}
                </>
              )}
            </span>
            <div className="mx-1 h-5 w-px bg-border/60" />
            <TooltipButton
              tooltip={msg("auto.features.dashboard.components.bulkactionbar.4")}
              side="top"
              delayDuration={150}
            >
              <button
                type="button"
                onClick={onClear}
                className="close-button"
                style={
                  {
                    "--close-btn-size": "44px",
                    "--close-btn-radius": "9999px",
                    "--close-btn-icon": "16px",
                  } as React.CSSProperties
                }
                aria-label={msg("auto.features.dashboard.components.bulkactionbar.literal.1")}
              >
                <X />
              </button>
            </TooltipButton>
            {selectedJobId && (
              <>
                {canManageShare && (
                  <>
                    <SelectionAction label={msg("share.button")} onClick={() => setShareOpen(true)}>
                      <Users className="size-4" />
                    </SelectionAction>
                    <ShareDialog
                      key={selectedJobId}
                      optimizationId={selectedJobId}
                      open={shareOpen}
                      onOpenChange={setShareOpen}
                      hideTrigger
                    />
                  </>
                )}
                <SelectionAction label={msg("share.clone_tooltip")} onClick={onClone}>
                  <Copy className="size-4" />
                </SelectionAction>
              </>
            )}
            {canTogglePin && (
              <SelectionAction
                label={
                  willPin
                    ? msg("auto.features.sidebar.components.sidebar.literal.14")
                    : msg("auto.features.sidebar.components.sidebar.literal.13")
                }
                onClick={onTogglePin}
                disabled={actionPending}
              >
                {willPin ? <PushPin className="size-4" /> : <PushPinSlash className="size-4" />}
              </SelectionAction>
            )}
            {canStop && (
              <SelectionAction
                label={msg("auto.features.agent.panel.lib.tool.meta.literal.7")}
                onClick={onStop}
                disabled={actionPending}
              >
                <Square className="size-4" />
              </SelectionAction>
            )}
            {canDelete && (
              <SelectionAction
                label={msg("auto.features.dashboard.components.bulkactionbar.5")}
                onClick={onRequestBulkDelete}
                disabled={actionPending}
                destructive
              >
                <Trash className="size-4" />
              </SelectionAction>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
