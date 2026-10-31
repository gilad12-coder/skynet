/** Tests for the task interview's per-turn size check. */

import assert from "node:assert/strict";
import test from "node:test";

import { joinPastes } from "../../../shared/ui/agent/pasted-text.ts";
import { fitsInterviewTurn, INTERVIEW_TURN_MAX_CHARS } from "./interview-turn.ts";

test("the limit matches the backend's UnifiedChatTurn.content max_length", () => {
  assert.equal(INTERVIEW_TURN_MAX_CHARS, 8000);
});

test("a turn with a long attached file does not fit", () => {
  const turn = joinPastes({
    text: "use this",
    pastes: [],
    files: [{ name: "brief.md", text: "x".repeat(8000) }],
  });
  assert.equal(fitsInterviewTurn(turn), false);
});

test("a short turn and one at the limit fit", () => {
  assert.equal(fitsInterviewTurn("a short answer"), true);
  assert.equal(fitsInterviewTurn("x".repeat(INTERVIEW_TURN_MAX_CHARS)), true);
});
