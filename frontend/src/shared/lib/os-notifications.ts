/**
 * OS notifications for work that finishes while the user is away: an agent
 * reply, a code-agent run, a setup check. Browsers only show the permission
 * prompt from a user gesture, so callers ask when the work starts (the send
 * or check the user just clicked) and notify when it ends.
 */

function supported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function requestNotificationPermission(): void {
  if (!supported() || Notification.permission !== "default") return;
  try {
    void Notification.requestPermission().catch(() => undefined);
  } catch {
    // Older Safari only takes the callback form and throws on the promise one.
  }
}

/** Notify only when the app is not in front: the user can already see it otherwise. */
export function notifyUser(title: string): void {
  if (!supported() || Notification.permission !== "granted") return;
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  try {
    const notification = new Notification(title);
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // Chrome on Android refuses page notifications outside a service worker.
  }
}
