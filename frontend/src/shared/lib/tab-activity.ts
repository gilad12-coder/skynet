/**
 * What the browser tab shows about the app's agents and checks: a gray mark
 * while a chat or a check page is open and waiting, a green one while an
 * agent thinks or a check executes. Surfaces register what they are doing and
 * the tab shows the most active of them, wherever in the app it happens.
 */

export type TabActivity = "idle" | "busy";

export interface TabActivityStore {
  /** Record what one surface is doing; `null` withdraws it without unmounting. */
  set(token: object, activity: TabActivity | null): void;
  clear(token: object): void;
  subscribe(listener: () => void): () => void;
  get(): TabActivity | null;
}

/** Busy wins over idle; nothing registered shows no mark. */
export function resolveTabActivity(values: Iterable<TabActivity>): TabActivity | null {
  let idle = false;
  for (const value of values) {
    if (value === "busy") return "busy";
    idle = true;
  }
  return idle ? "idle" : null;
}

export function createTabActivityStore(): TabActivityStore {
  const entries = new Map<object, TabActivity>();
  const listeners = new Set<() => void>();
  let snapshot: TabActivity | null = null;

  const publish = () => {
    const next = resolveTabActivity(entries.values());
    if (next === snapshot) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };

  return {
    set(token, activity) {
      if (activity === null) entries.delete(token);
      else entries.set(token, activity);
      publish();
    },
    clear(token) {
      if (!entries.delete(token)) return;
      publish();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: () => snapshot,
  };
}

export const tabActivity = createTabActivityStore();
