// Meals: the app shell and Pyodide cached so the planner opens fast and offline.
const VERSION = "m1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(caches.keys()
  .then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k !== "pyodide").map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (u.hostname === "cdn.jsdelivr.net" && u.pathname.startsWith("/pyodide/")) {   // versioned: cache first, forever
    e.respondWith(caches.open("pyodide").then((c) => c.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
      if (r.ok) c.put(e.request, r.clone());
      return r;
    }))));
    return;
  }
  if (u.origin !== location.origin || u.pathname.includes("/api/")) return;
  e.respondWith(fetch(e.request).then((r) => {   // our own files: network first so updates land, cache when offline
    if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
