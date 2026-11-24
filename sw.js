// Only public application code belongs in Cache Storage. Private API data stays in IndexedDB.
const CACHE = 'reading-terminal-shell-v7';
const FILES = ['./', './index.html', './styles.css', './favicon.svg', './favicon.ico', './js/app.js', './js/reader.js', './js/library.js', './js/notes.js', './js/markdown.js', './js/store.js', './js/demo.js', './js/model.js', './js/modes.js', './js/triage.js', './js/edition.js', './js/edition-view.js', './js/connections.js', './js/progress.js', './js/bot.js', './js/auth.js', './js/vault.js', './js/passkey.js', './js/session.js', './js/vault-api.js'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('reading-terminal-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Vault reads and direct navigations are network-only, never an index.html fallback.
  if (url.pathname === new URL('./vault.json', self.registration.scope).pathname) return;
  const shell = FILES.some(file => new URL(file, self.registration.scope).pathname === url.pathname);
  if (!shell) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy))); }
    return response;
  }).catch(async () => {
    const cached = await caches.match(event.request);
    return cached || (event.request.mode === 'navigate' ? caches.match(new URL('./index.html', self.registration.scope).href) : Response.error());
  }));
});
