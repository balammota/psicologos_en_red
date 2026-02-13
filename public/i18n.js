/**
 * Psicólogos en Red - Traducciones ES / EN
 * Idioma por defecto: es. Cambio con banderas en el header.
 */
(function () {
    const TRANSLATIONS = {
        es: {
            // Navegación común
            nav_inicio: "Inicio",
            nav_psicologos: "Psicólogos",
            nav_academia: "Academia",
            nav_mi_perfil: "Mi Perfil",
            nav_psicoterapia_online: "Psicoterapia Online",
            nav_academia_virtual: "Academia Virtual",
            nav_asesoria_crianza: "Asesoría de Crianza",
            nav_proximamente: "Próximamente",
            // Footer común
            footer_tagline: "Conectando salud mental con tecnología humana. Tu bienestar es nuestra prioridad.",
            footer_enlaces_rapidos: "Enlaces Rápidos",
            footer_contacto: "Contacto",
            footer_inicio: "Inicio",
            footer_registro: "Registro",
            footer_iniciar_sesion: "Iniciar Sesión",
            footer_terminos: "Términos y Condiciones",
            footer_aviso_privacidad: "Aviso de Privacidad",
            footer_trabaja: "Trabaja con Nosotros",
            footer_derechos: "Todos los derechos reservados.",
            // Index - Hero
            index_hero_title: "Psicólogos En Red",
            index_hero_subtitle: "Salud Emocional",
            index_hero_title_prefix: "Tu camino hacia el ",
            index_hero_bienestar: "bienestar emocional",
            index_hero_desc: "Descubre un espacio seguro para explorar, sanar y crecer con el apoyo de profesionales expertos en salud mental.",
            index_hero_cta_primary: "Agendar Ahora",
            index_hero_cta_secondary: "Conocer Más",
            index_servicios_desc: "Ofrecemos una amplia gama de servicios terapéuticos adaptados a tus necesidades específicas.",
            // Index - Servicios
            index_servicios_titulo: "Nuestros Servicios",
            index_servicio_online_titulo: "Psicoterapia Online",
            index_servicio_online_texto: "Psicoterapia en línea con especialistas: apoyo profesional, seguro, accesible y confidencial para ansiedad, depresión, estrés, entre otros retos emocionales.",
            index_servicio_online_cta: "Agendar Ahora →",
            index_servicio_academia_titulo: "Academia Virtual",
            index_servicio_academia_texto: "Cursos y diplomados en línea para psicólogos y estudiantes, fortaleciendo competencias con enfoque ético actualizado.",
            index_servicio_academia_cta: "Explorar diplomados →",
            index_servicio_crianza_titulo: "Asesoría de Crianza",
            index_servicio_crianza_texto: "Asesoría en crianza con psicólogos: espacio seguro, herramientas prácticas, vínculo familiar y acompañamiento consciente real.",
            index_servicio_crianza_cta: "Agendar Ahora →",
            index_muy_pronto: "Muy pronto",
            index_disponible_fase: "Disponible en la siguiente fase",
            // Index - Sobre nosotros
            index_sobre_nosotros: "Sobre Nosotros",
            index_sobre_titulo: "Humanizando la terapia a través de la tecnología",
            index_sobre_parrafo_1: "Psicólogos en Red nació en 2020 para ofrecer acompañamiento emocional de calidad a distancia. Creemos que el bienestar emocional es un derecho fundamental: por eso eliminamos barreras geográficas con tecnología y creamos espacios seguros donde la confidencialidad y el respeto son pilares de cada intervención.",
            index_sobre_parrafo_2: "Nuestra metodología integra evidencia científica con terapia personalizada y formación continua para profesionales. Estamos comprometidos con generar un impacto positivo en la salud mental colectiva, construyendo una comunidad donde la empatía y la innovación transforman vidas de manera real y duradera.",
            index_conocemos: "Conócenos",
            index_equipo_sub: "Nuestro equipo",
            index_equipo_titulo: "Conoce a nuestro equipo",
            index_cifra: "+1000",
            index_vidas: "Vidas transformadas",
            // Index - Slider
            index_slider_diplomados: "Próximos Diplomados",
            index_slider_diplomados_texto: "Conoce nuestros diplomados en Estructuras Clínicas y Clínica del Trauma. Algunos de los contenidos incluyen el estudio de neurocisis, psicosis, perversión y técnicas para evaluar e intervenir en casos de trauma psicológico.",
            index_slider_agenda: "Agenda tu Cita",
            index_slider_agenda_texto: "Accede a atención psicológica profesional desde donde estés. Elige a tu terapeuta, selecciona un horario y realiza tu pago en minutos. Todo el proceso es confidencial y 100% en línea.",
            index_slider_psicologos: "Nuestros Psicólogos",
            index_slider_psicologos_texto: "Explora perfiles verificados de profesionales con experiencia en distintas áreas de la salud mental. Todos cuentan con cédula profesional y están comprometidos con una atención ética, empática y personalizada.",
            // Index - Testimonios
            index_testimonios_sub: "Lo que dicen nuestros pacientes",
            index_testimonios_titulo: "Experiencias que transforman",
            index_testimonios_desc: "Historias reales de personas que han transformado sus vidas.",
            index_testimonio_1: "\"La plataforma es súper sencilla de usar. Encontré al psicólogo ideal para mi proceso y las sesiones son de gran calidad.\"",
            index_testimonio_2: "\"Me encanta la privacidad que ofrece. Poder tomar mi terapia desde casa con esta comodidad me ha cambiado la vida.\"",
            index_testimonio_3: "\"Como profesional, la red me permite organizar mis consultas y llegar a personas que realmente necesitan apoyo.\"",
            index_paciente_desde: "Paciente desde",
            index_psicologo_clinico: "Psicólogo Clínico",
            // Index - FAQ
            index_faq_sub: "Tus dudas resueltas",
            index_faq_titulo: "Preguntas Frecuentes",
            index_faq_desc: "Resolvemos tus dudas más comunes.",
            index_faq_1_pregunta: "¿Cómo elijo al psicólogo adecuado para mí?",
            index_faq_1_respuesta: "Al registrarte, podrás ver los perfiles de nuestros especialistas, sus áreas de enfoque y años de experiencia para que elijas al que mejor se adapte a tus necesidades.",
            index_faq_2_pregunta: "¿Las sesiones de video son privadas?",
            index_faq_2_respuesta: "Absolutamente. Utilizamos una plataforma de videollamadas segura (Daily) con salas privadas por sesión, de modo que nadie más pueda acceder a tu sesión.",
            index_faq_3_pregunta: "¿Qué necesito para mi primera consulta?",
            index_faq_3_respuesta: "Solo necesitas un dispositivo con cámara y micrófono (computadora o celular) y una conexión a internet estable. Recomendamos un lugar tranquilo y privado.",
            index_faq_4_pregunta: "¿Cuáles son los métodos de pago?",
            index_faq_4_respuesta: "Aceptamos tarjetas de crédito, débito y transferencias bancarias. El pago se realiza de forma segura antes de iniciar la sesión.",
            index_cta_title: "¿Estás listo para iniciar tu proceso?",
            index_cta_desc: "Da el primer paso hacia tu bienestar emocional. Agenda una consulta hoy mismo.",
            index_cta_btn: "Agendar Consulta",
            // Modal bienvenida
            modal_bienvenida_pregunta: "¿Eres nuevo o ya conoces nuestros servicios?",
            modal_bienvenida_sub: "Elige la opción que mejor te describa",
            modal_soy_nuevo: "Soy nuevo",
            modal_ya_conozco: "Ya conozco los servicios",
            modal_volver: "Volver",
            modal_que_servicio: "¿Qué servicio estás buscando?",
            modal_que_servicio_sub: "Selecciona una opción",
            modal_terapia_individual: "Terapia individual",
            modal_terapia_pareja: "Terapia de pareja",
            modal_diplomados: "Diplomados para psicólogos",
            modal_bienvenido_vuelta: "Bienvenido de vuelta",
            modal_bienvenido_mensaje: "Seguimos aquí para acompañarte. Tu bienestar emocional es nuestra prioridad.",
            modal_ir_catalogo: "Ir al catálogo",
            modal_cerrar: "Cerrar",
        },
        en: {
            nav_inicio: "Home",
            nav_psicologos: "Psychologists",
            nav_academia: "Academy",
            nav_mi_perfil: "My Profile",
            nav_psicoterapia_online: "Online Psychotherapy",
            nav_academia_virtual: "Virtual Academy",
            nav_asesoria_crianza: "Parenting Support",
            nav_proximamente: "Coming Soon",
            footer_tagline: "Connecting mental health with human technology. Your well-being is our priority.",
            footer_enlaces_rapidos: "Quick Links",
            footer_contacto: "Contact",
            footer_inicio: "Home",
            footer_registro: "Sign Up",
            footer_iniciar_sesion: "Log In",
            footer_terminos: "Terms and Conditions",
            footer_aviso_privacidad: "Privacy Notice",
            footer_trabaja: "Work With Us",
            footer_derechos: "All rights reserved.",
            index_hero_title: "Psychologists In Network",
            index_hero_subtitle: "Emotional Health",
            index_hero_title_prefix: "Your path to ",
            index_hero_bienestar: "emotional well-being",
            index_hero_desc: "Discover a safe space to explore, heal and grow with the support of mental health professionals.",
            index_hero_cta_primary: "Book Now",
            index_hero_cta_secondary: "Learn More",
            index_servicios_desc: "We offer a wide range of therapeutic services tailored to your specific needs.",
            index_servicios_titulo: "Our Services",
            index_servicio_online_titulo: "Online Psychotherapy",
            index_servicio_online_texto: "Online psychotherapy with specialists: professional, safe, accessible and confidential support for anxiety, depression, stress, and other emotional challenges.",
            index_servicio_online_cta: "Book Now →",
            index_servicio_academia_titulo: "Virtual Academy",
            index_servicio_academia_texto: "Online courses and diplomas for psychologists and students, strengthening competencies with an up-to-date ethical focus.",
            index_servicio_academia_cta: "Explore diplomas →",
            index_servicio_crianza_titulo: "Parenting Support",
            index_servicio_crianza_texto: "Parenting support with psychologists: safe space, practical tools, family bonding, and mindful accompaniment.",
            index_servicio_crianza_cta: "Book Now →",
            index_muy_pronto: "Coming Soon",
            index_disponible_fase: "Available in the next phase",
            index_sobre_nosotros: "About Us",
            index_sobre_titulo: "Humanizing therapy through technology",
            index_sobre_parrafo_1: "Psicólogos en Red was born in 2020 to offer quality emotional support at a distance. We believe emotional well-being is a fundamental right: that's why we remove geographic barriers with technology and create safe spaces where confidentiality and respect are pillars of every intervention.",
            index_sobre_parrafo_2: "Our methodology integrates scientific evidence with personalized therapy and ongoing training for professionals. We are committed to generating a positive impact on collective mental health, building a community where empathy and innovation transform lives in real and lasting ways.",
            index_conocemos: "Learn more",
            index_equipo_sub: "Our team",
            index_equipo_titulo: "Meet our team",
            index_cifra: "+1000",
            index_vidas: "Lives transformed",
            index_slider_diplomados: "Upcoming Diplomas",
            index_slider_diplomados_texto: "Learn about our diplomas in Clinical Structures and Trauma Clinic. Content includes the study of neurosis, psychosis, perversion and techniques to assess and intervene in cases of psychological trauma.",
            index_slider_agenda: "Book Your Appointment",
            index_slider_agenda_texto: "Access professional psychological care from wherever you are. Choose your therapist, select a time and complete your payment in minutes. The entire process is confidential and 100% online.",
            index_slider_psicologos: "Our Psychologists",
            index_slider_psicologos_texto: "Explore verified profiles of professionals with experience in different areas of mental health. All hold professional credentials and are committed to ethical, empathetic and personalized care.",
            index_testimonios_sub: "What our patients say",
            index_testimonios_titulo: "Experiences that transform",
            index_testimonios_desc: "Real stories from people who have transformed their lives.",
            index_testimonio_1: "\"The platform is super easy to use. I found the ideal psychologist for my process and the sessions are high quality.\"",
            index_testimonio_2: "\"I love the privacy it offers. Being able to have my therapy from home with this comfort has changed my life.\"",
            index_testimonio_3: "\"As a professional, the network allows me to organize my consultations and reach people who really need support.\"",
            index_paciente_desde: "Patient since",
            index_psicologo_clinico: "Clinical Psychologist",
            index_faq_sub: "Your questions answered",
            index_faq_titulo: "Frequently Asked Questions",
            index_faq_desc: "We answer your most common questions.",
            index_faq_1_pregunta: "How do I choose the right psychologist for me?",
            index_faq_1_respuesta: "When you sign up, you can view our specialists' profiles, their areas of focus and years of experience so you can choose the one that best fits your needs.",
            index_faq_2_pregunta: "Are video sessions private?",
            index_faq_2_respuesta: "Absolutely. We use a secure video platform (Daily) with private rooms per session, so no one else can access your session.",
            index_faq_3_pregunta: "What do I need for my first consultation?",
            index_faq_3_respuesta: "You only need a device with a camera and microphone (computer or phone) and a stable internet connection. We recommend a quiet and private place.",
            index_faq_4_pregunta: "What are the payment methods?",
            index_faq_4_respuesta: "We accept credit cards, debit cards and bank transfers. Payment is made securely before starting the session.",
            index_cta_title: "Ready to start your journey?",
            index_cta_desc: "Take the first step toward your emotional well-being. Book a consultation today.",
            index_cta_btn: "Book Consultation",
            modal_bienvenida_pregunta: "Are you new or do you already know our services?",
            modal_bienvenida_sub: "Choose the option that best describes you",
            modal_soy_nuevo: "I'm new",
            modal_ya_conozco: "I already know the services",
            modal_volver: "Back",
            modal_que_servicio: "What service are you looking for?",
            modal_que_servicio_sub: "Select an option",
            modal_terapia_individual: "Individual therapy",
            modal_terapia_pareja: "Couples therapy",
            modal_diplomados: "Diplomas for psychologists",
            modal_bienvenido_vuelta: "Welcome back",
            modal_bienvenido_mensaje: "We're still here to support you. Your emotional well-being is our priority.",
            modal_ir_catalogo: "Go to catalog",
            modal_cerrar: "Close",
        }
    };

    window.I18n = {
        getLang: function () {
            const lang = (localStorage.getItem('lang') || 'es');
            return lang === 'en' ? 'en' : 'es';
        },
        setLang: function (lang) {
            localStorage.setItem('lang', lang === 'en' ? 'en' : 'es');
            window.location.reload();
        },
        t: function (key) {
            const lang = this.getLang();
            return TRANSLATIONS[lang] && TRANSLATIONS[lang][key] != null ? TRANSLATIONS[lang][key] : (TRANSLATIONS.es[key] || key);
        },
        apply: function () {
            const lang = this.getLang();
            document.documentElement.lang = lang === 'en' ? 'en' : 'es';
            const dict = TRANSLATIONS[lang] || TRANSLATIONS.es;
            document.querySelectorAll('[data-i18n]').forEach(function (el) {
                const key = el.getAttribute('data-i18n');
                const text = dict[key];
                if (text != null) {
                    if (el.getAttribute('data-i18n-html')) {
                        el.innerHTML = text;
                    } else {
                        el.textContent = text;
                    }
                }
            });
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { window.I18n.apply(); });
    } else {
        window.I18n.apply();
    }
})();
