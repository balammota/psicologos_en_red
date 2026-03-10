/**
 * Service Worker mínimo para PWA - Psicólogos en Red
 * No cachea nada: todas las peticiones se reenvían al servidor.
 * Solo permite que el navegador ofrezca "Instalar app" sin cambiar el comportamiento de la web.
 * Si el servidor falla (502, timeout, etc.), no dejamos la promesa rechazada: mostramos fallback o dejamos que el navegador muestre su error.
 */
const CACHE_VERSION = 'v2-passthrough';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request).catch(() => {
      // Fallo de red o servidor: evitar "promise rejected" del FetchEvent.
      // Para la página principal devolvemos una página mínima para que no quede en blanco.
      if (event.request.mode === 'navigate') {
        return new Response(
          '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sin conexión</title></head><body style="font-family:sans-serif;padding:2rem;text-align:center;"><h1>No se pudo cargar la página</h1><p>Revisa tu conexión o intenta más tarde.</p><p><a href="/">Volver a intentar</a></p></body></html>',
          { status: 503, statusText: 'Service Unavailable', headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }
      // Para imágenes, scripts, etc.: devolver respuesta de error controlada en lugar de rechazar
      return new Response('', { status: 503, statusText: 'Service Unavailable' });
    })
  );
});
