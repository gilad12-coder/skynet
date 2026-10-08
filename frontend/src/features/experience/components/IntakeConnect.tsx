"use client";

import * as React from "react";

import { providerMeta } from "@/features/connectors";
import { getConnectors, type ConnectorProvider } from "@/shared/lib/api";
import { formatMsg, msg } from "@/shared/lib/messages";
import { cn } from "@/shared/lib/utils";
import { Check, CircleNotch } from "@/shared/ui/icons";
import { Button } from "@/shared/ui/primitives/button";
import { Input } from "@/shared/ui/primitives/input";
import { TOUCH_FIELD } from "@/shared/ui/touch";

import type { IntakeConnectorState } from "../lib/intake";
import { TOUCH_TAP } from "./touch";

/**
 * The one connector a setup answer implies, linked inline through the same
 * flows as Settings > Connectors: the OAuth redirect when the deployment offers
 * it, otherwise the provider's credential fields. A failure or a cancel leaves
 * the row on "Connect later" and the setup carries on.
 */
export function IntakeConnect({
  provider,
  state,
  onState,
  beforeRedirect,
}: {
  provider: ConnectorProvider;
  state: IntakeConnectorState;
  onState: (state: IntakeConnectorState) => void;
  /** Persist the in-progress answers before the OAuth redirect leaves the page. */
  beforeRedirect: () => void;
}) {
  const meta = providerMeta(provider);
  const [checking, setChecking] = React.useState(true);
  const [oauthAvailable, setOauthAvailable] = React.useState(false);
  const [formOpen, setFormOpen] = React.useState(false);
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setChecking(true);
    getConnectors()
      .then((res) => {
        if (cancelled) return;
        const entry = res.connectors.find((c) => c.provider === provider);
        setOauthAvailable(!!entry?.oauth_available && !!meta.oauthButton && !meta.oauthFields);
        if (entry?.connected) onState("connected");
      })
      .catch(() => {
        if (!cancelled) setOauthAvailable(false);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
    // Re-read only when the implied provider changes; onState is a setter.
  }, [provider]);

  const fail = () => {
    setFailed(true);
    setFormOpen(false);
    onState("later");
  };

  const connect = async () => {
    setFailed(false);
    if (oauthAvailable) {
      setBusy(true);
      try {
        beforeRedirect();
        const { authorize_url } = await meta.startOAuth();
        window.location.assign(authorize_url);
      } catch {
        setBusy(false);
        fail();
      }
      return;
    }
    if (meta.fields.length === 0) {
      fail();
      return;
    }
    setFormOpen(true);
  };

  const complete = meta.fields.every((f) => !f.required || (values[f.key] ?? "").trim());
  const save = async () => {
    if (!complete || busy) return;
    setBusy(true);
    try {
      const fields = Object.fromEntries(
        meta.fields.map((f) => [f.key, (values[f.key] ?? "").trim()]).filter(([, v]) => v),
      );
      const res = await meta.saveCredentials(fields);
      const entry = res.connectors.find((c) => c.provider === provider);
      if (entry?.connected) {
        setFormOpen(false);
        onState("connected");
      } else {
        fail();
      }
    } catch {
      fail();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/50 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <meta.Avatar size={24} />
          <div className="flex min-w-0 flex-col">
            <span className="text-sm font-medium text-foreground">{meta.name}</span>
            <span className="truncate text-xs text-muted-foreground">
              {state === "connected"
                ? msg("experience.connector.connected")
                : state === "later"
                  ? msg("experience.connector.later")
                  : meta.blurb}
            </span>
          </div>
        </div>
        {checking ? (
          <CircleNotch
            className="size-4 shrink-0 animate-spin text-muted-foreground"
            aria-label={msg("experience.connector.checking")}
          />
        ) : state === "connected" ? (
          <Check className="size-4 shrink-0 text-foreground" aria-hidden="true" />
        ) : (
          !formOpen && (
            <div className="flex shrink-0 items-center gap-1.5">
              {state !== "later" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className={TOUCH_TAP}
                  onClick={() => onState("later")}
                >
                  {msg("experience.connector.later_action")}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className={TOUCH_TAP}
                onClick={() => void connect()}
                disabled={busy}
              >
                {busy ? msg("experience.connector.connecting") : msg("experience.connector.connect")}
              </Button>
            </div>
          )
        )}
      </div>

      {failed && (
        <p className="text-xs text-muted-foreground" role="status">
          {formatMsg("experience.connector.failed", { provider: meta.name })}
        </p>
      )}

      {formOpen && (
        <div className="flex flex-col gap-2">
          {meta.fields.map((field) => (
            <Input
              key={field.key}
              type={field.secret ? "password" : "text"}
              autoComplete="off"
              aria-label={field.label}
              placeholder={field.placeholder ?? field.label}
              value={values[field.key] ?? ""}
              onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
              className={cn(TOUCH_FIELD, "text-sm")}
            />
          ))}
          <div className="flex justify-end gap-1.5">
            <Button variant="ghost" size="sm" className={TOUCH_TAP} onClick={fail}>
              {msg("experience.connector.later_action")}
            </Button>
            <Button
              size="sm"
              className={TOUCH_TAP}
              onClick={() => void save()}
              disabled={!complete || busy}
            >
              {busy ? msg("experience.connector.connecting") : msg("experience.connector.connect")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
