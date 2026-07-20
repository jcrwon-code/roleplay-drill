// Service worker for fully-offline use: on install, fetch precache-manifest.json
// (a generated list of every file in this app -- HTML/JS/CSS/JSON/mp3s) and
// cache all of them in batches. After that, serve everything cache-first so
// the drill works with zero network connection, anywhere.

const CACHE_NAME = "roleplay-v11";
const BATCH_SIZE = 40;

async function cacheAllInBatches(cache, urls) {
  for (let i = 0; i < urls.length; i += BATCH_SIZE) {
    const batch = urls.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map((url) =>
        cache.add(url).catch((err) => console.warn("Failed to cache", url, err))
      )
    );
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const manifestRes = await fetch("precache-manifest.json");
      const urls = await manifestRes.json();
      await cacheAllInBatches(cache, urls);
      self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
      self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    (async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      try {
        const response = await fetch(event.request);
        const cache = await caches.open(CACHE_NAME);
        cache.put(event.request, response.clone());
        return response;
      } catch (err) {
        return cached || Response.error();
      }
    })()
  );
});
