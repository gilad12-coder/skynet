"use client";

import * as React from "react";
import { toast } from "react-toastify";
import { CaretDown, CircleNotch, Plus } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/primitives/dropdown-menu";
import { getConnectors, type ConnectorProvider } from "@/shared/lib/api";
import { formatMsg, msg } from "@/shared/lib/messages";
import { cn } from "@/shared/lib/utils";
import { useSettingsModal } from "@/features/settings";
import { useConnectors } from "../hooks/use-connectors";
import { ConnectorImportDialog } from "./ConnectorImportDialog";
import { HuggingFaceImportDialog } from "./HuggingFaceImportDialog";
import { PROVIDER_GROUPS, categoryLabel, providerMeta } from "./providers";

/** One file, table or split read through a linked account. */
export interface ConnectorSource {
  provider: ConnectorProvider;
  ref: string;
  name: string;
}

const POPUP_POLL_MS = 1500;
const POPUP_FEATURES = "popup,width=520,height=720";

/**
 * Choose a source from a linked account: tiles for the accounts already
 * linked, a menu that links another one, and the import browser in its
 * pick-only mode to choose the file. OAuth sign-in runs in a popup so the
 * page under it keeps its unsaved state.
 */
export function ConnectorSourcePicker({
  value,
  onChange,
}: {
  value: ConnectorSource | null;
  onChange: (source: ConnectorSource) => void;
}) {
  const { connectors, byProvider, setConnectors, refetch } = useConnectors();
  const settingsModal = useSettingsModal();
  const [browsing, setBrowsing] = React.useState<ConnectorProvider | null>(null);
  // Kept across closes so the generic dialog keeps its provider while it animates out.
  const [browseProvider, setBrowseProvider] = React.useState<ConnectorProvider>("github");
  const [linking, setLinking] = React.useState<ConnectorProvider | null>(null);
  const popup = React.useRef<Window | null>(null);

  // A link made in Settings shows up here once the modal closes.
  const settingsOpen = settingsModal.open;
  React.useEffect(() => {
    if (!settingsOpen) refetch();
  }, [settingsOpen, refetch]);

  const browse = React.useCallback((provider: ConnectorProvider) => {
    if (provider !== "huggingface") setBrowseProvider(provider);
    setBrowsing(provider);
  }, []);

  React.useEffect(() => {
    if (!linking) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      const closed = popup.current?.closed ?? true;
      getConnectors()
        .then((res) => {
          if (stopped) return;
          setConnectors(res.connectors);
          if (res.connectors.some((c) => c.provider === linking && c.connected)) {
            popup.current?.close();
            setLinking(null);
            toast.success(providerMeta(linking).toastConnected);
            browse(linking);
          } else if (closed) {
            setLinking(null);
          }
        })
        .catch(() => {
          if (!stopped && closed) setLinking(null);
        });
    }, POPUP_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [linking, setConnectors, browse]);

  const link = async (provider: ConnectorProvider) => {
    const meta = providerMeta(provider);
    const status = byProvider(provider);
    if (!status?.oauth_available || !meta.oauthButton || meta.oauthFields) {
      settingsModal.openTo("connectors", provider);
      return;
    }
    // Opened before the request, inside the click, so the browser does not block it.
    const win = window.open("", "connector-oauth", POPUP_FEATURES);
    if (!win) {
      settingsModal.openTo("connectors", provider);
      return;
    }
    try {
      const { authorize_url } = await meta.startOAuth();
      win.location.href = authorize_url;
      popup.current = win;
      setLinking(provider);
    } catch (err) {
      win.close();
      toast.error(err instanceof Error ? err.message : msg("connectors.toast.failed"));
    }
  };

  // Hugging Face reads public datasets without a link, so it is always offered.
  const linked = connectors
    .filter((c) => c.connected || c.provider === "huggingface")
    .map((c) => c.provider as ConnectorProvider);
  const unlinked = new Set(
    connectors.filter((c) => !c.connected).map((c) => c.provider as ConnectorProvider),
  );

  const pick = (provider: ConnectorProvider) => (ref: string, name: string) =>
    onChange({ provider, ref, name });

  return (
    <div className="flex flex-col gap-3">
      {value && (
        <div className="flex items-center gap-3 rounded-xl border border-primary/40 bg-primary/5 px-3.5 py-3">
          {React.createElement(providerMeta(value.provider).Avatar, { size: 32 })}
          <div className="min-w-0 flex-1">
            <p dir="ltr" className="truncate text-sm font-medium text-foreground">
              {value.name}
            </p>
            <p dir="ltr" className="truncate text-xs text-muted-foreground">
              {providerMeta(value.provider).name} · {value.ref}
            </p>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => browse(value.provider)}>
            {msg("continuous_tab.source.change")}
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-stretch justify-center gap-2">
        {linked.map((provider) => {
          const meta = providerMeta(provider);
          const label = byProvider(provider)?.account_label;
          return (
            <button
              key={provider}
              type="button"
              onClick={() => browse(provider)}
              className={cn(
                "inline-flex min-h-11 items-center gap-2.5 rounded-xl border border-border/70 bg-card py-2 pe-3.5 ps-2.5 text-start transition-colors hover:border-primary/50 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                value?.provider === provider && "border-primary/50",
              )}
            >
              <meta.Avatar size={24} />
              <span className="flex min-w-0 flex-col">
                <span className="text-sm font-medium text-foreground">{meta.name}</span>
                {label && (
                  <span dir="ltr" className="max-w-[12rem] truncate text-xs text-muted-foreground">
                    {label}
                  </span>
                )}
              </span>
            </button>
          );
        })}

        <DropdownMenu onOpenChange={(open) => open && refetch()}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 rounded-xl border-dashed"
              disabled={linking !== null}
            >
              {linking ? (
                <CircleNotch
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
              ) : (
                <Plus className="size-4" aria-hidden />
              )}
              {linking
                ? formatMsg("continuous_tab.source.linking", {
                    provider: providerMeta(linking).name,
                  })
                : msg("continuous_tab.source.connect")}
              {!linking && <CaretDown className="size-3 opacity-60" aria-hidden />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[15rem]">
            {PROVIDER_GROUPS.map((group) => ({
              ...group,
              providers: group.providers.filter((id) => unlinked.has(id) && id !== "huggingface"),
            }))
              .filter((group) => group.providers.length > 0)
              .map((group, index) => (
                <React.Fragment key={group.category}>
                  {index > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuLabel>{categoryLabel(group.category)}</DropdownMenuLabel>
                  {group.providers.map((id) => {
                    const meta = providerMeta(id);
                    return (
                      <DropdownMenuItem key={id} onSelect={() => void link(id)} className="gap-2.5">
                        <span className="flex size-5 shrink-0 items-center justify-center">
                          <meta.Mark size={16} />
                        </span>
                        {meta.name}
                      </DropdownMenuItem>
                    );
                  })}
                </React.Fragment>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <HuggingFaceImportDialog
        open={browsing === "huggingface"}
        onOpenChange={(open) => {
          if (!open) setBrowsing(null);
        }}
        onPick={pick("huggingface")}
      />
      <ConnectorImportDialog
        provider={browseProvider}
        open={browsing !== null && browsing !== "huggingface"}
        onOpenChange={(open) => {
          if (!open) setBrowsing(null);
        }}
        onPick={pick(browseProvider)}
      />
    </div>
  );
}
