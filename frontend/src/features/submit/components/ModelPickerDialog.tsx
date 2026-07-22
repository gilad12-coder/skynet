"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/primitives/dialog";
import { ModelPicker } from "./ModelPicker";

/**
 * Model selection in a standalone dialog — the same separate-window picking
 * flow as the optimization wizard's model modal, minus the sampling
 * parameters, for surfaces that only need a model id (e.g. the tagger's
 * tagging model). Picking a model commits and closes.
 */
export function ModelPickerDialog({
  open,
  onOpenChange,
  value,
  onChange,
  title,
  description,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string;
  onChange: (next: string) => void;
  title: string;
  description?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(34rem,94vw)] max-w-[min(34rem,94vw)] sm:max-w-lg">
        <DialogHeader className="text-start">
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <ModelPicker
          variant="panel"
          value={value}
          onChange={(next) => {
            onChange(next);
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
