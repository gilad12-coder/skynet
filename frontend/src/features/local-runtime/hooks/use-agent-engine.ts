"use client";

import * as React from "react";
import { getAgentEngine, updateAgentEngine } from "@/shared/lib/api";
import { isLocalMode } from "@/shared/lib/runtime-env";
import { OPENROUTER_ENGINE, isAgentEngine, type AgentEngine } from "../lib/subscription-model";

// With no stored engine the backend picks the first ready CLI, which changes
// when a CLI signs out or hits its cap. So each CLI status refresh marks the
// engine stale (refreshAgentEngine). A failed load is not cached, so the next
// caller tries again, and a failed reload keeps the last loaded engine.
let cached: { engine: AgentEngine | null; stale: boolean } | null = null;
let inflight: Promise<AgentEngine | null> | null = null;
// Bumped by every save, so a load that started before a save cannot overwrite it.
let saves = 0;
const listeners = new Set<() => void>();

function setCached(engine: AgentEngine | null) {
  cached = { engine, stale: false };
  listeners.forEach((notify) => notify());
}

function asEngine(value: unknown): AgentEngine | null {
  return isAgentEngine(value) ? value : null;
}

/**
 * The caller's agent engine (`GET /account/agent-engine`), shared between
 * every caller. Hosted builds always run on OpenRouter and never call the
 * route. A local engine is null when none was chosen and no CLI is ready, or
 * when the first load failed; callers then fall back to their own default. A
 * failed reload returns the last loaded engine.
 */
export function loadAgentEngine(): Promise<AgentEngine | null> {
  if (!isLocalMode()) return Promise.resolve(OPENROUTER_ENGINE);
  if (cached && !cached.stale) return Promise.resolve(cached.engine);
  if (inflight) return inflight;
  const startSaves = saves;
  const promise = getAgentEngine()
    .then(({ engine: raw }) => {
      if (startSaves !== saves && cached) return cached.engine;
      const engine = asEngine(raw);
      setCached(engine);
      return engine;
    })
    .catch(() => cached?.engine ?? null)
    .finally(() => {
      if (inflight === promise) inflight = null;
    });
  inflight = promise;
  return promise;
}

/**
 * Load the engine again after a CLI status refresh, so an engine the user never
 * chose follows the backend's pick. It does nothing before the first load.
 */
export function refreshAgentEngine(): void {
  if (!isLocalMode() || !cached) return;
  cached = { ...cached, stale: true };
  void loadAgentEngine();
}

/** The last engine any caller loaded, for code outside React. */
export function peekAgentEngine(): AgentEngine | null {
  if (!isLocalMode()) return OPENROUTER_ENGINE;
  return cached?.engine ?? null;
}

/**
 * Store the caller's engine (`PUT /account/agent-engine`). It throws an
 * `ApiError` with the backend's translated message when the backend refuses
 * the engine.
 */
export async function saveAgentEngine(engine: AgentEngine): Promise<AgentEngine | null> {
  const saved = asEngine((await updateAgentEngine(engine)).engine);
  saves += 1;
  setCached(saved);
  return saved;
}

/** The caller's agent engine, re-rendering when any caller loads or saves it. */
export function useAgentEngine(): {
  engine: AgentEngine | null;
  save: (engine: AgentEngine) => Promise<AgentEngine | null>;
} {
  const [, rerender] = React.useReducer((n: number) => n + 1, 0);

  React.useEffect(() => {
    listeners.add(rerender);
    void loadAgentEngine();
    return () => {
      listeners.delete(rerender);
    };
  }, []);

  return { engine: peekAgentEngine(), save: saveAgentEngine };
}
