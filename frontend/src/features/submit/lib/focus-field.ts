/**
 * Move focus to a wizard field after a stage switch. The stage view animates
 * in, so the lookup waits a beat for the target to mount.
 */
const STAGE_SWITCH_MS = 80;

export function focusField(id: string): void {
  if (typeof window === "undefined") return;
  window.setTimeout(() => {
    const element = document.getElementById(id);
    if (!(element instanceof HTMLElement)) return;
    element.scrollIntoView({ block: "center", behavior: "smooth" });
    element.focus({ preventScroll: true });
  }, STAGE_SWITCH_MS);
}
