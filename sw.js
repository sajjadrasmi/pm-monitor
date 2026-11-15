// Offline support: app files are cached; updates are picked up on the next start.
const CACHE = 'pm-monitor-v2.2.0';
const FILES = ['./', 'index.html', 'styles.css', 'config.js', 'manifest.webmanifest',
  'js/app.js', 'js/devices.js', 'js/parser.js', 'js/stats.js', 'js/report.js', 'js/xlsx.js', 'js/backend-firebase.js',
  'vendor/firebase.js', 'vendor/chart.umd.js', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Network first for our own files (so updates arrive), cache as fallback when offline.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;  // Firebase traffic is not touched
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
