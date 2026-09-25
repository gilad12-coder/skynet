"use client";

import { LoadingState } from "@/shared/ui/loading-state";
import * as React from "react";
import { toast } from "react-toastify";
import { ArrowSquareOut, CircleNotch, FloppyDisk, Key, SignIn, Trash, X } from "@/shared/ui/icons";
import { RetryIconButton } from "@/shared/ui/retry-icon-button";
import { StatusPill } from "@/shared/ui/status-badge";
import { Button } from "@/shared/ui/primitives/button";
import { Input } from "@/shared/ui/primitives/input";
import { Label } from "@/shared/ui/primitives/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/primitives/tooltip";
import type { ConnectorProvider, ConnectorStatus } from "@/shared/lib/api";
import { tI18n } from "@/shared/lib/i18n";
import { formatMsg, msg } from "@/shared/lib/messages";
import { cn } from "@/shared/lib/utils";
import { useConnectors } from "../hooks/use-connectors";
import {
  PROVIDER_GROUPS,
  categoryLabel,
  providerMeta,
  type CredentialField,
  type ProviderMeta,
} from "./providers";
import { TOUCH_FIELD_SM } from "@/shared/ui/touch";
import { Textarea } from "@/shared/ui/primitives/textarea";

/** The status pill next to a linked account. Green when healthy, failed when it needs a reconnect. */
function ConnectorStatusPill({ status }: { status: NonNullable<ConnectorStatus["status"]> }) {
  const healthy = status === "connected";
  return (
    <StatusPill tone={healthy ? "success" : "failed"}>
      {healthy ? msg("connectors.status.connected") : msg("connectors.status.invalid")}
    </StatusPill>
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

/** One input of the credentials form; secrets are masked, long pastes get a textarea. */
function CredentialInput({
  field,
  id,
  value,
  onChange,
  autoFocus,
  onSubmit,
  onCancel,
}: {
  field: CredentialField;
  id: string;
  value: string;
  onChange: (value: string) => void;
  autoFocus: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onCancel();
    if (e.key === "Enter" && !field.multiline) onSubmit();
  };
  if (field.multiline) {
    return (
      <Textarea
        id={id}
        dir="ltr"
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        rows={3}
        placeholder={field.placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        className={cn(
          "min-h-[5.5rem] resize-y font-mono text-xs",
          field.secret && value && "[-webkit-text-security:disc]",
        )}
      />
    );
  }
  return (
    <Input
      id={id}
      dir="ltr"
      type={field.secret ? "password" : "text"}
      autoFocus={autoFocus}
      autoComplete="off"
      placeholder={field.placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      className={TOUCH_FIELD_SM}
    />
  );
}

/**
 * One connector: brand mark, link state, and the actions to link (OAuth when
 * the deployment registered an app, pasted credentials otherwise) or unlink.
 * Credentials go straight to the backend vault and are never displayed again.
 */
function ProviderCard({
  meta,
  status,
  onChange,
}: {
  meta: ProviderMeta;
  status: ConnectorStatus | null;
  onChange: (connectors: ConnectorStatus[]) => void;
}) {
  const [formOpen, setFormOpen] = React.useState(false);
  // The same form collects pasted credentials, or the names a provider needs before its OAuth redirect.
  const [formMode, setFormMode] = React.useState<"credentials" | "oauth">("credentials");
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);

  const connected = status?.connected ?? false;
  const oauthMode = formMode === "oauth";
  const fields = oauthMode ? (meta.oauthFields ?? []) : meta.fields;
  const complete = fields.every((f) => !f.required || (values[f.key] ?? "").trim());
  const submitLabel = oauthMode ? (meta.oauthButton ?? "") : msg("settings.keys.save");
  const trimmedValues = () =>
    Object.fromEntries(
      fields.map((f) => [f.key, (values[f.key] ?? "").trim()]).filter(([, v]) => v),
    );

  const closeForm = () => {
    setFormOpen(false);
    setFormMode("credentials");
    setValues({});
  };

  const openForm = (mode: "credentials" | "oauth") => {
    setFormMode(mode);
    setFormOpen(true);
  };

  const handleOAuth = async (oauthValues?: Record<string, string>) => {
    setStarting(true);
    try {
      const { authorize_url } = await meta.startOAuth(oauthValues);
      window.location.assign(authorize_url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : msg("connectors.toast.failed"));
      setStarting(false);
    }
  };

  const handleSave = async () => {
    if (!complete || saving || starting) return;
    if (oauthMode) {
      await handleOAuth(trimmedValues());
      return;
    }
    setSaving(true);
    try {
      const res = await meta.saveCredentials(trimmedValues());
      onChange(res.connectors);
      closeForm();
      toast.success(meta.toastConnected);
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
      const res = await meta.remove();
      onChange(res.connectors);
      toast.success(meta.toastDisconnected);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : msg("connectors.toast.failed"));
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="rounded-lg border border-border/50 px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <meta.Avatar size={28} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium text-foreground">{meta.name}</span>
            {connected ? (
              <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                {status?.status && <ConnectorStatusPill status={status.status} />}
                <span className="truncate">
                  {status?.account_label
                    ? formatMsg("connectors.hf.connected_as", { account: status.account_label })
                    : msg("connectors.status.connected")}
                </span>
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">{meta.blurb}</span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {!connected && !formOpen && meta.oauthButton && status?.oauth_available && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => (meta.oauthFields ? openForm("oauth") : void handleOAuth())}
                  disabled={starting}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={meta.oauthButton}
                >
                  {starting ? (
                    <CircleNotch
                      className="animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : (
                    <SignIn className="size-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{meta.oauthButton}</TooltipContent>
            </Tooltip>
          )}
          {!connected && !formOpen && meta.fields.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => openForm("credentials")}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={msg("settings.keys.add")}
                >
                  <Key className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{msg("settings.keys.add")}</TooltipContent>
            </Tooltip>
          )}
          {!connected && meta.fields.length === 0 && status && !status.oauth_available && (
            <span className="text-xs text-muted-foreground">
              {formatMsg("connectors.oauth_only_unavailable", { provider: meta.name })}
            </span>
          )}
          {connected && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleRemove}
                  disabled={removing}
                  className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  aria-label={msg("connectors.disconnect")}
                >
                  {removing ? (
                    <CircleNotch
                      className="animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : (
                    <Trash className="size-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{msg("connectors.disconnect")}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      {connected && status?.status === "invalid" && (
        <p role="alert" className="mt-1.5 text-xs text-destructive">
          {meta.reconnectHint}
        </p>
      )}

      {!connected && formOpen && (
        <div className="mt-2.5 flex flex-col gap-2 animate-in fade-in-0 slide-in-from-top-1">
          {fields.map((field, index) => {
            const id = `connector-${meta.id}-${field.key}`;
            const last = index === fields.length - 1;
            const input = (
              <CredentialInput
                field={field}
                id={id}
                value={values[field.key] ?? ""}
                onChange={(value) => setValues((prev) => ({ ...prev, [field.key]: value }))}
                autoFocus={index === 0}
                onSubmit={() => void handleSave()}
                onCancel={closeForm}
              />
            );
            return (
              <div key={field.key} className="flex flex-col gap-1">
                <Label htmlFor={id} className="text-xs">
                  {field.label}
                </Label>
                {last ? (
                  <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                    <div className="min-w-0 flex-1">{input}</div>
                    <div className="flex items-center justify-end gap-2">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="icon-sm"
                            onClick={handleSave}
                            disabled={!complete || saving || starting}
                            aria-label={submitLabel}
                          >
                            {saving || starting ? (
                              <CircleNotch
                                className="animate-spin motion-reduce:animate-none"
                                aria-hidden="true"
                              />
                            ) : oauthMode ? (
                              <SignIn className="size-4" />
                            ) : (
                              <FloppyDisk className="size-4" />
                            )}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{submitLabel}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={closeForm}
                            aria-label={msg("settings.keys.cancel")}
                          >
                            <X className="size-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{msg("settings.keys.cancel")}</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                ) : (
                  input
                )}
              </div>
            );
          })}
          <p className="text-[0.6875rem] text-muted-foreground/70">
            {oauthMode ? meta.oauthHelp : meta.credentialsHelp}
            {!oauthMode && meta.helpUrl && (
              <>
                {" "}
                <a
                  href={meta.helpUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-0.5 rounded-sm font-medium text-[#8A6D44] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C8A882]/45"
                >
                  {meta.helpUrlLabel}
                  <ArrowSquareOut className="size-3" />
                </a>
              </>
            )}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Settings → Connectors: the accounts a user links on outside services so the
 * app can pull data with their permissions. Each provider links through OAuth
 * when the deployment registered an app, with pasted credentials as the
 * fallback; the secrets go straight to the backend vault.
 */
export function ConnectorsTab() {
  const { byProvider, loading, error, setConnectors, refetch } = useConnectors();
  useConnectorErrorParam();

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{msg("connectors.subtitle")}</p>

      {loading ? (
        <LoadingState />
      ) : error ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border/50 px-3 py-2.5">
          <p className="text-sm text-muted-foreground">{msg("connectors.error")}</p>
          <RetryIconButton label={msg("connectors.retry")} onClick={refetch} />
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {PROVIDER_GROUPS.map((group) => (
            <section key={group.category} className="flex flex-col gap-2.5">
              <h4 className="text-[0.6875rem] font-semibold uppercase tracking-widest text-muted-foreground">
                {categoryLabel(group.category)}
              </h4>
              {group.providers.map((id: ConnectorProvider) => (
                <ProviderCard
                  key={id}
                  meta={providerMeta(id)}
                  status={byProvider(id)}
                  onChange={setConnectors}
                />
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
