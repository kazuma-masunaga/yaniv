/*
 * Yaniv service worker.
 * - Same-origin GET: network-first with cache: 'no-cache' (fresh deploys win when online, even
 *   behind the HTTP cache), cache fallback when offline. Navigations fall back to the cached shell
 *   after 3.5 s without a response, and are keyed without the query string.
 * - Static CDN GET (PeerJS on unpkg, Google Fonts): stale-while-revalidate; never throws.
 * - Everything else is left untouched: non-GET, non-http(s), and other cross-origin requests
 *   (notably the PeerJS signalling server 0.peerjs.com, whose /id endpoint must never be cached).
 * Bump VERSION when the precache list changes; old caches are deleted on activate.
 */
'use strict';
var VERSION = 'yaniv-v2';
var RUNTIME = VERSION + '-cdn';
var CDN_HOSTS = ['unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
var PRECACHE = [
  './',
  './index.html',
  './engine.js',
  './net.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon.svg'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(VERSION)
      .then(function (cache) { return cache.addAll(PRECACHE.map(function (u) { return new Request(u, { cache: 'reload' }); })); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          if (k !== VERSION && k !== RUNTIME) return caches.delete(k);
          return null;
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

var NAV_TIMEOUT_MS = 3500;

/** Revalidate with the server, bypassing the browser HTTP cache (GitHub Pages sends max-age=600). */
function fresh(request) {
  return fetch(new Request(request, { cache: 'no-cache' }));
}
function store(key, res) {
  if (res && res.ok && res.type === 'basic') {
    var copy = res.clone();
    return caches.open(VERSION).then(function (c) { return c.put(key, copy); }).catch(function () { /* ignore */ });
  }
  return Promise.resolve();
}
/** Navigations are cached under origin + pathname so ?room=XXXX links do not pile up copies of the HTML. */
function navKey(request) {
  var u = new URL(request.url);
  return u.origin + u.pathname;
}

// Subresources (engine.js, net.js, icons, ...): network-first, cache when offline.
function networkFirst(request) {
  return fresh(request).then(function (res) {
    store(request, res);
    return res;
  }, function () {
    return caches.match(request).then(function (hit) { return hit || Response.error(); });
  });
}

// Navigations: network-first, but give up waiting after NAV_TIMEOUT_MS when a cached shell exists
// (weak signal). The network fetch keeps going and refreshes the cache if it succeeds later.
function navigate(event) {
  var key = navKey(event.request);
  var net = fresh(event.request).then(function (res) {
    return store(key, res).then(function () { return res; });
  });
  event.waitUntil(net.catch(function () { /* ignore */ }));
  var cached = function () {
    return caches.match(key).then(function (hit) { return hit || caches.match('./index.html'); });
  };
  return new Promise(function (resolve) {
    var done = false;
    function finish(res) { if (!done) { done = true; clearTimeout(timer); resolve(res); } }
    var timer = setTimeout(function () {
      cached().then(function (hit) { if (hit) finish(hit); /* no cache: keep waiting for the network */ });
    }, NAV_TIMEOUT_MS);
    net.then(finish, function () {
      cached().then(function (hit) { finish(hit || Response.error()); });
    });
  });
}

function staleWhileRevalidate(event) {
  var request = event.request;
  return caches.open(RUNTIME).then(function (cache) {
    return cache.match(request).then(function (hit) {
      var update = fetch(request).then(function (res) {
        // opaque (no-cors <script>/<link>) responses report status 0; cache them as well
        if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone()).catch(function () { /* ignore */ });
        return res;
      }).catch(function () { return null; });
      if (hit) {
        event.waitUntil(update);
        return hit;
      }
      return update.then(function (res) { return res || Response.error(); });
    });
  }).catch(function () {
    return fetch(request).catch(function () { return Response.error(); });
  });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (request.headers.get('upgrade')) return; // never touch WebSocket-like requests
  if (url.origin === self.location.origin) {
    event.respondWith(request.mode === 'navigate' ? navigate(event) : networkFirst(request));
  } else if (CDN_HOSTS.indexOf(url.hostname) >= 0) {
    event.respondWith(staleWhileRevalidate(event));
  }
});
