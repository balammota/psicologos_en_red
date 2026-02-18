/**
 * Service Worker mínimo para PWA - Psicólogos en Red
 * No cachea nada: todas las peticiones se reenvían al servidor.
 * Solo permite que el navegador ofrezca "Instalar app" sin cambiar el comportamiento de la web.
 */
const CACHE_VERSION = 'v1-passthrough';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
