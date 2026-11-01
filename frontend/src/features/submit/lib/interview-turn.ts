/**
 * The task interview stores every turn in its transcript and resends the whole
 * transcript each turn, so one turn over the backend's limit would make every
 * later turn fail. Turns are checked here before they are sent.
 */

/** Matches `UnifiedChatTurn.content` max_length in `backend/core/models/unified.py`. */
export const INTERVIEW_TURN_MAX_CHARS = 8000;

/** Whether a user turn fits the interview's per-turn limit. */
export function fitsInterviewTurn(content: string): boolean {
  // JS counts UTF-16 units, never fewer than Python's code points: this errs short.
  return content.length <= INTERVIEW_TURN_MAX_CHARS;
}
