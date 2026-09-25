"use client";

import * as React from "react";
import { CaretDown, DownloadSimple } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/primitives/dropdown-menu";
import type { ConnectorProvider, DatasetSummary } from "@/shared/lib/api";
import { msg } from "@/shared/lib/messages";
import { ConnectorImportDialog } from "./ConnectorImportDialog";
import { HuggingFaceImportDialog } from "./HuggingFaceImportDialog";
import { ALL_PROVIDERS, providerMeta } from "./providers";

/** Props for {@link ImportFromMenu}. */
export interface ImportFromMenuProps {
  /** Called with the library record once an import finished, whichever provider served it. */
  onImported: (dataset: DatasetSummary, provider: ConnectorProvider) => void;
  variant?: React.ComponentProps<typeof Button>["variant"];
  size?: "default" | "sm" | "lg" | "xs";
  className?: string;
  "data-telemetry"?: string;
}

/**
 * "Import from…" button that fans out to every connector. It owns the two
 * dialogs (the Hugging Face picker and the generic browser), so a call site
 * only has to say what to do with the imported dataset.
 */
export function ImportFromMenu({
  onImported,
  variant = "outline",
  size,
  className,
  "data-telemetry": telemetry,
}: ImportFromMenuProps) {
  const [active, setActive] = React.useState<ConnectorProvider | null>(null);
  // Kept across closes so the generic dialog keeps its provider while it animates out.
  const [browseProvider, setBrowseProvider] = React.useState<ConnectorProvider>("github");

  const choose = (provider: ConnectorProvider) => {
    if (provider !== "huggingface") setBrowseProvider(provider);
    setActive(provider);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant={variant} size={size} className={className} data-telemetry={telemetry}>
            <DownloadSimple className="size-4" />
            {msg("connector_import.button")}
            <CaretDown className="size-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[14rem]">
          {ALL_PROVIDERS.map((id) => {
            const meta = providerMeta(id);
            return (
              <DropdownMenuItem key={id} onSelect={() => choose(id)} className="gap-2.5">
                <span className="flex size-5 shrink-0 items-center justify-center">
                  <meta.Mark size={16} />
                </span>
                {meta.name}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      <HuggingFaceImportDialog
        open={active === "huggingface"}
        onOpenChange={(open) => {
          if (!open) setActive(null);
        }}
        onImported={(dataset) => onImported(dataset, "huggingface")}
      />
      <ConnectorImportDialog
        provider={browseProvider}
        open={active !== null && active !== "huggingface"}
        onOpenChange={(open) => {
          if (!open) setActive(null);
        }}
        onImported={(dataset) => onImported(dataset, browseProvider)}
      />
    </>
  );
}
