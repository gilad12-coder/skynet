/*
 * Web push service worker: shows the notifications the backend's Chrome
 * channel sends ({ title, body, url, tag }) and opens the run they are about
 * when one is clicked. It caches nothing and never touches fetches.
 */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: event.data ? event.data.text() : "" };
  }
  const title = typeof data.title === "string" && data.title ? data.title : "Skynet";
  const options = {
    body: typeof data.body === "string" ? data.body : "",
    icon: "/notification-icon.png",
    badge: "/notification-icon.png",
    data: { url: typeof data.url === "string" && data.url ? data.url : "/" },
  };
  // The same run and event replace the shown notification instead of stacking.
  if (typeof data.tag === "string" && data.tag) {
    options.tag = data.tag;
    options.renotify = true;
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const sameOrigin = windows.filter((client) => new URL(client.url).origin === self.location.origin);
      // A tab already on that page is focused; otherwise a new one opens, so
      // a tab mid-way through a form is never navigated away from it.
      const exact = sameOrigin.find((client) => client.url === target.href);
      if (exact) return exact.focus();
      return self.clients.openWindow(target.href);
    })(),
  );
});
