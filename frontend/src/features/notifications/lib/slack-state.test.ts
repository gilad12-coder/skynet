import { test } from "node:test";
import assert from "node:assert/strict";

import type { SlackConnection } from "@/shared/lib/api";

import {
  SLACK_DM_VALUE,
  slackBrokenMessage,
  slackCellAction,
  slackChannelIdFor,
  slackConfigured,
  slackNeedsReconnect,
  slackReturnParam,
  slackTargetValue,
} from "./slack-state.ts";

function conn(over: Partial<SlackConnection> = {}): SlackConnection {
  return {
    configured: true,
    connected: true,
    status: "connected",
    broken_reason: null,
    team_name: "Acme",
    target: "dm",
    channel_id: null,
    channel_name: null,
    ...over,
  };
}

test("the Slack column is usable only once the server reports an app", () => {
  assert.equal(slackConfigured(null), false);
  assert.equal(slackConfigured(conn({ configured: false, connected: false })), false);
  assert.equal(slackConfigured(conn()), true);
});

test("turning a Slack cell on before installing starts the connect flow", () => {
  const none = conn({ connected: false, status: null, team_name: null, target: null });
  assert.equal(slackCellAction(none, true), "connect");
  assert.equal(slackCellAction(null, true), "connect");
  assert.equal(slackCellAction(none, false), "save");
  assert.equal(slackCellAction(conn(), true), "save");
});

test("the picker maps DM and channels to and from the API", () => {
  assert.equal(slackTargetValue(conn()), SLACK_DM_VALUE);
  assert.equal(slackTargetValue(conn({ target: "channel", channel_id: "C1", channel_name: "ops" })), "C1");
  assert.equal(slackChannelIdFor(SLACK_DM_VALUE), null);
  assert.equal(slackChannelIdFor("C1"), "C1");
});

test("a dead token asks for a reconnect, a refused channel for another target", () => {
  assert.equal(slackBrokenMessage("token_revoked"), "notifications.slack.broken");
  assert.equal(slackBrokenMessage(null), "notifications.slack.broken");
  assert.equal(slackBrokenMessage("not_in_channel"), "notifications.slack.broken_channel");
  assert.equal(slackNeedsReconnect(conn({ status: "broken", broken_reason: "invalid_auth" })), true);
  assert.equal(slackNeedsReconnect(conn({ status: "broken", broken_reason: "channel_not_found" })), false);
  assert.equal(slackNeedsReconnect(conn()), false);
});

test("only the two callback results are read from the URL", () => {
  assert.equal(slackReturnParam("?settings=notifications&slack=connected"), "connected");
  assert.equal(slackReturnParam("?slack=error"), "error");
  assert.equal(slackReturnParam("?slack=other"), null);
  assert.equal(slackReturnParam(""), null);
});
