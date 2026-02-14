(function () {
    'use strict';

    var apiUrl = '/api/chat';
    var history = [];

    var wrap = document.createElement('div');
    wrap.className = 'chat-widget-wrap';
    var rediAvatar = '/images/redi_foto_perfil.png';
    wrap.innerHTML =
        '<button type="button" class="chat-widget-btn" aria-label="Abrir chat">' +
        '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12c0 1.54.36 3 .97 4.29L2 22l5.71-.97C9 21.64 10.46 22 12 22c5.52 0 10-4.48 10-10S17.52 2 12 2z"/></svg>' +
        '</button>' +
        '<div class="chat-widget-panel" id="chat-widget-panel" role="dialog" aria-label="Chat con Redi">' +
        '<div class="chat-widget-header">' +
        '<img class="chat-widget-header-avatar" src="' + rediAvatar + '" alt="" onerror="this.style.display=\'none\'; this.nextElementSibling && (this.nextElementSibling.style.display=\'block\');">' +
        '<svg class="chat-widget-header-icon-fallback" viewBox="0 0 24 24" fill="currentColor" style="display:none;"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>' +
        '<span>Redi</span>' +
        '</div>' +
        '<div class="chat-widget-messages" id="chat-widget-messages"></div>' +
        '<div class="chat-widget-input-wrap">' +
        '<input type="text" class="chat-widget-input" id="chat-widget-input" placeholder="Escribe tu pregunta..." maxlength="500" autocomplete="off">' +
        '<button type="button" class="chat-widget-send" id="chat-widget-send" aria-label="Enviar">' +
        '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>' +
        '</button>' +
        '</div>' +
        '</div>';
    document.body.appendChild(wrap);

    var btn = wrap.querySelector('.chat-widget-btn');
    var panel = document.getElementById('chat-widget-panel');
    var messagesEl = document.getElementById('chat-widget-messages');
    var inputEl = document.getElementById('chat-widget-input');
    var sendBtn = document.getElementById('chat-widget-send');

    function escapeHtml(s) {
        var div = document.createElement('div');
        div.textContent = s;
        return div.innerHTML;
    }
    function linkify(text) {
        var re = /(https?:\/\/[^\s<]+)/g;
        var parts = text.split(re);
        var out = '';
        for (var i = 0; i < parts.length; i++) {
            if (parts[i].match(re)) out += '<a href="' + escapeHtml(parts[i]) + '" target="_blank" rel="noopener noreferrer" class="chat-widget-msg-link">' + escapeHtml(parts[i]) + '</a>';
            else out += escapeHtml(parts[i]);
        }
        return out;
    }
    function addMessage(text, role, opts) {
        opts = opts || {};
        var isBot = (opts.className || role).indexOf('bot') !== -1 || role === 'bot';
        var row = document.createElement('div');
        row.className = isBot ? 'chat-widget-msg-row chat-widget-msg-row-bot' : 'chat-widget-msg-row';
        var div = document.createElement('div');
        div.className = 'chat-widget-msg ' + (opts.className || role);
        if (isBot && text) {
            div.innerHTML = linkify(text);
        } else {
            div.textContent = text;
        }
        if (opts.whatsappUrl) {
            var link = document.createElement('a');
            link.href = opts.whatsappUrl;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.className = 'chat-widget-wa-link';
            link.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.865 9.865 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg> Escribir por WhatsApp';
            div.appendChild(document.createElement('br'));
            div.appendChild(link);
        }
        if (isBot) {
            var av = document.createElement('img');
            av.className = 'chat-widget-bot-avatar';
            av.src = rediAvatar;
            av.alt = 'Redi';
            av.onerror = function () { this.style.display = 'none'; };
            row.appendChild(av);
        }
        row.appendChild(div);
        messagesEl.appendChild(row);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function setLoading(show) {
        var existing = messagesEl.querySelector('.chat-widget-typing-row');
        if (existing) existing.remove();
        if (show) {
            var row = document.createElement('div');
            row.className = 'chat-widget-msg-row chat-widget-msg-row-bot chat-widget-typing-row';
            var av = document.createElement('img');
            av.className = 'chat-widget-bot-avatar';
            av.src = rediAvatar;
            av.alt = 'Redi';
            av.onerror = function () { this.style.display = 'none'; };
            var typing = document.createElement('div');
            typing.className = 'chat-widget-typing';
            typing.textContent = 'Escribiendo';
            row.appendChild(av);
            row.appendChild(typing);
            messagesEl.appendChild(row);
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }
    }

    function send() {
        var text = (inputEl.value || '').trim();
        if (!text) return;
        inputEl.value = '';
        sendBtn.disabled = true;
        addMessage(text, 'user');
        history.push({ role: 'user', content: text });
        setLoading(true);
        fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text, history: history.slice(-10) })
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                setLoading(false);
                if (data.fallback && data.whatsappUrl) {
                    addMessage(data.message || 'Para más información, contáctanos por WhatsApp.', 'bot', {
                        className: 'bot fallback',
                        whatsappUrl: data.whatsappUrl
                    });
                    history.push({ role: 'assistant', content: data.message });
                } else {
                    var reply = (data.text || '').trim() || 'No pude generar una respuesta. ¿Quieres que te pasemos con un especialista por WhatsApp?';
                    addMessage(reply, 'bot');
                    history.push({ role: 'assistant', content: reply });
                }
            })
            .catch(function () {
                setLoading(false);
                addMessage('No se pudo conectar. Para recibir respuesta, dirígete con nuestros especialistas por WhatsApp.', 'bot', {
                    className: 'bot fallback',
                    whatsappUrl: 'https://wa.me/5215530776194'
                });
            })
            .finally(function () {
                sendBtn.disabled = false;
            });
    }

    btn.addEventListener('click', function () {
        panel.classList.toggle('open');
        if (panel.classList.contains('open')) {
            inputEl.focus();
            if (messagesEl.children.length === 0) {
                addMessage('Hola, soy Redi, tu asistente de Psicólogos en Red. ¿En qué puedo ayudarte? Puedes preguntarme por horarios, cómo agendar una cita, servicios, precios o que te recomiende un especialista según lo que busques.', 'bot');
            }
        }
    });
    sendBtn.addEventListener('click', send);
    inputEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') send();
    });
})();
