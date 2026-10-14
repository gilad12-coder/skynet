/** The two editors a coding turn writes into, named as the agent's events name them. */
export type DraftSource = "signature" | "metric";

export interface CodeDrafts {
  /** Add a streamed piece of code; `reset` starts a new draft. Returns the draft so far. */
  write(source: DraftSource, chunk: string, reset: boolean): string;
  /** The edit landed: its checked code replaces the draft. */
  land(source: DraftSource): void;
  /** The edit never landed. Returns true when a draft was open and has been dropped. */
  drop(source: DraftSource): boolean;
}

/**
 * Track the code an agent's edit call is writing into each editor while the
 * model writes it. A draft is only shown, never saved as a version: the
 * call's checked replacement lands it, and a call that never lands gives the
 * editor back what it held before.
 *
 * Returns:
 *   The per-turn draft tracker.
 */
export function createCodeDrafts(): CodeDrafts {
  const drafts: Record<DraftSource, string | null> = { signature: null, metric: null };
  return {
    write(source, chunk, reset) {
      const next = (reset ? "" : (drafts[source] ?? "")) + chunk;
      drafts[source] = next;
      return next;
    },
    land(source) {
      drafts[source] = null;
    },
    drop(source) {
      const open = drafts[source] !== null;
      drafts[source] = null;
      return open;
    },
  };
}
