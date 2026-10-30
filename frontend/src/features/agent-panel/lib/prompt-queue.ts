/*
 * A one-slot mailbox for prompts other features hand to the generalist agent
 * (the first-login setup sends its free-text answers here). The panel loads
 * lazily, so a prompt queued before it mounts waits until it drains the slot.
 */

export const AGENT_PROMPT_EVENT = "agent:queued-prompt";

let pending: string | null = null;

/** Queue `prompt` for the agent and wake a mounted panel. */
export function queueAgentPrompt(prompt: string): void {
  pending = prompt;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(AGENT_PROMPT_EVENT));
}

/** Take the queued prompt, if any, leaving the slot empty. */
export function takeQueuedAgentPrompt(): string | null {
  const prompt = pending;
  pending = null;
  return prompt;
}
