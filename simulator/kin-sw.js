// Network-only: never persist family records, bearer tokens, or OAuth callbacks.
// Only workspace document navigations get this public, data-free fallback.
const offline = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reconnect — Kin</title></head><body><main><h1>Kin needs a connection.</h1><p>Your family plan is not available offline. Reconnect to see the latest check-ins.</p><p>No changes were submitted from this screen.</p><a href="/invite.html">Try again</a></main></body></html>`;
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || event.request.mode !== "navigate"
    || url.origin !== self.location.origin || url.pathname !== "/invite.html"
    || url.search) return;
  event.respondWith(fetch(event.request).catch(() => new Response(offline, {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
    },
  })));
});

self.addEventListener("push", event => {
  let message;
  try { message = event.data?.json(); } catch { return; }
  if (message?.version !== 1 || !/^[A-Za-z0-9_-]{32}$/.test(message.tag ?? "")) return;
  const test = message.kind === "connection_test";
  event.waitUntil(self.registration.showNotification(test ? "Kin · Test notification" : "Kin · You're on today", {
    body: test ? "Your Kin phone connection test. No care action is needed." : "A check-in needs a follow-up. Open Kin to review it.",
    tag: `kin-${message.tag}`, icon: "/kin-icon.png",
    // No care data or server-supplied destination stored in the notification.
    data: { path: "/invite.html#today" },
  }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const destination = new URL("/invite.html#today", self.location.origin).href;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      const url = new URL(client.url);
      if (url.origin === self.location.origin && url.pathname === "/invite.html" && !url.search) {
        await client.navigate(destination); await client.focus(); return;
      }
    }
    await self.clients.openWindow(destination);
  })());
});
