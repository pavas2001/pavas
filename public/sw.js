// Pixberry service worker: caches the app shell so staff screens and the menu page load during short internet drops.
const CACHE = 'pixberry-v3';
const SHELL = ['/assets/app.css', '/assets/lib.js', '/assets/staff.js', '/assets/icon.svg', '/admin/index.html', '/admin/admin.css', '/admin/app.js', '/admin/ui.js', '/kds/index.html', '/kds/kds.js', '/order/index.html', '/order/order.css', '/order/order.js', '/signal/index.html', '/signal/display.js', '/signal/app.html', '/signal/app.js', '/signal/common.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/r/')) return;
  // network first, fall back to cache (so updates show up immediately when online)
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok && (url.pathname.match(/\.(js|css|svg|html)$/) || ['/admin', '/kds', '/signal', '/signal/app'].includes(url.pathname))) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(async () => (await caches.match(e.request)) || (url.pathname.startsWith('/order/') ? caches.match('/order/index.html') : url.pathname.startsWith('/kds') ? caches.match('/kds/index.html') : url.pathname.startsWith('/signal/app') ? caches.match('/signal/app.html') : url.pathname.startsWith('/signal') ? caches.match('/signal/index.html') : caches.match('/admin/index.html'))));
});

// Signal request alerts (Web Push). If the staff app is open on screen it shows its own banner instead.
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Pixberry Signal', body: e.data?.text() || '' }; }
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    if (list.some(c => c.focused && new URL(c.url).pathname.startsWith('/signal'))) return;
    return self.registration.showNotification(d.title || 'Pixberry Signal', {
      body: d.body || '', tag: d.tag || 'signal', renotify: true, icon: '/assets/icon.svg', badge: '/assets/icon.svg',
      vibrate: [150, 80, 150], data: { url: d.url || '/signal/app' },
    });
  }));
});
// Tapping an alert opens (or focuses) the staff app
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = e.notification.data?.url || '/signal/app';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => new URL(c.url).pathname.startsWith('/signal/app'));
    return open ? open.focus() : self.clients.openWindow(target);
  }));
});
