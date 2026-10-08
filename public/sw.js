/**
 * gritos offline app shell (issue #104, phase 2) — a hand-rolled service
 * worker, no plugin: the shell is one document plus hashed assets, so the
 * whole worker is install/activate/fetch and nothing more.
 *
 * Served from ./sw.js so its scope covers subpath deployments (GitHub Pages
 * project sites, issue #40): the bundle registers './sw.js' relative to the
 * page URL, and every cache key below resolves against this script's own
 * URL — the worker contains no origin- or path-pinned absolute URL at all.
 *
 * Scope (issue #104): the shell only. Same-origin precached assets are
 * served cache-first; everything else is none of this worker's business —
 * cross-origin requests (the wss: tracker sockets first among them) fall
 * through untouched and nothing is ever cached at runtime.
 *
 * The two placeholders below are rewritten by the gritosSwManifest() Vite
 * plugin (vite.config.ts) into the dist copy: the cache version is a
 * content digest, so every build whose served content changed becomes a new
 * `gritos-shell-v…` cache and the previous ones are deleted on activation.
 * This public/ source keeps the placeholder form; dist/sw.js is generated.
 */

// Build-time placeholder — replaced with e.g. 'gritos-shell-v0f1e2d3c4b5a'.
const CACHE_VERSION = '__GRITOS_CACHE_VERSION__'

// Build-time placeholder — the quoted string (brackets included, the
// assignment is not wrapped in an array literal) is replaced with the JSON
// array of shell URLs: the offline document, the manifest, the static
// public assets and the exact hashed build outputs of this very build.
const PRECACHE_URLS = '__GRITOS_PRECACHE_URLS__'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      // skipWaiting: with no update toast yet (phase 4) a waiting worker
      // would leave every deploy one visit behind on clients that never
      // navigate away. The activate handler cleans up behind it.
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('gritos-shell-') && key !== CACHE_VERSION)
            .map((key) => caches.delete(key)),
        ),
      )
      // Take control of open pages immediately, first visit included.
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  // Cross-origin requests are out of scope by design: fall through with no
  // respondWith, so the request is served (and cached) by nobody here.
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // Navigations get the cached offline shell: room URLs differ only in
  // their fragment, so the one document covers them all.
  if (request.mode === 'navigate') {
    event.respondWith(caches.match('./index.html').then((cached) => cached || fetch(request)))
    return
  }

  // Cache-first for the precached shell assets; a same-origin miss goes to
  // the network and is never added to the cache.
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)))
})
