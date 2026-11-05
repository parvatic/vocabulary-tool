// Service worker : l'app, les modèles et le dictionnaire déjà consultés restent disponibles hors ligne.
const VERSION = "v4";
const SHELL = [
  "./", "index.html", "styles.css", "manifest.webmanifest", "icon.svg",
  "js/app.js", "js/ocr.js", "js/ocr-core.js", "js/dict.js", "js/expr.js", "js/store.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Code de l'app : réseau d'abord (pour recevoir les mises à jour), cache si hors ligne.
// Modèles, dictionnaire, ONNX Runtime : cache d'abord (gros fichiers qui ne changent pas).
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  // Autres domaines (CDN d'ONNX Runtime) : le navigateur s'en charge seul. Safari gère mal
  // les modules et WebAssembly d'un autre domaine relayés par un service worker.
  if (url.origin !== self.location.origin) return;
  const heavy = /\/(models|dict)\//.test(url.pathname);
  e.respondWith(heavy ? cacheFirst(e.request) : networkFirst(e.request));
});

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(VERSION)).put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(VERSION)).put(req, res.clone());
    return res;
  } catch {
    return (await caches.match(req)) || Response.error();
  }
}
