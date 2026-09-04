/** Move focus after an animated stage switch without guessing its duration. */
export function focusField(id: string): void {
  if (typeof window === "undefined") return;
  let frames = 0;
  const focus = () => {
    const element =
      document.getElementById(id) ?? document.querySelector(`[data-tutorial="${CSS.escape(id)}"]`);
    if (!(element instanceof HTMLElement)) {
      if (++frames < 30) window.requestAnimationFrame(focus);
      return;
    }
    const target = element.matches(
      "input, textarea, select, button, [tabindex], [contenteditable=true]",
    )
      ? element
      : (element.querySelector<HTMLElement>(
          "input, textarea, select, button, [tabindex], [contenteditable=true]",
        ) ?? element);
    if (!target.hasAttribute("tabindex") && target === element) target.tabIndex = -1;
    element.scrollIntoView({
      block: "center",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
    target.focus({ preventScroll: true });
  };
  window.requestAnimationFrame(focus);
}
