/* Offline shell only. Do not cache /d/ data paths. */
const SHELL = ["/", "./", "./index.html", "./app.css", "./app.js", "./chart.js", "./manifest.json"];
const CACHE = "desk-shell-v1";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Never cache Plan B data directories or API
  if (url.pathname.includes("/d/") || url.pathname.startsWith("/api/")) {
    return;
  }
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).catch(() => caches.match("./index.html")))
  );
});
