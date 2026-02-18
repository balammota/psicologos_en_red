/**
 * Registro del Service Worker para PWA.
 * Solo se ejecuta en contexto seguro (HTTPS o localhost). No modifica el comportamiento de la web.
 */
(function () {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  if (!window.location.protocol.startsWith('http') || (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1' && window.location.protocol !== 'https:')) return;
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {});
})();
