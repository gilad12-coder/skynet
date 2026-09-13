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

/** True while the user is looking at this tab: it is the foreground tab and its window holds OS focus. */
function tabInForeground(): boolean {
  return (
    typeof document !== "undefined" &&
    document.visibilityState === "visible" &&
    document.hasFocus()
  );
}

/** Notify only when the user is away; alerting the tab they are already reading is pure noise. */
export function notifyUser(title: string): void {
  if (!supported() || Notification.permission !== "granted") return;
  if (tabInForeground()) return;
  try {
    // The OS shows the browser as the sender; the site's mark rides along as the image.
    const notification = new Notification(title, { icon: "/notification-icon.png" });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // Chrome on Android refuses page notifications outside a service worker.
  }
}
