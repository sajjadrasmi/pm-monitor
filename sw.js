const C='pm-3.0.0',F=['./','index.html','s.css','a.js','firebase.js','chart.umd.js','manifest.webmanifest','icon-192.png','icon-512.png'],X='https://cdn.jsdelivr.net/';
self.addEventListener('install',e=>e.waitUntil(caches.open(C).then(c=>c.addAll(F)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET')return;
if(u.href.startsWith(X)){e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(n=>{if(n.ok){const c=n.clone();caches.open(C).then(x=>x.put(e.request,c))}return n})));return}
if(u.origin!==location.origin)return;
e.respondWith(fetch(e.request).then(n=>{if(n.ok){const c=n.clone();caches.open(C).then(x=>x.put(e.request,c))}return n}).catch(()=>caches.match(e.request,{ignoreSearch:true}).then(r=>r||caches.match('index.html'))))});