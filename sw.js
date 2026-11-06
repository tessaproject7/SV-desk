/* Offline shell only. Do not cache /d/ or /live/ data paths. */
const SHELL = ["./index.html", "./", "./app.css", "./app.js", "./chart.js", "./manifest.json"];
const CACHE = "desk-shell-v3";

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then(async (c) => {
      for (const u of SHELL) {
        try {
          await c.add(u);
        } catch (_) {}
      }
    }).then(() => self.skipWaiting())
  );
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});
self.addEventListener("message", (e) => {
  if (e.data === "skipWaiting") self.skipWaiting();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (
    url.pathname.includes("/d/") ||
    url.pathname.includes("/live/") ||
    url.pathname.startsWith("/api/")
  ) {
    return;
  }
  const path = url.pathname;
  const isShell =
    path.endsWith("/app.js") ||
    path.endsWith("/app.css") ||
    path.endsWith("/chart.js") ||
    path.endsWith("/sw.js") ||
    path.endsWith("/manifest.json") ||
    path.endsWith("/index.html") ||
    path.endsWith("/SV-desk/") ||
    path.endsWith("/SV-desk");
  if (isShell) {
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return r;
        })
        .catch(() => caches.match(e.request).then((hit) => hit || caches.match("./index.html")))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).catch(() => caches.match("./index.html")))
  );
});
