/**
 * Service worker: hace que la app y el mapa funcionen sin internet.
 * Debe estar en la RAÍZ de lo que quieras controlar (en GitHub Pages,
 * dentro de la carpeta del repo: /usuario.github.io/mi-repo/sw.js).
 *
 * Sube VERSION cada vez que cambies el código: fuerza la actualización.
 */
const VERSION = 'v1';
const SHELL_CACHE = 'shell-' + VERSION;
const TILE_CACHE = 'tiles';       // sin versión: las teselas no caducan
const MAX_TILES = 30000;          // tope alto: un área urbana al z18 son ~7.000 teselas

// Rutas relativas para que funcione en el subdirectorio de GitHub Pages.
const SHELL_ASSETS = [
  './',
  './mapa.html',
  './geolocation.service.js',
  './map-archive.js',
  './offline-layer.js',
  './manifest.json',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png'
];

const TILE_HOSTS = [
  'tile.openstreetmap.org',
  'server.arcgisonline.com'
];

/* ---------- instalación ---------- */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // addAll falla entero si un recurso falla; los agregamos uno a uno.
      .then(cache => Promise.all(
        SHELL_ASSETS.map(url =>
          cache.add(url).catch(err => console.warn('[sw] no se cacheó', url, err))
        )
      ))
      .then(() => self.skipWaiting())
  );
});

/* ---------- activación: limpia versiones viejas ---------- */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(nombres => Promise.all(
        nombres
          .filter(n => n.startsWith('shell-') && n !== SHELL_CACHE)
          .map(n => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

/* ---------- estrategia de red ---------- */
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Teselas: caché primero. Una foto satelital no cambia de un día a otro
  // y en el campo es lo único que tenemos.
  if (TILE_HOSTS.some(h => url.hostname.endsWith(h))) {
    event.respondWith(cacheFirst(req, TILE_CACHE, true));
    return;
  }

  // Resto de la app: caché primero, refrescando en segundo plano si hay red.
  event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
});

async function cacheFirst(req, cacheName, recortar) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;

  try {
    const res = await fetch(req);
    if (res.ok || res.type === 'opaque') {
      cache.put(req, res.clone());
      if (recortar) trim(cacheName, MAX_TILES);
    }
    return res;
  } catch (err) {
    // Sin red y sin caché: devolvemos una tesela gris en vez de romper el mapa.
    return new Response(TESELA_VACIA, { headers: { 'Content-Type': 'image/svg+xml' } });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);

  const red = fetch(req)
    .then(res => { if (res.ok) cache.put(req, res.clone()); return res; })
    .catch(() => hit);

  return hit || red;
}

/** Borra las entradas más antiguas cuando la caché crece demasiado (FIFO). */
async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

const TESELA_VACIA =
  '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">' +
  '<rect width="256" height="256" fill="#16202B"/>' +
  '<text x="128" y="128" fill="#3A4B5F" font-family="sans-serif" font-size="12" ' +
  'text-anchor="middle">sin descargar</text></svg>';
