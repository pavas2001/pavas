// Pixberry service worker: caches the app shell so staff screens and the menu page load during short internet drops.
const CACHE = 'pixberry-v1';
const SHELL = ['/assets/app.css', '/assets/lib.js', '/assets/staff.js', '/assets/icon.svg', '/admin/index.html', '/admin/admin.css', '/admin/app.js', '/admin/ui.js', '/kds/index.html', '/kds/kds.js', '/order/index.html', '/order/order.css', '/order/order.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/r/')) return;
  // network first, fall back to cache (so updates show up immediately when online)
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok && (url.pathname.match(/\.(js|css|svg|html)$/) || ['/admin', '/kds'].includes(url.pathname))) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(async () => (await caches.match(e.request)) || (url.pathname.startsWith('/order/') ? caches.match('/order/index.html') : url.pathname.startsWith('/kds') ? caches.match('/kds/index.html') : caches.match('/admin/index.html'))));
});
