const CACHE_NAME = 'handleliste-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/manifest.json',
  '/products.js',
  'https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:wght@300;400;500&display=swap'
];

// Install event - cache assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(urlsToCache).catch(() => {
        // Hvis noen URLs feiler, continue without them (OK for offline)
        return Promise.resolve();
      });
    })
  );
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Skip Firebase API calls (let them go through network)
  if (request.url.includes('firebaseapp.com') || 
      request.url.includes('googleapis.com') ||
      request.url.includes('firestore.googleapis.com')) {
    return;
  }

  // Cache first for static assets
  if (request.url.includes('.js') || 
      request.url.includes('.css') || 
      request.url.includes('fonts.googleapis')) {
    event.respondWith(
      caches.match(request).then((response) => {
        return response || fetch(request).then((response) => {
          // Cache successful responses
          if (response && response.status === 200) {
            const responseToCache = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseToCache);
            });
          }
          return response;
        });
      }).catch(() => {
        // Offline fallback
        return new Response('Offline - vedlegg ikke tilgjengelig', {
          status: 503,
          statusText: 'Service Unavailable',
        });
      })
    );
    return;
  }

  // Network first for HTML and API calls
  event.respondWith(
    fetch(request).then((response) => {
      // Cache successful HTML responses
      if (response && response.status === 200 && request.url.endsWith('/')) {
        const responseToCache = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(request, responseToCache);
        });
      }
      return response;
    }).catch(() => {
      // Try cache as fallback
      return caches.match(request).then((response) => {
        if (response) {
          return response;
        }
        // Return offline page if nothing is cached
        return caches.match('/index.html').catch(() => {
          return new Response('Offline - siden er ikke cached', {
            status: 503,
            statusText: 'Service Unavailable',
          });
        });
      });
    })
  );
});
