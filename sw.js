// ── Service Worker — Attendance PWA ──────────────────────────
const CACHE_NAME = "attendance-v1";
const CACHE_FILES = [
  "/",
  "/index.html",
  "/manifest.json",
];

// Install — Cache files
self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_FILES))
  );
  self.skipWaiting();
});

// Activate — Old cache clean karo
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — Network first, cache fallback
self.addEventListener("fetch", e => {
  // API calls cache mat karo
  if (e.request.url.includes("worldtimeapi.org") ||
      e.request.url.includes("api.")) {
    return;
  }
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
