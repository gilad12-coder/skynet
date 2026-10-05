/**
 * Codex-style mid-turn input for the agent chats: what the user sends while a
 * turn is still running is either steered into that turn (the agent reads it
 * at its next step) or queued as a follow-up that runs once the chat is idle.
 *
 * Kept free of runtime imports so the unit-test runner can load it.
 */

/** A message the user sent while a turn was running. */
export interface PendingMessage {
  id: string;
  text: string;
}

export interface SteerQueueSnapshot {
  /** Follow-ups waiting for the chat to go idle, sent in order. */
  queued: readonly PendingMessage[];
  /** Messages handed to the running turn that the agent has not read yet. */
  steering: readonly PendingMessage[];
  /** A turn is running and accepts steering right now. */
  canSteer: boolean;
}

/** How one steerable turn takes messages in and gives back unread ones. */
export interface SteerChannel {
  /** Posts one message into the turn; resolves its server id, or null when
   *  the turn cannot take it. */
  post: (text: string) => Promise<string | null>;
  /** Takes back every message the turn never read; resolves their server ids. */
  withdraw: () => Promise<string[]>;
}

interface SteerEntry extends PendingMessage {
  turn: number;
  serverId: string | null;
  posting: Promise<void>;
}

const EMPTY: SteerQueueSnapshot = { queued: [], steering: [], canSteer: false };

/**
 * One chat's queued follow-ups and in-flight steers. The owner reports when
 * the chat is busy (`setBusy`), opens each steerable turn (`openTurn`) and
 * reports applied steers; the queue sends its head through `send` whenever
 * the chat goes idle, one at a time. When a steerable turn ends, steers the
 * agent never read are withdrawn and put at the front of the queue.
 */
export class SteerQueue {
  private queued: PendingMessage[] = [];
  private steering: SteerEntry[] = [];
  private busy = false;
  private settling = 0;
  private turn = 0;
  private channel: SteerChannel | null = null;
  // A steer can be applied before its POST resolves with the id.
  private appliedIds = new Set<string>();
  private snapshot: SteerQueueSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  private nextId = 0;
  private pumpScheduled = false;
  private send: (text: string) => void;

  constructor(send: (text: string) => void = () => {}) {
    this.send = send;
  }

  /** Replace what starts a follow-up's turn (the owner's latest `send`). */
  setSend(send: (text: string) => void): void {
    this.send = send;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): SteerQueueSnapshot => this.snapshot;

  /** True while anything is queued or awaiting the agent. */
  hasPending(): boolean {
    return this.queued.length > 0 || this.steering.length > 0;
  }

  /**
   * Report whether a turn is running. Going idle ends the open steerable turn
   * (done, error, or stop) and then sends the queue's head.
   */
  setBusy(busy: boolean): void {
    if (!busy && this.channel) {
      this.endTurn();
      return;
    }
    if (this.busy === busy) return;
    this.busy = busy;
    this.emit();
    if (!busy) this.schedulePump();
  }

  /** A steerable turn started; `channel` delivers messages into it. */
  openTurn(channel: SteerChannel): void {
    if (this.channel) this.endTurn();
    this.turn += 1;
    this.channel = channel;
    this.busy = true;
    this.appliedIds = new Set();
    this.emit();
  }

  /**
   * The open steerable turn ended. Steers it never read are withdrawn and put
   * at the front of the queue, so they run as the next turn.
   */
  private endTurn(): void {
    const channel = this.channel;
    const turn = this.turn;
    const entries = this.steering.filter((e) => e.turn === turn);
    this.channel = null;
    this.busy = false;
    if (!channel || entries.length === 0) {
      this.emit();
      this.schedulePump();
      return;
    }
    this.settling += 1;
    this.emit();
    void this.settle(entries, channel.withdraw);
  }

  private async settle(entries: SteerEntry[], withdraw: () => Promise<string[]>): Promise<void> {
    await Promise.all(entries.map((e) => e.posting));
    const live = entries.filter((e) => e.serverId !== null && this.steering.includes(e));
    let returned: SteerEntry[] = [];
    if (live.length > 0) {
      try {
        const ids = new Set(await withdraw());
        returned = live.filter((e) => ids.has(e.serverId ?? ""));
      } catch {
        // Unknown outcome: keep the user's text rather than lose it.
        returned = live;
      }
    }
    this.steering = this.steering.filter((e) => !entries.includes(e));
    this.queued = [...returned.map(({ id, text }) => ({ id, text })), ...this.queued];
    this.settling -= 1;
    this.emit();
    this.schedulePump();
  }

  /** The agent read these steers; their text is already in the stream. */
  applied(ids: readonly string[]): void {
    for (const id of ids) this.appliedIds.add(id);
    const before = this.steering.length;
    this.steering = this.steering.filter(
      (e) => e.serverId === null || !this.appliedIds.has(e.serverId),
    );
    if (this.steering.length !== before) this.emit();
  }

  /** Deliver `text` into the running turn, or queue it when none can take it. */
  steer(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const channel = this.channel;
    if (!channel || !this.busy) {
      this.enqueue(trimmed);
      return;
    }
    const entry: SteerEntry = {
      id: this.makeId(),
      text: trimmed,
      turn: this.turn,
      serverId: null,
      posting: Promise.resolve(),
    };
    const fallBack = () => {
      if (!this.steering.includes(entry)) return;
      this.steering = this.steering.filter((e) => e !== entry);
      this.queued = [{ id: entry.id, text: entry.text }, ...this.queued];
      this.emit();
      this.schedulePump();
    };
    entry.posting = channel.post(trimmed).then(
      (serverId) => {
        if (!serverId) {
          fallBack();
          return;
        }
        entry.serverId = serverId;
        if (this.appliedIds.has(serverId)) this.applied([serverId]);
      },
      fallBack,
    );
    this.steering = [...this.steering, entry];
    this.emit();
  }

  /** Hold `text` until the chat is idle, then send it as its own turn. */
  enqueue(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.queued = [...this.queued, { id: this.makeId(), text: trimmed }];
    this.emit();
    this.schedulePump();
  }

  /** Remove a queued follow-up and return its text (null when gone). */
  take(id: string): string | null {
    const item = this.queued.find((q) => q.id === id);
    if (!item) return null;
    this.queued = this.queued.filter((q) => q !== item);
    this.emit();
    return item.text;
  }

  /** Move a queued follow-up into the running turn. */
  promote(id: string): void {
    if (!this.channel || !this.busy) return;
    const text = this.take(id);
    if (text !== null) this.steer(text);
  }

  /** Pull the last queued follow-up back out for editing. */
  recallLast(): string | null {
    const last = this.queued[this.queued.length - 1];
    return last ? this.take(last.id) : null;
  }

  /** Drop everything (a new chat or a reset). */
  clear(): void {
    this.queued = [];
    this.steering = [];
    this.emit();
  }

  private makeId(): string {
    this.nextId += 1;
    return `pending-${this.nextId}`;
  }

  private emit(): void {
    this.snapshot = {
      queued: this.queued,
      steering: this.steering.map(({ id, text }) => ({ id, text })),
      canSteer: this.busy && this.channel !== null,
    };
    for (const listener of this.listeners) listener();
  }

  // Deferred so the owner's turn-end handler finishes before the next turn
  // starts, and coalesced so two idle signals never send two messages.
  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    if (this.busy || this.settling > 0) return;
    const head = this.queued[0];
    if (!head) return;
    this.queued = this.queued.slice(1);
    this.emit();
    this.send(head.text);
  }
}

/** The mid-turn surface a chat hands to its composer. */
export interface MidTurnQueue extends SteerQueueSnapshot {
  steer: (text: string) => void;
  queue: (text: string) => void;
  promote: (id: string) => void;
  /** Removes the follow-up from the queue and returns its text. */
  edit: (id: string) => string | null;
  remove: (id: string) => void;
  recallLast: () => string | null;
}

/** Bind a snapshot to the store it came from. The store is looked up lazily so
 *  a caller may resolve it per call (e.g. the displayed session's). */
export function midTurnOf(
  getStore: () => SteerQueue | null,
  snapshot: SteerQueueSnapshot,
): MidTurnQueue {
  return {
    ...snapshot,
    steer: (text) => getStore()?.steer(text),
    queue: (text) => getStore()?.enqueue(text),
    promote: (id) => getStore()?.promote(id),
    edit: (id) => getStore()?.take(id) ?? null,
    remove: (id) => {
      getStore()?.take(id);
    },
    recallLast: () => getStore()?.recallLast() ?? null,
  };
}

export const EMPTY_STEER_SNAPSHOT = EMPTY;

export type MidTurnKeyAction = "steer" | "queue" | "recall" | null;

/**
 * What a composer keystroke does to mid-turn input. While a turn runs, Enter
 * steers (or queues, in a chat that cannot steer) and Tab queues; Up in an
 * empty composer pulls the last queued follow-up back for editing.
 */
export function midTurnKeyAction(
  key: { key: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean },
  ctx: { streaming: boolean; draft: string; canSteer: boolean; queuedCount: number },
): MidTurnKeyAction {
  if (key.altKey || key.ctrlKey || key.metaKey || key.shiftKey) return null;
  const hasDraft = ctx.draft.trim().length > 0;
  if (key.key === "Enter" && ctx.streaming && hasDraft) return ctx.canSteer ? "steer" : "queue";
  if (key.key === "Tab" && ctx.streaming && hasDraft) return "queue";
  if (key.key === "ArrowUp" && ctx.draft === "" && ctx.queuedCount > 0) return "recall";
  return null;
}

/** Append an edited follow-up to whatever is already in the draft. */
export function appendToDraft(draft: string, text: string): string {
  return draft.trim() ? `${draft.replace(/\s+$/, "")}\n${text}` : text;
}
