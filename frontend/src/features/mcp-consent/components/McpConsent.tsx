"use client";

import * as React from "react";
import { useSession } from "next-auth/react";

import {
  ApiError,
  describeMcpConsent,
  setApiAuthToken,
  submitMcpConsent,
  type McpConsentDescription,
} from "@/shared/lib/api";
import { msg, type MessageKey } from "@/shared/lib/messages";
import { Check, CircleNotch, Robot, UserCircle } from "@/shared/ui/icons";
import { InlineErrorRow } from "@/shared/ui/inline-error-row";
import { Button } from "@/shared/ui/primitives/button";
import {
  errorMessageKey,
  parseMcpRequest,
  returnHost,
  safeRedirect,
  scopeMessageKey,
  type McpScope,
} from "../lib/consent";

type Phase = "loading" | "ready" | "sending" | "returning";

function errorKey(err: unknown): string {
  const apiError = err instanceof ApiError ? err : undefined;
  return errorMessageKey(apiError?.code, apiError?.status);
}

/**
 * Hosted consent page for an AI agent that connects to Skynet over MCP. The
 * route is login-gated, so the user is signed in here. The backend checks the
 * agent and its redirect, then returns the redirect with a code or a refusal.
 */
export function McpConsent({ query }: { query: string }) {
  const { data: session, status } = useSession();
  const parsed = React.useMemo(() => parseMcpRequest(new URLSearchParams(query)), [query]);
  const [phase, setPhase] = React.useState<Phase>("loading");
  const [client, setClient] = React.useState<McpConsentDescription | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const request = parsed.ok ? parsed.request : null;
  const token = session?.backendAccessToken;

  React.useEffect(() => {
    if (!request || status !== "authenticated") return;
    // Effects run child-before-parent, so the root token bridge may not have
    // set the bearer yet; the Mac link page does the same.
    if (token) setApiAuthToken(token);
    let live = true;
    describeMcpConsent({
      client_id: request.clientId,
      redirect_uri: request.redirectUri,
      scope: request.scopes.join(" "),
    })
      .then((description) => {
        if (!live) return;
        setClient(description);
        setPhase("ready");
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(errorKey(err));
      });
    return () => {
      live = false;
    };
  }, [request, status, token]);

  if (!request || (error && !client)) {
    const key = request ? error : errorMessageKey(parsed.ok ? undefined : parsed.problem);
    return (
      <ConsentFrame>
        <h1 className="text-center text-lg font-semibold text-foreground">
          {msg("mcp_consent.error_title")}
        </h1>
        <InlineErrorRow message={msg((key ?? "mcp_consent.error.generic") as MessageKey)} />
      </ConsentFrame>
    );
  }

  const decide = async (decision: "approve" | "deny") => {
    setPhase("sending");
    setError(null);
    if (token) setApiAuthToken(token);
    try {
      const { redirect_url } = await submitMcpConsent({
        client_id: request.clientId,
        redirect_uri: request.redirectUri,
        code_challenge: request.codeChallenge,
        code_challenge_method: "S256",
        scope: request.scopes.join(" "),
        state: request.state,
        resource: request.resource,
        decision,
      });
      const target = safeRedirect(redirect_url);
      if (!target) {
        setError("mcp_consent.error.invalid_request");
        setPhase("ready");
        return;
      }
      setPhase("returning");
      window.location.assign(target);
    } catch (err) {
      setError(errorKey(err));
      setPhase("ready");
    }
  };

  if (phase === "loading" || !client) {
    return (
      <ConsentFrame>
        <p
          role="status"
          className="flex items-center justify-center gap-2 text-sm text-muted-foreground"
        >
          <CircleNotch className="size-4 animate-spin" aria-hidden />
          {msg("mcp_consent.loading")}
        </p>
      </ConsentFrame>
    );
  }

  const busy = phase !== "ready";

  return (
    <ConsentFrame>
      <h1
        className="text-center text-lg font-semibold text-foreground sm:truncate"
        title={msg("mcp_consent.title", { client: client.client_name })}
      >
        {msg("mcp_consent.title", { client: client.client_name })}
      </h1>

      <dl className="flex flex-col gap-3 rounded-xl border border-border/60 bg-muted/30 p-4 text-sm">
        <div className="flex items-center gap-3">
          <Robot className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">{msg("mcp_consent.client_label")}</dt>
            <dd className="truncate font-medium text-foreground" dir="auto">
              {client.client_name}
            </dd>
            <dd className="text-xs break-all text-muted-foreground" dir="ltr">
              {msg("mcp_consent.redirect_host", { host: returnHost(client) })}
            </dd>
            {client.client_host && (
              <dd className="text-xs break-all text-muted-foreground" dir="ltr">
                {msg("mcp_consent.client_host", { host: client.client_host })}
              </dd>
            )}
          </div>
        </div>
        {session?.user?.email && (
          <div className="flex items-center gap-3">
            <UserCircle className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">{msg("mcp_consent.account_label")}</dt>
              <dd className="truncate font-medium text-foreground" dir="ltr">
                {session.user.email}
              </dd>
            </div>
          </div>
        )}
      </dl>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-foreground">{msg("mcp_consent.allows_heading")}</h2>
        <ul className="flex flex-col gap-2 text-sm text-muted-foreground">
          {request.scopes.map((scope: McpScope) => (
            <li key={scope} className="flex items-start gap-2">
              <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
              <span>{msg(scopeMessageKey(scope) as MessageKey)}</span>
            </li>
          ))}
        </ul>
      </section>

      {error && <InlineErrorRow message={msg(error as MessageKey)} />}

      {phase === "returning" ? (
        <p
          role="status"
          className="flex items-center justify-center gap-2 text-sm text-muted-foreground"
        >
          <CircleNotch className="size-4 animate-spin" aria-hidden />
          {msg("mcp_consent.returning")}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            className="min-h-[44px] w-full sm:min-h-0"
            disabled={busy}
            onClick={() => void decide("deny")}
          >
            {msg("mcp_consent.deny")}
          </Button>
          <Button
            className="min-h-[44px] w-full sm:min-h-0"
            disabled={busy}
            aria-busy={phase === "sending"}
            onClick={() => void decide("approve")}
          >
            {phase === "sending" && <CircleNotch className="animate-spin" aria-hidden />}
            {msg("mcp_consent.approve")}
          </Button>
        </div>
      )}
    </ConsentFrame>
  );
}

function ConsentFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="flex w-full max-w-lg flex-col gap-5 rounded-2xl border border-border/50 bg-card p-6 text-card-foreground shadow-sm">
        {children}
      </div>
    </div>
  );
}
