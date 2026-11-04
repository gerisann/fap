/* TribeMap service worker: the app opens offline and static files come from the cache.
   Pages: network first (a new deploy shows at once), the cached copy only when offline.
   Hashed assets, crests, flags, icons: cache first (a new version gets a new name, or is fine to keep a while).
   Everything else (Firestore, map tiles, fixtures, analytics, other sites) is not touched. */
const VERSION = "v1", PAGES = "tm-pages-" + VERSION, STATIC = "tm-static-" + VERSION, MAX_STATIC = 600;
const isStatic = p => /^\/(assets|logos|flags|icons)\//.test(p) || p === "/manifest.webmanifest";

self.addEventListener("install", e => {
  e.waitUntil(caches.open(PAGES).then(c => c.add("/")).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith("tm-") && k !== PAGES && k !== STATIC).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function page(req) {
  const c = await caches.open(PAGES);
  try {
    const res = await fetch(req);
    if (res.ok) c.put(req.url.includes("/t/") ? "/" : req, res.clone()); // /t/<id> is the app itself (hosting rewrite)
    return res;
  } catch (_) {
    return (await c.match(req, { ignoreSearch: true })) || (await c.match("/")) || Response.error();
  }
}
async function asset(req) {
  const c = await caches.open(STATIC), hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    await c.put(req, res.clone());
    const keys = await c.keys(); // oldest first: old builds' assets and rarely seen crests go
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_STATIC))) await c.delete(k);
  }
  return res;
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith("/__/")) return; // Firebase's own auth/init paths
  if (req.mode === "navigate") e.respondWith(page(req));
  else if (isStatic(url.pathname)) e.respondWith(asset(req));
});
