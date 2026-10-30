"use client";

import * as React from "react";

export interface AgentKickoff {
  /** A kickoff is due for the current key but has not started yet. */
  pending: boolean;
  /** Forget the started key, so the current one opens the chat again. */
  rearm: () => void;
}

/**
 * Open an agent chat by itself once per input. `key` names the input the
 * agent should look at (a repository and branch, a tagging session, an
 * interview run) and is `null` while there is nothing to open on; `start`
 * runs once per distinct key, `settleMs` after the key stops changing, so a
 * selection that settles in two steps opens one conversation, not two.
 * Re-renders never repeat it, and a key that comes back after `null` does
 * not either; `rearm` does.
 */
export function useAgentKickoff(key: string | null, start: () => void, settleMs = 0): AgentKickoff {
  const [startedKey, setStartedKey] = React.useState<string | null>(null);
  const startRef = React.useRef(start);
  React.useEffect(() => {
    startRef.current = start;
  }, [start]);

  React.useEffect(() => {
    if (key === null || startedKey === key) return;
    // The timer also absorbs StrictMode's double effect run: the first one
    // is cleared before it fires.
    const timer = setTimeout(() => {
      setStartedKey(key);
      startRef.current();
    }, settleMs);
    return () => clearTimeout(timer);
  }, [key, startedKey, settleMs]);

  const rearm = React.useCallback(() => setStartedKey(null), []);
  return { pending: key !== null && startedKey !== key, rearm };
}
