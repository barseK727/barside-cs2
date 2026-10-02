const CACHE = 'barside-v1';
const ASSETS = [
    '/',
    '/index.html',
    '/css/style.css'
];

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {}));
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(caches.keys().then(keys =>
        Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ));
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);
    // Не кешируем API и auth
    if (url.pathname.startsWith('/api') || url.pathname.startsWith('/api/auth')) return;

    e.respondWith(
        fetch(e.request).then(res => {
            if (e.request.method === 'GET' && res.ok) {
                const clone = res.clone();
                caches.open(CACHE).then(c => c.put(e.request, clone));
            }
            return res;
        }).catch(() => caches.match(e.request))
    );
});