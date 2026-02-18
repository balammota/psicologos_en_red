/**
 * En modo app (PWA): pide permiso de notificaciones y muestra burbuja tipo WhatsApp
 * cuando aumenta el número de mensajes no leídos.
 */
(function () {
    function isStandalone() {
        return window.matchMedia('(display-mode: standalone)').matches || !!window.navigator.standalone;
    }

    window.PwaNotifMensajes = {
        lastUnreadCount: -1,
        permissionAsked: false,

        requestPermission: function () {
            if (!isStandalone() || this.permissionAsked || !('Notification' in window)) return;
            this.permissionAsked = true;
            if (Notification.permission === 'default') Notification.requestPermission().catch(function () {});
        },

        maybeShow: function (newCount) {
            if (!isStandalone() || !('Notification' in window) || Notification.permission !== 'granted') return;
            var prev = this.lastUnreadCount;
            this.lastUnreadCount = newCount;
            if (prev >= 0 && newCount > prev) {
                try {
                    var n = new Notification('Psicólogos en Red', {
                        body: newCount === 1 ? 'Tienes un nuevo mensaje' : 'Tienes ' + newCount + ' mensajes nuevos',
                        icon: '/images/logo.png',
                        tag: 'mensaje-psicologos',
                        requireInteraction: false
                    });
                    n.onclick = function () { window.focus(); n.close(); };
                } catch (e) {}
            }
        }
    };
})();
