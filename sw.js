/* The Hundred — service worker (only active when the app is hosted, e.g. on GitHub Pages).

   Strategy (HackerWeb's "instant repeat visits", made update-safe):
   - The app's own files are served from cache immediately, so repeat visits open instantly
     and work offline.
   - On every visit it re-checks all of those files in the background (cheap: the server
     answers "not modified" when nothing changed). If any file changed, the complete new set
     is stored together and the page shows "A new version is ready · Reload". Files are never
     mixed between versions, and nothing can stay stale for more than one visit.
   - Hacker News / Algolia / reader requests are not touched here; the app caches that data
     itself in IndexedDB.
   Paths are relative to wherever the app is hosted (e.g. /your-repo/). */

const CACHE = 'hundred-app';
const FILES = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest', 'icon.svg',
  'fmt.js', 'store.js', 'api.js', 'anim.js', 'state.js',
  'view-list.js', 'view-thread.js', 'view-search.js', 'view-profile.js', 'view-split.js', 'app.js'
];
const urls = FILES.map((f) => new URL(f, self.registration.scope).href);
let lastCheck = 0;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(urls.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;            // APIs: straight to the network
  const isPage = req.mode === 'navigate';
  const key = isPage ? new URL('index.html', self.registration.scope).href : url.origin + url.pathname;
  if (!isPage && !urls.includes(key)) return;

  event.respondWith(
    caches.open(CACHE).then((cache) => cache.match(key).then((hit) => {
      if (isPage) event.waitUntil(checkForUpdate());
      return hit || fetch(req).then((res) => {
        if (res.ok) cache.put(key, res.clone());
        return res;
      });
    }))
  );
});

// Re-check every app file; if anything changed, store the full new set, then tell the page.
async function checkForUpdate() {
  if (Date.now() - lastCheck < 60000) return;
  lastCheck = Date.now();
  try {
    const cache = await caches.open(CACHE);
    const fresh = await Promise.all(urls.map((u) => fetch(u, { cache: 'no-cache' })));
    if (fresh.some((r) => !r.ok)) return;                       // offline or partial: keep what we have
    let changed = false;
    const bodies = await Promise.all(fresh.map((r) => r.clone().text()));
    for (let i = 0; i < urls.length; i++) {
      const old = await cache.match(urls[i]);
      if (!old || (await old.text()) !== bodies[i]) { changed = true; break; }
    }
    if (!changed) return;
    await Promise.all(urls.map((u, i) => cache.put(u, fresh[i])));
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((c) => c.postMessage({ type: 'update-ready' }));
  } catch (e) {
    // Network trouble: try again on a later visit.
  }
}
