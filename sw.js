// Service worker for fully-offline use: on install, fetch precache-manifest.json
// (a generated list of every file in this app -- HTML/JS/CSS/JSON/mp3s).
// The small app-shell files (JS/CSS/HTML/JSON) are cached immediately so the
// app is usable right away. The (much larger) mp3 set is cached afterwards,
// throttled in small batches with pauses between them, so bulk-caching
// thousands of audio files doesn't saturate the connection and starve
// foreground requests (that's what made first use feel frozen/slow on a
// weaker device/network -- see PROJECT_LOG.md).

const CACHE_NAME = "roleplay-v17";
const APP_SHELL_BATCH_SIZE = 10;
const AUDIO_BATCH_SIZE = 6;
const AUDIO_BATCH_DELAY_MS = 250;

async function cacheAllInBatches(cache, urls, batchSize, delayMs = 0) {
  for (let i = 0; i < urls.length; i += batchSize) {
    const batch = urls.slice(i, i + batchSize);
    await Promise.all(
      batch.map((url) =>
        cache.add(url).catch((err) => console.warn("Failed to cache", url, err))
      )
    );
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const manifestRes = await fetch("precache-manifest.json");
      const urls = await manifestRes.json();
      const audioUrls = urls.filter((u) => u.endsWith(".mp3"));
      const shellUrls = urls.filter((u) => !u.endsWith(".mp3"));

      // App shell first, fast, no throttling -- this is what makes the app
      // itself (menus, scenario list, current scenario's own audio via the
      // regular fetch handler below) usable immediately.
      await cacheAllInBatches(cache, shellUrls, APP_SHELL_BATCH_SIZE);
      self.skipWaiting();

      // Full audio library caches in the background, throttled, so it
      // doesn't compete with whatever the user is actively doing.
      await cacheAllInBatches(cache, audioUrls, AUDIO_BATCH_SIZE, AUDIO_BATCH_DELAY_MS);
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
