"use client";

import * as React from "react";
import { HuggingFace } from "@lobehub/icons";
import { toast } from "react-toastify";
import { ArrowSquareOut, CircleNotch, Key, Trash, X } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { Input } from "@/shared/ui/primitives/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/primitives/tooltip";
import {
  removeHuggingFaceConnector,
  saveHuggingFaceToken,
  startHuggingFaceOAuth,
  type ConnectorStatus,
} from "@/shared/lib/api";
import { tI18n } from "@/shared/lib/i18n";
import { formatMsg, msg } from "@/shared/lib/messages";
import { cn } from "@/shared/lib/utils";
import { useConnectors } from "../hooks/use-connectors";

const HF_TOKENS_URL = "https://huggingface.co/settings/tokens";
const HF_TOKENS_LABEL = "huggingface.co/settings/tokens";

/** The status pill next to a linked account. Gold when healthy, destructive when it needs a reconnect. */
function StatusPill({ status }: { status: NonNullable<ConnectorStatus["status"]> }) {
  const healthy = status === "connected";
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[0.6875rem] font-medium",
        healthy ? "bg-[#C8A882]/15 text-[#8a6d44]" : "bg-destructive/10 text-destructive",
      )}
    >
      {healthy ? msg("connectors.status.connected") : msg("connectors.status.invalid")}
    </span>
  );
}

/**
 * Consume a ``?connector_error=<code>`` left by the OAuth callback redirect:
 * toast the translated message once and strip the param so a reload stays quiet.
 */
function useConnectorErrorParam() {
  React.useEffect(() => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("connector_error");
    if (!code) return;
    toast.error(tI18n(code));
    url.searchParams.delete("connector_error");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, []);
}

/**
 * Settings → Connectors: the accounts a user links on outside services so the
 * app can pull data with their permissions. Hugging Face is the first one;
 * it links through OAuth when the deployment registered an app, with a pasted
 * access token as the fallback. The token goes straight to the backend vault
 * and is never displayed again.
 */
export function ConnectorsTab() {
  const { huggingFace, loading, error, setConnectors, refetch } = useConnectors();
  useConnectorErrorParam();

  const [tokenOpen, setTokenOpen] = React.useState(false);
  const [token, setToken] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);

  const connected = huggingFace?.connected ?? false;

  const handleOAuth = async () => {
    setStarting(true);
    try {
      const { authorize_url } = await startHuggingFaceOAuth();
      window.location.assign(authorize_url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : msg("connectors.toast.failed"));
      setStarting(false);
    }
  };

  const handleSaveToken = async () => {
    const trimmed = token.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      const res = await saveHuggingFaceToken(trimmed);
      setConnectors(res.connectors);
      setToken("");
      setTokenOpen(false);
      toast.success(msg("connectors.toast.connected"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : msg("connectors.toast.failed"));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    if (removing) return;
    setRemoving(true);
    try {
      const res = await removeHuggingFaceConnector();
      setConnectors(res.connectors);
      toast.success(msg("connectors.toast.disconnected"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : msg("connectors.toast.failed"));
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{msg("connectors.title")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{msg("connectors.subtitle")}</p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <CircleNotch className="size-5 animate-spin text-primary" />
        </div>
      ) : error ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border/50 px-3 py-2.5">
          <p className="text-sm text-muted-foreground">{msg("connectors.error")}</p>
          <Button variant="outline" size="sm" onClick={refetch}>
            {msg("connectors.retry")}
          </Button>
        </div>
      ) : (
        <div className="rounded-lg border border-border/50 px-3 py-2.5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <HuggingFace.Avatar size={28} />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground">
                    {msg("connectors.hf.name")}
                  </span>
                  {connected && huggingFace?.status && <StatusPill status={huggingFace.status} />}
                </span>
                {connected ? (
                  <span className="truncate text-xs text-muted-foreground">
                    {huggingFace?.account_label
                      ? formatMsg("connectors.hf.connected_as", {
                          account: huggingFace.account_label,
                        })
                      : msg("connectors.status.connected")}
                    {" · "}
                    {huggingFace?.auth_method === "oauth"
                      ? msg("connectors.hf.via_oauth")
                      : msg("connectors.hf.via_token")}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {msg("connectors.hf.blurb")}
                  </span>
                )}
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
              {!connected && !tokenOpen && huggingFace?.oauth_available && (
                <Button
                  size="sm"
                  onClick={handleOAuth}
                  disabled={starting}
                  className="min-h-[44px] sm:min-h-0 [@media(hover:none)_and_(pointer:coarse)]:min-h-[44px]"
                >
                  {starting ? (
                    <CircleNotch className="size-3.5 animate-spin" />
                  ) : (
                    <ArrowSquareOut className="size-3.5" />
                  )}
                  {msg("connectors.hf.oauth_button")}
                </Button>
              )}
              {!connected && !tokenOpen && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setTokenOpen(true)}
                  className="min-h-[44px] sm:min-h-0 [@media(hover:none)_and_(pointer:coarse)]:min-h-[44px]"
                >
                  <Key className="size-3.5" />
                  {msg("connectors.hf.token_toggle")}
                </Button>
              )}
              {connected && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon-sm"
                      onClick={handleRemove}
                      disabled={removing}
                      className="size-[44px] text-destructive hover:text-destructive sm:size-8 [@media(hover:none)_and_(pointer:coarse)]:size-[44px]"
                      aria-label={msg("connectors.disconnect")}
                    >
                      {removing ? (
                        <CircleNotch className="size-3.5 animate-spin" />
                      ) : (
                        <Trash className="size-3.5" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{msg("connectors.disconnect")}</TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>

          {connected && huggingFace?.status === "invalid" && (
            <p className="mt-1.5 text-[0.6875rem] text-destructive/80">
              {msg("connectors.hf.reconnect_hint")}
            </p>
          )}

          {!connected && tokenOpen && (
            <div className="mt-2.5 flex flex-col gap-2 animate-in fade-in-0 slide-in-from-top-1">
              <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                <Input
                  dir="ltr"
                  type="password"
                  autoFocus
                  autoComplete="off"
                  placeholder={msg("connectors.hf.token_placeholder")}
                  aria-label={msg("connectors.hf.token_label")}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleSaveToken();
                    if (e.key === "Escape") setTokenOpen(false);
                  }}
                  className="h-[44px] flex-1 sm:h-8 [@media(hover:none)_and_(pointer:coarse)]:h-[44px]"
                />
                <div className="flex items-center justify-end gap-2">
                  <Button
                    size="sm"
                    onClick={handleSaveToken}
                    disabled={!token.trim() || saving}
                    className="min-h-[44px] sm:min-h-0 [@media(hover:none)_and_(pointer:coarse)]:min-h-[44px]"
                  >
                    {saving ? (
                      <CircleNotch className="size-3.5 animate-spin" />
                    ) : (
                      <Key className="size-3.5" />
                    )}
                    {msg("connectors.hf.token_save")}
                  </Button>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    onClick={() => setTokenOpen(false)}
                    className="size-[44px] sm:size-8 [@media(hover:none)_and_(pointer:coarse)]:size-[44px]"
                    aria-label={msg("connectors.cancel")}
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              </div>
              <p className="text-[0.6875rem] text-muted-foreground/80">
                {msg("connectors.hf.token_help")}{" "}
                <a
                  href={HF_TOKENS_URL}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-0.5 font-medium text-[#8a6d44] underline-offset-2 hover:underline"
                >
                  {HF_TOKENS_LABEL}
                  <ArrowSquareOut className="size-3" />
                </a>
              </p>
            </div>
          )}
        </div>
      )}

      <p className="text-xs text-muted-foreground">{msg("connectors.hf.import_hint")}</p>
    </div>
  );
}
