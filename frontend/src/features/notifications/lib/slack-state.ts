/*
 * The pure half of the Slack connection in Settings: what a Slack cell click
 * needs first, how the target picker maps to the API, and reading the
 * `?slack=` result the OAuth callback leaves. Type imports only, so it runs
 * under the node test runner.
 */

import type { SlackConnection } from "@/shared/lib/api";
import type { MessageKey } from "@/shared/lib/messages";

/** The target picker's value for "direct message from the app". */
export const SLACK_DM_VALUE = "__dm__";

// Mirrors the backend's TOKEN_ERRORS: only reinstalling the app fixes these.
const TOKEN_ERRORS: ReadonlySet<string> = new Set([
  "token_revoked",
  "account_inactive",
  "invalid_auth",
  "not_authed",
  "token_expired",
  "team_disabled",
]);

/** Whether Slack cells can be used on this server (the status loaded and the app is set up). */
export function slackConfigured(connection: SlackConnection | null): boolean {
  return connection?.configured ?? false;
}

/**
 * What flipping a Slack cell needs first: turning one on before the app is
 * installed starts "Add to Slack"; everything else just saves.
 */
export function slackCellAction(connection: SlackConnection | null, on: boolean): "save" | "connect" {
  return on && !connection?.connected ? "connect" : "save";
}

/** The picker value for the current target. */
export function slackTargetValue(connection: SlackConnection): string {
  return connection.target === "channel" && connection.channel_id ? connection.channel_id : SLACK_DM_VALUE;
}

/** The PATCH body's channel id for a picker value (null for a DM). */
export function slackChannelIdFor(value: string): string | null {
  return value === SLACK_DM_VALUE ? null : value;
}

/**
 * Why a broken connection stopped, as the message to show: a dead token
 * needs a reconnect, a refused channel needs an invite or another target.
 */
export function slackBrokenMessage(reason: string | null): MessageKey {
  return reason !== null && !TOKEN_ERRORS.has(reason)
    ? "notifications.slack.broken_channel"
    : "notifications.slack.broken";
}

/** Whether the broken state is fixed by reinstalling (rather than re-picking the target). */
export function slackNeedsReconnect(connection: SlackConnection): boolean {
  return connection.status === "broken" && (connection.broken_reason === null || TOKEN_ERRORS.has(connection.broken_reason));
}

/** The `?slack=` value the OAuth callback redirect left, or null. */
export function slackReturnParam(search: string): "connected" | "error" | null {
  const value = new URLSearchParams(search).get("slack");
  return value === "connected" || value === "error" ? value : null;
}
