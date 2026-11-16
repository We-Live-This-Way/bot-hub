// Bot Hub service worker: caches the app shell only, so the installed app opens fast and shows something offline.
// Never touches /api/, /mcp or anything with a key: those always go straight to the network and are never stored.
const CACHE = "bot-hub-shell-v2";
const SHELL = ["/", "/join", "/join-request.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/mcp" || req.headers.has("authorization")) return; // network only
  const path = url.pathname === "/index.html" ? "/" : url.pathname.replace(/\/$/, "") || "/";
  if (!SHELL.includes(path)) return;
  // Network first (always fresh when online), cached copy when offline. The URL's #fragment (sign-in keys) never reaches here.
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(path, copy)); }
    return res;
  }).catch(() => caches.match(path)));
});
