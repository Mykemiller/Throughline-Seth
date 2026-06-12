/* Minimal service worker — install/activate only. The live voice loop must
   never be cached or intercepted; we deliberately do not add fetch caching. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
