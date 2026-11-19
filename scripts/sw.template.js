/*
 * 善款簿 service worker: makes the app open without internet.
 * scripts/build.js fills in VERSION (from package.json) and ASSETS (every file in out/) and
 * writes the result to out/sw.js, so phones pick up the new files after every build.
 * It only caches the app's own files. Records live in localStorage and are never touched here.
 */
const VERSION = '__VERSION__';
const CACHE = 'dana-ledger-' + VERSION;
// './' is the page itself (index.html). Cache it as './', never './index.html': Cloudflare
// redirects /index.html to /, and a browser refuses to open a page from a redirected response.
const ASSETS = __ASSETS__;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('dana-ledger-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // Any page inside the app opens the cached app shell.
    event.respondWith(caches.match('./').then((hit) => hit || fetch(req)));
    return;
  }
  event.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
});
