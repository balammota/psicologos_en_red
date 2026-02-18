/**
 * En modo PWA instalada (standalone): ocultar Inicio y Academia, logo lleva a catálogo.
 */
(function () {
    var isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
        (window.navigator.standalone === true) ||
        (document.referrer.includes('android-app://'));
    if (!isStandalone) return;

    document.body.classList.add('pwa-standalone');

    // Logo del header: que lleve al catálogo
    var logo = document.querySelector('.main-header .logo[href="/"]');
    if (logo) logo.setAttribute('href', '/catalogo');

    // Ocultar "Inicio" y "Academia" en la navegación principal
    document.querySelectorAll('.main-nav a[href="/"], .main-nav a[href="/academia"]').forEach(function (a) {
        var li = a.closest('li');
        if (li) li.style.display = 'none';
    });

    // Ocultar "Inicio" en el footer si existe
    document.querySelectorAll('footer a[href="/"], .footer-bottom a[href="/"]').forEach(function (a) {
        var li = a.closest('li');
        if (li) li.style.display = 'none';
    });

    // En perfil/panel: "Volver al Sitio" → "Ver especialistas" y enlace al catálogo
    document.querySelectorAll('a[href="/"].perfil-mobile-nav-link').forEach(function (a) {
        a.setAttribute('href', '/catalogo');
        a.textContent = '👥 Ver especialistas';
    });
    document.querySelectorAll('a[href="/"].nav-item-link').forEach(function (a) {
        a.setAttribute('href', '/catalogo');
        var label = a.querySelector('.nav-label');
        if (label) label.textContent = 'Ver especialistas';
        var icon = a.querySelector('.nav-icon');
        if (icon) icon.textContent = '👥';
    });
    // Login/registro: "Volver al inicio" que lleve al catálogo
    document.querySelectorAll('a[href="/"].back-link').forEach(function (a) {
        a.setAttribute('href', '/catalogo');
    });
})();
