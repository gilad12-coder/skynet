"use client";

import * as React from "react";
import { getAgentEngine, updateAgentEngine } from "@/shared/lib/api";
import { isLocalMode } from "@/shared/lib/runtime-env";
import { OPENROUTER_ENGINE, isAgentEngine, type AgentEngine } from "../lib/subscription-model";

// Only this select changes the engine, so one load per page is enough. A
// failed load is not cached, so the next caller tries again.
let cached: { engine: AgentEngine | null } | null = null;
let inflight: Promise<AgentEngine | null> | null = null;
const listeners = new Set<() => void>();

function setCached(engine: AgentEngine | null) {
  cached = { engine };
  listeners.forEach((notify) => notify());
}

function asEngine(value: unknown): AgentEngine | null {
  return isAgentEngine(value) ? value : null;
}

/**
 * The caller's agent engine (`GET /account/agent-engine`), shared between
 * every caller. Hosted builds always run on OpenRouter and never call the
 * route. A local engine is null when none was chosen and no CLI is ready, or
 * when the load failed; callers then fall back to their own default.
 */
export function loadAgentEngine(): Promise<AgentEngine | null> {
  if (!isLocalMode()) return Promise.resolve(OPENROUTER_ENGINE);
  if (cached) return Promise.resolve(cached.engine);
  if (inflight) return inflight;
  const promise = getAgentEngine()
    .then(({ engine: raw }) => {
      const engine = asEngine(raw);
      setCached(engine);
      return engine;
    })
    .catch(() => null)
    .finally(() => {
      if (inflight === promise) inflight = null;
    });
  inflight = promise;
  return promise;
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
