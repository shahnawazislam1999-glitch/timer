// Presence Study Tracker — offline-first service worker.
//
// Goals of this file:
//  1) Cache the app shell so the PWA loads with zero network after install.
//  2) Cache every file the on-device AI (MediaPipe) needs, from BOTH a
//     primary (jsdelivr) and backup (unpkg) CDN, so a single flaky fetch
//     during first-time setup can't leave the app unable to run offline.
//  3) Be honest about whether offline AI setup actually finished — never
//     claim "ready" unless everything the app needs is truly in the cache.
//  4) Never re-attempt network fetches for files that are already cached,
//     so every relaunch after the first successful setup touches the
//     network zero times.

const CACHE_NAME = 'presence-study-tracker-v11-reliable-offline';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './alarm.mp3'
];

const MP_VERSION = '0.10.35';
const JSDELIVR_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const UNPKG_BASE = `https://unpkg.com/@mediapipe/tasks-vision@${MP_VERSION}`;

// The two .tflite model files have no alternate mirror in this app, so both
// are always required for offline readiness.
const MODEL_URLS = [
  'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
  'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite'
];

// Two independent, equivalent copies of the MediaPipe WASM runtime. The app
// only needs ONE complete copy (its .mjs bundle plus a working SIMD or
// non-SIMD wasm pair) to run offline — see isMirrorComplete() below. index.html
// tries the jsdelivr copy first and falls back to unpkg automatically.
const MIRRORS = [
  {
    bundle: `${JSDELIVR_BASE}/vision_bundle.mjs`,
    wasmSimd: [`${JSDELIVR_BASE}/wasm/vision_wasm_internal.js`, `${JSDELIVR_BASE}/wasm/vision_wasm_internal.wasm`],
    wasmNoSimd: [`${JSDELIVR_BASE}/wasm/vision_wasm_nosimd_internal.js`, `${JSDELIVR_BASE}/wasm/vision_wasm_nosimd_internal.wasm`]
  },
  {
    bundle: `${UNPKG_BASE}/vision_bundle.mjs`,
    wasmSimd: [`${UNPKG_BASE}/wasm/vision_wasm_internal.js`, `${UNPKG_BASE}/wasm/vision_wasm_internal.wasm`],
    wasmNoSimd: [`${UNPKG_BASE}/wasm/vision_wasm_nosimd_internal.js`, `${UNPKG_BASE}/wasm/vision_wasm_nosimd_internal.wasm`]
  }
];

const AI_RESOURCES = [
  ...MODEL_URLS,
  ...MIRRORS.flatMap(m => [m.bundle, ...m.wasmSimd, ...m.wasmNoSimd])
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Cache each local asset independently so one optional/missing file can
    // never prevent the PWA shell (especially alarm.mp3) from being installed.
    await Promise.all(SHELL.map(async url => {
      try {
        const response = await fetch(url, { cache: 'no-store' });
        if (response && response.ok) await cache.put(url, response.clone());
      } catch (error) {
        console.warn('Shell cache failed:', url, error);
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch a single AI resource and cache it, retrying transient failures.
// Returns true once the resource is confirmed to be in the cache (either it
// already was, or this call put it there).
async function cacheOneResource(cache, url) {
  const existing = await cache.match(url);
  if (existing) return true;

  const ATTEMPTS = 3;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const request = new Request(url, { cache: 'no-store', mode: 'cors' });
      const response = await fetch(request);
      if (response && (response.ok || response.type === 'opaque')) {
        await cache.put(url, response.clone());
        return true;
      }
    } catch (error) {
      console.warn(`AI cache attempt ${attempt}/${ATTEMPTS} failed:`, url, error);
    }
    if (attempt < ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, 500 * attempt));
    }
  }
  return false;
}

async function allCached(cache, urls) {
  for (const url of urls) {
    if (!(await cache.match(url))) return false;
  }
  return true;
}

async function isMirrorComplete(cache, mirror) {
  if (!(await cache.match(mirror.bundle))) return false;
  if (await allCached(cache, mirror.wasmSimd)) return true;
  return allCached(cache, mirror.wasmNoSimd);
}

// The single source of truth for "can the app run its AI fully offline right
// now?" — used both after a caching pass and for instant, network-free
// status checks on later launches.
async function checkAIReadiness() {
  const cache = await caches.open(CACHE_NAME);
  const modelsOk = await allCached(cache, MODEL_URLS);
  let runtimeOk = false;
  for (const mirror of MIRRORS) {
    if (await isMirrorComplete(cache, mirror)) {
      runtimeOk = true;
      break;
    }
  }
  return { ready: modelsOk && runtimeOk, modelsOk, runtimeOk };
}

async function notifyClients(message) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach(client => client.postMessage(message));
}

async function cacheAIResources() {
  const cache = await caches.open(CACHE_NAME);
  let done = 0;
  const failed = [];

  for (const url of AI_RESOURCES) {
    const ok = await cacheOneResource(cache, url);
    if (!ok) failed.push(url);
    done++;
    await notifyClients({ type: 'AI_CACHE_PROGRESS', done, total: AI_RESOURCES.length });
  }

  const readiness = await checkAIReadiness();
  await notifyClients({
    type: 'AI_CACHE_READY',
    done,
    total: AI_RESOURCES.length,
    allReady: readiness.ready,
    modelsOk: readiness.modelsOk,
    runtimeOk: readiness.runtimeOk,
    failed
  });
}

self.addEventListener('message', event => {
  if (event.data?.type === 'PRECACHE_AI') {
    event.waitUntil(cacheAIResources());
  } else if (event.data?.type === 'CHECK_AI_READY') {
    event.waitUntil((async () => {
      const readiness = await checkAIReadiness();
      event.source?.postMessage({ type: 'AI_READY_STATUS', ...readiness });
    })());
  }
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // alarm.mp3: always prefer the cached full file. Browsers may request
  // media with a Range header; matching a clean Request avoids a cache miss
  // caused by that header and keeps the alarm playable without internet.
  if (url.origin === self.location.origin && url.pathname.endsWith('/alarm.mp3')) {
    event.respondWith((async () => {
      const cleanRequest = new Request(url.href, { method: 'GET' });
      const cached = await caches.match(cleanRequest);
      if (cached) return cached;
      try {
        const response = await fetch(cleanRequest);
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(cleanRequest, copy)).catch(() => {});
        }
        return response;
      } catch (error) {
        return new Response('Offline alarm audio is not cached yet.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' }
        });
      }
    })());
    return;
  }

  // App shell: cache first, then network, then cached index as offline fallback.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return fetch(req).then(response => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, copy)).catch(() => {});
          }
          return response;
        }).catch(() => caches.match('./index.html'));
      })
    );
    return;
  }

  // AI resources: cache first, network only as a fallback (and only if online).
  const isAIResource =
    url.hostname === 'cdn.jsdelivr.net' ||
    url.hostname === 'unpkg.com' ||
    url.hostname === 'storage.googleapis.com';

  if (isAIResource) {
    event.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return fetch(req).then(response => {
          if (response && (response.ok || response.type === 'opaque')) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, copy)).catch(() => {});
          }
          return response;
        });
      })
    );
  }
});
