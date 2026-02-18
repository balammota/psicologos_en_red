(function () {
    function init() {
        var btn = document.getElementById('btn-pantalla-completa-video');
        var cont = document.getElementById('jitsi-container');
        if (!btn || !cont) return;

        var xBtn = null;
        var pseudoFs = false;
        var isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth <= 768;

        function isNativeFullscreen() {
            return !!(document.fullscreenElement || document.webkitFullscreenElement);
        }

        function isFullscreen() {
            return isNativeFullscreen() || pseudoFs;
        }

        function updateLabel() {
            btn.textContent = isFullscreen() ? '✕ Salir de pantalla completa' : '⛶ Pantalla completa';
        }

        function addXButton() {
            if (xBtn && xBtn.parentNode) return;
            xBtn = document.createElement('button');
            xBtn.type = 'button';
            xBtn.className = 'jitsi-fs-cerrar';
            xBtn.setAttribute('aria-label', 'Salir de pantalla completa');
            xBtn.innerHTML = '✕';
            xBtn.style.display = 'flex';
            xBtn.addEventListener('click', exitFullscreen);
            cont.appendChild(xBtn);
        }

        function removeXButton() {
            if (xBtn && xBtn.parentNode) {
                xBtn.parentNode.removeChild(xBtn);
                xBtn = null;
            }
        }

        function exitFullscreen() {
            if (isNativeFullscreen()) {
                (document.exitFullscreen || document.webkitExitFullscreen).call(document);
            }
            if (pseudoFs) {
                document.body.classList.remove('video-pseudo-fullscreen');
                pseudoFs = false;
                removeXButton();
                updateLabel();
            }
        }

        function onFullscreenChange() {
            updateLabel();
            if (isNativeFullscreen()) {
                addXButton();
            } else {
                removeXButton();
            }
        }

        function enterPseudoFullscreen() {
            document.body.classList.add('video-pseudo-fullscreen');
            pseudoFs = true;
            addXButton();
            updateLabel();
        }

        document.addEventListener('fullscreenchange', onFullscreenChange);
        document.addEventListener('webkitfullscreenchange', onFullscreenChange);

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && isFullscreen()) {
                e.preventDefault();
                e.stopPropagation();
                exitFullscreen();
            }
        }, true);

        btn.addEventListener('click', function () {
            if (isFullscreen()) {
                exitFullscreen();
                return;
            }
            if (isMobile) {
                enterPseudoFullscreen();
                return;
            }
            (cont.requestFullscreen || cont.webkitRequestFullscreen).call(cont);
        });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
