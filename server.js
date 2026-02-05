// 1. IMPORTACIONES (dotenv primero para cargar variables de entorno)
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const session = require('express-session');
const multer = require('multer');
const mammoth = require('mammoth');
const pool = require('./db'); 
const { hasHadAppointment } = require('./utils/dbHelpers'); 

/** Marca como 'no realizada' las citas pasadas que siguen pendientes/confirmadas (nadie se unió) */
async function marcarCitasNoRealizadas() {
    await pool.query(`
        UPDATE citas
        SET estado = 'no realizada'
        WHERE estado IN ('pendiente', 'confirmada')
          AND (fecha + hora) < NOW()
    `);
}
const app = express();
const nodemailer = require('nodemailer');
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const twilio = require('twilio');

// WhatsApp (Twilio): número desde el que se envían los mensajes de citas
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const _waFrom = process.env.WHATSAPP_FROM || '+525530776194';
const WHATSAPP_FROM = _waFrom.startsWith('whatsapp:') ? _waFrom : 'whatsapp:' + (_waFrom.startsWith('+') ? _waFrom : '+' + _waFrom.replace(/\D/g, ''));
const twilioClient = (TWILIO_SID && TWILIO_TOKEN) ? twilio(TWILIO_SID, TWILIO_TOKEN) : null;

/** Normaliza teléfono a E.164 para WhatsApp (México +52 por defecto). */
function normalizarTelefonoE164(telefono) {
    if (!telefono || typeof telefono !== 'string') return null;
    const digits = telefono.replace(/\D/g, '');
    if (digits.length < 10) return null;
    if (digits.length === 10) return '+52' + digits;
    if (digits.length === 12 && digits.startsWith('52')) return '+' + digits;
    if (digits.length === 11 && digits.startsWith('52')) return '+' + digits;
    if (digits.length >= 10) return '+52' + digits.slice(-10);
    return null;
}

/** Envía un mensaje WhatsApp (Twilio). Si no hay cliente configurado o teléfono, no hace nada. */
async function enviarWhatsapp(telefono, mensaje) {
    if (!twilioClient || !mensaje) return;
    const to = normalizarTelefonoE164(telefono);
    if (!to) return;
    try {
        await twilioClient.messages.create({
            from: WHATSAPP_FROM,
            to: to.startsWith('+') ? 'whatsapp:' + to : 'whatsapp:+' + to,
            body: mensaje
        });
    } catch (e) {
        console.error('Error enviando WhatsApp:', e.message);
    }
}

// Webhook Stripe debe recibir body sin parsear (para verificar firma)
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!stripe || !endpointSecret || !process.env.STRIPE_SECRET_KEY) {
        return res.status(400).send('Webhook no configurado');
    }
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const { paciente_id, psicologo_id, fecha, hora } = session.metadata || {};
        if (paciente_id && psicologo_id && fecha && hora) {
            pool.query(
                'INSERT INTO citas (paciente_id, psicologo_id, fecha, hora, link_sesion) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                [paciente_id, psicologo_id, fecha, hora, `/perfil?sala=sesion-${paciente_id}-${psicologo_id}`]
            ).then(async (result) => {
                const cita_id = result.rows[0]?.id || null;
                try { await enviarCorreosCitaAgendada(paciente_id, psicologo_id, fecha, hora, cita_id); } catch (e) { console.error('Error enviando correos cita (webhook):', e); }
                res.status(200).send();
            }).catch(err => {
                console.error('Error creando cita desde webhook:', err);
                res.status(500).send();
            });
            return;
        }
    }
    res.status(200).send();
});

// Configuración de Zoho Mail. En Railway usar EMAIL_USER, EMAIL_PASS. Puerto 587 (STARTTLS) suele funcionar si 465 está bloqueado.
function getEmailTransporter() {
    const port = parseInt(process.env.EMAIL_PORT || '587', 10);
    return nodemailer.createTransport({
        host: process.env.EMAIL_HOST || 'smtp.zoho.com',
        port,
        secure: port === 465,
        auth: {
            user: process.env.EMAIL_USER || 'contacto@psicologosenred.com',
            pass: process.env.EMAIL_PASS || 'Flugufelsarinn18!'
        }
    });
}
const transporter = getEmailTransporter();

// URL base del sitio (emails, Stripe success/cancel). En producción usar tu dominio HTTPS.
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

/** Genera contenido iCalendar (.ics) para añadir/actualizar o cancelar evento en el calendario (Zoho, Google, etc.). */
function generarIcsCita(opciones) {
    const { citaId, fecha, hora, titulo, descripcion, accion } = opciones;
    const uid = citaId ? `cita-${citaId}@psicologosenred.com` : `cita-${opciones.paciente_id}-${opciones.psicologo_id}-${fecha}-${(hora || '').replace(/:/g, '')}@psicologosenred.com`;
    const normFecha = normalizarFechaParaEmail(fecha);
    const horaPart = (hora != null ? String(hora).trim() : '09:00').substring(0, 5);
    const [hh, mm] = horaPart.split(':').map(n => parseInt(n, 10) || 0);
    const pad = (n) => String(n).padStart(2, '0');
    const startDate = new Date(normFecha + 'T' + horaPart + ':00');
    const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
    const dtStart = `${normFecha.replace(/-/g, '')}T${pad(hh)}${pad(mm)}00`;
    const dtEnd = `${endDate.getFullYear()}${pad(endDate.getMonth() + 1)}${pad(endDate.getDate())}T${pad(endDate.getHours())}${pad(endDate.getMinutes())}00`;
    const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const safe = (s) => (s || '').replace(/\r?\n/g, ' ').replace(/[,;\\]/g, '\\$&');
    if (accion === 'cancelar') {
        return [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//Psicólogos en Red//ES',
            'METHOD:CANCEL',
            'BEGIN:VEVENT',
            'UID:' + uid,
            'DTSTAMP:' + now + 'Z',
            'DTSTART:' + dtStart,
            'DTEND:' + dtEnd,
            'SUMMARY:' + safe(titulo || 'Sesión cancelada'),
            'STATUS:CANCELLED',
            'END:VEVENT',
            'END:VCALENDAR'
        ].join('\r\n');
    }
    return [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Psicólogos en Red//ES',
        'METHOD:PUBLISH',
        'BEGIN:VEVENT',
        'UID:' + uid,
        'DTSTAMP:' + now + 'Z',
        'DTSTART:' + dtStart,
        'DTEND:' + dtEnd,
        'SUMMARY:' + safe(titulo || 'Sesión - Psicólogos en Red'),
        'DESCRIPTION:' + safe(descripcion || 'Cita agendada en Psicólogos en Red.'),
        'END:VEVENT',
        'END:VCALENDAR'
    ].join('\r\n');
}

// Normalizar fecha (Date o string de BD) a YYYY-MM-DD para evitar "Invalid Date" en correos
function normalizarFechaParaEmail(fecha) {
    if (fecha == null) return '';
    if (fecha instanceof Date) {
        if (Number.isNaN(fecha.getTime())) return '';
        return fecha.toISOString().slice(0, 10);
    }
    const s = String(fecha).trim();
    const match = s.match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : s.slice(0, 10);
}

// Formatear fecha para mostrar en correo; si falla devuelve "—"
function formatearFechaParaEmail(fecha) {
    const norm = normalizarFechaParaEmail(fecha);
    if (!norm) return '—';
    const d = new Date(norm + 'T12:00:00');
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

// Enviar correos de cita agendada al paciente y al psicólogo (cita_id opcional; si se pasa, el .ics usa UID estable para actualizar/cancelar después)
async function enviarCorreosCitaAgendada(paciente_id, psicologo_id, fecha, hora, cita_id = null) {
    const [pacRow, psiRow] = await Promise.all([
        pool.query('SELECT nombre, email, telefono FROM usuarios WHERE id = $1', [paciente_id]),
        pool.query('SELECT p.nombre, u.email AS usuario_email, u.telefono AS usuario_telefono FROM psicologos p JOIN usuarios u ON p.usuario_id = u.id WHERE p.id = $1', [psicologo_id])
    ]);
    const paciente = pacRow.rows[0];
    let psicologo = psiRow.rows[0] ? { nombre: psiRow.rows[0].nombre, email: psiRow.rows[0].usuario_email, telefono: psiRow.rows[0].usuario_telefono } : null;
    if (!psicologo) {
        const r = await pool.query('SELECT nombre FROM psicologos WHERE id = $1', [psicologo_id]);
        psicologo = r.rows[0] ? { nombre: r.rows[0].nombre, email: null, telefono: null } : null;
    }
    if (!psicologo?.email) {
        try {
            const fallback = await pool.query('SELECT email FROM psicologos WHERE id = $1', [psicologo_id]);
            if (fallback.rows[0]?.email) psicologo.email = fallback.rows[0].email;
        } catch (_) {}
    }
    if (!paciente?.email || !psicologo?.email) {
        console.warn('enviarCorreosCitaAgendada: falta email paciente o psicólogo', { paciente_id, psicologo_id, tienePaciente: !!paciente?.email, tienePsicologo: !!psicologo?.email });
        return;
    }

    const fechaStr = formatearFechaParaEmail(fecha);
    const horaStr = hora != null ? String(hora).substring(0, 5) : '—';
    const enlaceLogin = BASE_URL + '/login';

    const icsAgendar = generarIcsCita({
        citaId: cita_id,
        paciente_id,
        psicologo_id,
        fecha,
        hora,
        titulo: `Sesión con ${psicologo.nombre || 'Psicólogos en Red'}`,
        descripcion: `Cita agendada. Paciente: ${paciente.nombre || 'Paciente'}. Añade este evento a tu calendario (Zoho, Google, etc.).`,
        accion: 'crear'
    });
    const adjuntoIcs = { filename: 'cita.ics', content: icsAgendar, contentType: 'text/calendar; method=PUBLISH' };

    const htmlPaciente = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="text-align: center; margin-bottom: 30px;">
                <h1 style="color: #c9a0dc;">Psicólogos en Red</h1>
            </div>
            <h2 style="color: #333;">¡Hola ${(paciente.nombre || '').split(' ')[0]}!</h2>
            <p style="color: #666; font-size: 16px;">Es muy valioso que te preocupes por tu bienestar emocional. Has dado un paso importante al agendar tu sesión.</p>
            <p style="color: #666; font-size: 16px;">Aquí están los detalles de tu cita:</p>
            <div style="background: #fdf2f7; padding: 20px; border-radius: 12px; margin: 20px 0;">
                <p style="margin: 8px 0;"><strong>📅 Fecha:</strong> ${fechaStr}</p>
                <p style="margin: 8px 0;"><strong>🕐 Horario:</strong> ${horaStr} hrs</p>
                <p style="margin: 8px 0;"><strong>👤 Especialista:</strong> ${psicologo.nombre || 'Tu psicólogo'}</p>
            </div>
            <p style="color: #666; font-size: 16px;">Puedes ver tus citas y acceder a tu sesión el día acordado desde tu cuenta.</p>
            <div style="text-align: center; margin: 30px 0;">
                <a href="${enlaceLogin}" style="background: linear-gradient(135deg, #c9a0dc 0%, #a0c4e8 100%); color: white; padding: 15px 40px; text-decoration: none; border-radius: 30px; font-size: 16px; font-weight: bold;">Iniciar sesión</a>
            </div>
            <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
            <p style="color: #999; font-size: 12px; text-align: center;">© ${new Date().getFullYear()} Psicólogos en Red.</p>
        </div>`;

    const htmlPsicologo = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="text-align: center; margin-bottom: 30px;">
                <h1 style="color: #c9a0dc;">Psicólogos en Red</h1>
            </div>
            <h2 style="color: #333;">Nueva cita agendada</h2>
            <p style="color: #666; font-size: 16px;">Un paciente ha agendado una sesión contigo. Es una gran señal que se preocupe por su bienestar emocional.</p>
            <div style="background: #fdf2f7; padding: 20px; border-radius: 12px; margin: 20px 0;">
                <p style="margin: 8px 0;"><strong>📅 Fecha:</strong> ${fechaStr}</p>
                <p style="margin: 8px 0;"><strong>🕐 Horario:</strong> ${horaStr} hrs</p>
                <p style="margin: 8px 0;"><strong>👤 Paciente:</strong> ${paciente.nombre || 'Paciente'}</p>
            </div>
            <p style="color: #666; font-size: 16px;">Revisa tu panel para ver tu agenda y el enlace de la sesión.</p>
            <p style="color: #888; font-size: 14px;">📎 Este correo incluye un archivo <strong>cita.ics</strong> para que puedas añadir la cita a tu calendario (Zoho Mail, Google Calendar, Outlook, etc.).</p>
            <div style="text-align: center; margin: 30px 0;">
                <a href="${enlaceLogin}" style="background: linear-gradient(135deg, #c9a0dc 0%, #a0c4e8 100%); color: white; padding: 15px 40px; text-decoration: none; border-radius: 30px; font-size: 16px; font-weight: bold;">Iniciar sesión</a>
            </div>
            <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
            <p style="color: #999; font-size: 12px; text-align: center;">© ${new Date().getFullYear()} Psicólogos en Red.</p>
        </div>`;

    try {
        await transporter.sendMail({
            from: '"Psicólogos en Red" <contacto@psicologosenred.com>',
            to: paciente.email,
            bcc: 'contacto@psicologosenred.com',
            subject: '✅ Cita agendada - Psicólogos en Red',
            html: htmlPaciente,
            attachments: [adjuntoIcs]
        });
    } catch (e) {
        console.error('Error enviando correo cita al paciente:', paciente.email, e.message);
    }
    try {
        await transporter.sendMail({
            from: '"Psicólogos en Red" <contacto@psicologosenred.com>',
            to: psicologo.email,
            bcc: 'contacto@psicologosenred.com',
            subject: '📅 Nueva cita agendada - Psicólogos en Red',
            html: htmlPsicologo,
            attachments: [adjuntoIcs]
        });
    } catch (e) {
        console.error('Error enviando correo cita al psicólogo:', psicologo.email, e.message);
    }
    await enviarWhatsapp(paciente.telefono, `Psicólogos en Red – Cita agendada: ${fechaStr} a las ${horaStr} hrs con ${psicologo.nombre || 'tu psicólogo'}. Iniciar sesión: ${enlaceLogin}`);
    await enviarWhatsapp(psicologo.telefono, `Psicólogos en Red – Nueva cita: ${fechaStr} ${horaStr} hrs con ${paciente.nombre || 'Paciente'}. Iniciar sesión: ${enlaceLogin}`);
}

// Obtener datos de paciente y psicólogo para correos y WhatsApp (reutilizable)
async function obtenerDatosPacienteYPsicologo(paciente_id, psicologo_id) {
    const [pacRow, psiRow] = await Promise.all([
        pool.query('SELECT nombre, email, telefono FROM usuarios WHERE id = $1', [paciente_id]),
        pool.query('SELECT p.nombre, u.email AS usuario_email, u.telefono AS usuario_telefono FROM psicologos p JOIN usuarios u ON p.usuario_id = u.id WHERE p.id = $1', [psicologo_id])
    ]);
    let paciente = pacRow.rows[0] || null;
    let psicologo = psiRow.rows[0] ? { nombre: psiRow.rows[0].nombre, email: psiRow.rows[0].usuario_email, telefono: psiRow.rows[0].usuario_telefono } : null;
    if (!psicologo) {
        const r = await pool.query('SELECT nombre FROM psicologos WHERE id = $1', [psicologo_id]);
        psicologo = r.rows[0] ? { nombre: r.rows[0].nombre, email: null, telefono: null } : null;
    }
    if (psicologo && !psicologo.email) {
        try {
            const fallback = await pool.query('SELECT email FROM psicologos WHERE id = $1', [psicologo_id]);
            if (fallback.rows[0]?.email) psicologo.email = fallback.rows[0].email;
        } catch (_) {}
    }
    return { paciente, psicologo };
}

// Correos cuando se REAGENDA: nuevos datos de la cita a ambos + .ics para actualizar el evento en el calendario
async function enviarCorreosCitaReagendada(paciente_id, psicologo_id, fecha, hora, cita_id = null) {
    const { paciente, psicologo } = await obtenerDatosPacienteYPsicologo(paciente_id, psicologo_id);
    if (!paciente?.email || !psicologo?.email) return;

    const fechaStr = formatearFechaParaEmail(fecha);
    const horaStr = hora != null ? String(hora).substring(0, 5) : '—';
    const enlaceLogin = BASE_URL + '/login';

    const icsReagendar = generarIcsCita({
        citaId: cita_id,
        paciente_id,
        psicologo_id,
        fecha,
        hora,
        titulo: `Sesión reagendada con ${psicologo?.nombre || 'Psicólogos en Red'}`,
        descripcion: `Cita reagendada. Paciente: ${paciente?.nombre || 'Paciente'}. Añade o actualiza este evento en tu calendario.`,
        accion: 'crear'
    });
    const adjuntoIcs = { filename: 'cita.ics', content: icsReagendar, contentType: 'text/calendar; method=PUBLISH' };

    const htmlPaciente = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="text-align: center; margin-bottom: 30px;"><h1 style="color: #c9a0dc;">Psicólogos en Red</h1></div>
            <h2 style="color: #333;">Cita reagendada</h2>
            <p style="color: #666; font-size: 16px;">Tu sesión ha sido reagendada correctamente. Estos son los nuevos datos:</p>
            <div style="background: #fdf2f7; padding: 20px; border-radius: 12px; margin: 20px 0;">
                <p style="margin: 8px 0;"><strong>📅 Nueva fecha:</strong> ${fechaStr}</p>
                <p style="margin: 8px 0;"><strong>🕐 Nuevo horario:</strong> ${horaStr} hrs</p>
                <p style="margin: 8px 0;"><strong>👤 Especialista:</strong> ${psicologo.nombre || 'Tu psicólogo'}</p>
            </div>
            <div style="text-align: center; margin: 30px 0;">
                <a href="${enlaceLogin}" style="background: linear-gradient(135deg, #c9a0dc 0%, #a0c4e8 100%); color: white; padding: 15px 40px; text-decoration: none; border-radius: 30px; font-size: 16px; font-weight: bold;">Iniciar sesión</a>
            </div>
            <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
            <p style="color: #999; font-size: 12px; text-align: center;">© ${new Date().getFullYear()} Psicólogos en Red.</p>
        </div>`;

    const htmlPsicologo = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="text-align: center; margin-bottom: 30px;"><h1 style="color: #c9a0dc;">Psicólogos en Red</h1></div>
            <h2 style="color: #333;">Cita reagendada</h2>
            <p style="color: #666; font-size: 16px;">El paciente <strong>${paciente.nombre || 'Paciente'}</strong> ha reagendado la sesión. Nuevos datos:</p>
            <div style="background: #fdf2f7; padding: 20px; border-radius: 12px; margin: 20px 0;">
                <p style="margin: 8px 0;"><strong>📅 Nueva fecha:</strong> ${fechaStr}</p>
                <p style="margin: 8px 0;"><strong>🕐 Nuevo horario:</strong> ${horaStr} hrs</p>
                <p style="margin: 8px 0;"><strong>👤 Paciente:</strong> ${paciente.nombre || 'Paciente'}</p>
            </div>
            <p style="color: #888; font-size: 14px;">📎 Incluimos un archivo <strong>cita.ics</strong> para actualizar el evento en tu calendario (Zoho, Google, etc.).</p>
            <div style="text-align: center; margin: 30px 0;">
                <a href="${enlaceLogin}" style="background: linear-gradient(135deg, #c9a0dc 0%, #a0c4e8 100%); color: white; padding: 15px 40px; text-decoration: none; border-radius: 30px; font-size: 16px; font-weight: bold;">Iniciar sesión</a>
            </div>
            <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
            <p style="color: #999; font-size: 12px; text-align: center;">© ${new Date().getFullYear()} Psicólogos en Red.</p>
        </div>`;

    try { await transporter.sendMail({ from: '"Psicólogos en Red" <contacto@psicologosenred.com>', to: paciente.email, bcc: 'contacto@psicologosenred.com', subject: '📅 Cita reagendada - Psicólogos en Red', html: htmlPaciente, attachments: [adjuntoIcs] }); } catch (e) { console.error('Error correo reagendo paciente:', e.message); }
    try { await transporter.sendMail({ from: '"Psicólogos en Red" <contacto@psicologosenred.com>', to: psicologo.email, bcc: 'contacto@psicologosenred.com', subject: '📅 Cita reagendada - Psicólogos en Red', html: htmlPsicologo, attachments: [adjuntoIcs] }); } catch (e) { console.error('Error correo reagendo psicólogo:', e.message); }
    await enviarWhatsapp(paciente.telefono, `Psicólogos en Red – Cita reagendada: ${fechaStr} ${horaStr} hrs. Iniciar sesión: ${enlaceLogin}`);
    await enviarWhatsapp(psicologo.telefono, `Psicólogos en Red – Cita reagendada con ${paciente.nombre || 'Paciente'}: ${fechaStr} ${horaStr} hrs. Iniciar sesión: ${enlaceLogin}`);
}

// Correos cuando se CANCELA: al psicólogo info de la cita cancelada; al paciente mensaje de apoyo + reembolso + botón Agendar (catálogo). Incluye .ics de cancelación para quitar el evento del calendario.
async function enviarCorreosCitaCancelada(paciente_id, psicologo_id, fecha, hora, cita_id = null) {
    const { paciente, psicologo } = await obtenerDatosPacienteYPsicologo(paciente_id, psicologo_id);
    if (!paciente?.email || !psicologo?.email) return;

    const fechaStr = formatearFechaParaEmail(fecha);
    const horaStr = hora != null ? String(hora).substring(0, 5) : '—';
    const enlaceLogin = BASE_URL + '/login';
    const enlaceCatalogo = BASE_URL + '/catalogo';

    const icsCancelar = generarIcsCita({
        citaId: cita_id,
        paciente_id,
        psicologo_id,
        fecha,
        hora,
        titulo: 'Sesión cancelada - Psicólogos en Red',
        accion: 'cancelar'
    });
    const adjuntoIcs = { filename: 'cita-cancelada.ics', content: icsCancelar, contentType: 'text/calendar; method=CANCEL' };

    const htmlPsicologo = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="text-align: center; margin-bottom: 30px;"><h1 style="color: #c9a0dc;">Psicólogos en Red</h1></div>
            <h2 style="color: #333;">Cita cancelada</h2>
            <p style="color: #666; font-size: 16px;">El paciente <strong>${paciente.nombre || 'Paciente'}</strong> ha cancelado la siguiente sesión:</p>
            <div style="background: #fdf2f7; padding: 20px; border-radius: 12px; margin: 20px 0;">
                <p style="margin: 8px 0;"><strong>📅 Fecha:</strong> ${fechaStr}</p>
            <p style="margin: 8px 0;"><strong>🕐 Horario:</strong> ${horaStr} hrs</p>
            <p style="margin: 8px 0;"><strong>👤 Paciente:</strong> ${paciente.nombre || 'Paciente'}</p>
            </div>
            <p style="color: #888; font-size: 14px;">📎 Incluimos un archivo <strong>cita-cancelada.ics</strong> para que el evento se quite de tu calendario (Zoho, Google, etc.).</p>
            <div style="text-align: center; margin: 30px 0;">
                <a href="${enlaceLogin}" style="background: linear-gradient(135deg, #c9a0dc 0%, #a0c4e8 100%); color: white; padding: 15px 40px; text-decoration: none; border-radius: 30px; font-size: 16px; font-weight: bold;">Iniciar sesión</a>
            </div>
            <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
            <p style="color: #999; font-size: 12px; text-align: center;">© ${new Date().getFullYear()} Psicólogos en Red.</p>
        </div>`;

    const htmlPaciente = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="text-align: center; margin-bottom: 30px;"><h1 style="color: #c9a0dc;">Psicólogos en Red</h1></div>
            <h2 style="color: #333;">Cita cancelada</h2>
            <p style="color: #666; font-size: 16px;">Hemos registrado la cancelación de tu sesión del <strong>${fechaStr}</strong> a las <strong>${horaStr} hrs</strong> con ${psicologo.nombre || 'tu especialista'}.</p>
            <p style="color: #666; font-size: 16px;">Esperamos que todo se encuentre bien. Se emitirá el reembolso de tu sesión según los términos acordados.</p>
            <p style="color: #666; font-size: 16px;">Te invitamos a reagendar cuando las condiciones sean óptimas para ti. Estamos aquí cuando lo necesites.</p>
            <div style="text-align: center; margin: 30px 0;">
                <a href="${enlaceCatalogo}" style="background: linear-gradient(135deg, #c9a0dc 0%, #a0c4e8 100%); color: white; padding: 15px 40px; text-decoration: none; border-radius: 30px; font-size: 16px; font-weight: bold;">Agendar nueva cita</a>
            </div>
            <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
            <p style="color: #999; font-size: 12px; text-align: center;">© ${new Date().getFullYear()} Psicólogos en Red.</p>
        </div>`;

    try { await transporter.sendMail({ from: '"Psicólogos en Red" <contacto@psicologosenred.com>', to: psicologo.email, bcc: 'contacto@psicologosenred.com', subject: '❌ Cita cancelada - Psicólogos en Red', html: htmlPsicologo, attachments: [adjuntoIcs] }); } catch (e) { console.error('Error correo cancelación psicólogo:', e.message); }
    try { await transporter.sendMail({ from: '"Psicólogos en Red" <contacto@psicologosenred.com>', to: paciente.email, bcc: 'contacto@psicologosenred.com', subject: 'Cita cancelada - Psicólogos en Red', html: htmlPaciente, attachments: [adjuntoIcs] }); } catch (e) { console.error('Error correo cancelación paciente:', e.message); }
    await enviarWhatsapp(psicologo.telefono, `Psicólogos en Red – Cita cancelada: ${fechaStr} ${horaStr} hrs con ${paciente.nombre || 'Paciente'}. Iniciar sesión: ${enlaceLogin}`);
    await enviarWhatsapp(paciente.telefono, `Psicólogos en Red – Tu cita del ${fechaStr} fue cancelada. Puedes agendar otra: ${enlaceCatalogo}`);
}

// Recordatorio 30 min antes: correo a paciente y psicólogo con botón "Iniciar sesión"
async function enviarCorreosRecordatorioCita(paciente_id, psicologo_id, fecha, hora, cita_id) {
    const { paciente, psicologo } = await obtenerDatosPacienteYPsicologo(paciente_id, psicologo_id);
    if (!paciente?.email || !psicologo?.email) return;

    const fechaStr = formatearFechaParaEmail(fecha);
    const horaStr = hora != null ? String(hora).substring(0, 5) : '—';
    const enlaceLogin = BASE_URL + '/login';

    const htmlPaciente = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="text-align: center; margin-bottom: 30px;"><h1 style="color: #c9a0dc;">Psicólogos en Red</h1></div>
            <h2 style="color: #333;">Recordatorio: tu sesión es en 30 minutos</h2>
            <p style="color: #666; font-size: 16px;">Hola ${(paciente.nombre || '').split(' ')[0]}, tu sesión con <strong>${psicologo.nombre || 'tu psicólogo'}</strong> es hoy.</p>
            <div style="background: #fdf2f7; padding: 20px; border-radius: 12px; margin: 20px 0;">
                <p style="margin: 8px 0;"><strong>📅 Fecha:</strong> ${fechaStr}</p>
                <p style="margin: 8px 0;"><strong>🕐 Horario:</strong> ${horaStr} hrs</p>
            </div>
            <p style="color: #666; font-size: 16px;">Entra a tu cuenta y podrás iniciar la videollamada cuando sea la hora.</p>
            <div style="text-align: center; margin: 30px 0;">
                <a href="${enlaceLogin}" style="background: linear-gradient(135deg, #c9a0dc 0%, #a0c4e8 100%); color: white; padding: 15px 40px; text-decoration: none; border-radius: 30px; font-size: 16px; font-weight: bold;">Iniciar sesión</a>
            </div>
            <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
            <p style="color: #999; font-size: 12px; text-align: center;">© ${new Date().getFullYear()} Psicólogos en Red.</p>
        </div>`;

    const htmlPsicologo = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="text-align: center; margin-bottom: 30px;"><h1 style="color: #c9a0dc;">Psicólogos en Red</h1></div>
            <h2 style="color: #333;">Recordatorio: sesión en 30 minutos</h2>
            <p style="color: #666; font-size: 16px;">Tienes una sesión programada con <strong>${paciente.nombre || 'Paciente'}</strong>.</p>
            <div style="background: #fdf2f7; padding: 20px; border-radius: 12px; margin: 20px 0;">
                <p style="margin: 8px 0;"><strong>📅 Fecha:</strong> ${fechaStr}</p>
                <p style="margin: 8px 0;"><strong>🕐 Horario:</strong> ${horaStr} hrs</p>
            </div>
            <p style="color: #666; font-size: 16px;">Entra a tu panel para iniciar la videollamada cuando sea la hora.</p>
            <div style="text-align: center; margin: 30px 0;">
                <a href="${enlaceLogin}" style="background: linear-gradient(135deg, #c9a0dc 0%, #a0c4e8 100%); color: white; padding: 15px 40px; text-decoration: none; border-radius: 30px; font-size: 16px; font-weight: bold;">Iniciar sesión</a>
            </div>
            <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
            <p style="color: #999; font-size: 12px; text-align: center;">© ${new Date().getFullYear()} Psicólogos en Red.</p>
        </div>`;

    try {
        await transporter.sendMail({ from: '"Psicólogos en Red" <contacto@psicologosenred.com>', to: paciente.email, bcc: 'contacto@psicologosenred.com', subject: '⏰ Recordatorio: tu sesión es en 30 min - Psicólogos en Red', html: htmlPaciente });
    } catch (e) { console.error('Error correo recordatorio paciente:', e.message); }
    try {
        await transporter.sendMail({ from: '"Psicólogos en Red" <contacto@psicologosenred.com>', to: psicologo.email, bcc: 'contacto@psicologosenred.com', subject: '⏰ Recordatorio: sesión en 30 min - Psicólogos en Red', html: htmlPsicologo });
    } catch (e) { console.error('Error correo recordatorio psicólogo:', e.message); }
    await enviarWhatsapp(paciente.telefono, `Psicólogos en Red – Recordatorio: tu sesión es en 30 min (${fechaStr} ${horaStr} hrs). Iniciar sesión: ${enlaceLogin}`);
    await enviarWhatsapp(psicologo.telefono, `Psicólogos en Red – Recordatorio: sesión en 30 min con ${paciente.nombre || 'Paciente'} (${fechaStr} ${horaStr} hrs). Iniciar sesión: ${enlaceLogin}`);
}

// Notificación por correo cuando alguien escribe en el chat: máximo 1 correo por conversación cada N minutos (no por cada mensaje)
const CHAT_NOTIF_EMAIL_INTERVAL_MINUTES = 60;

async function enviarCorreoNotificacionChatSiAplica(destinatarioId, remitenteId) {
    if (!destinatarioId || !remitenteId) return;
    try {
        const r = await pool.query(
            `SELECT enviado_at FROM chat_notificacion_email WHERE destinatario_id = $1 AND remitente_id = $2`,
            [destinatarioId, remitenteId]
        );
        const lastSent = r.rows[0]?.enviado_at;
        if (lastSent) {
            const mins = (Date.now() - new Date(lastSent).getTime()) / (60 * 1000);
            if (mins < CHAT_NOTIF_EMAIL_INTERVAL_MINUTES) return;
        }

        const [destRow, remRow] = await Promise.all([
            pool.query('SELECT nombre, email FROM usuarios WHERE id = $1', [destinatarioId]),
            pool.query(`SELECT u.nombre AS usuario_nombre, p.nombre AS psicologo_nombre
                FROM usuarios u LEFT JOIN psicologos p ON p.usuario_id = u.id WHERE u.id = $1`, [remitenteId])
        ]);
        const dest = destRow.rows[0];
        const rem = remRow.rows[0];
        if (!dest?.email) return;
        const nombreRemitente = (rem?.psicologo_nombre || rem?.usuario_nombre || 'Alguien').trim();
        const enlaceLogin = BASE_URL + '/login';

        const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="text-align: center; margin-bottom: 30px;"><h1 style="color: #c9a0dc;">Psicólogos en Red</h1></div>
            <h2 style="color: #333;">Te están escribiendo</h2>
            <p style="color: #666; font-size: 16px;">Hola ${(dest.nombre || '').split(' ')[0] || 'hola'}, <strong>${nombreRemitente}</strong> está tratando de comunicarse contigo.</p>
            <p style="color: #666; font-size: 16px;">Inicia sesión para ver el mensaje que te mandó.</p>
            <div style="text-align: center; margin: 30px 0;">
                <a href="${enlaceLogin}" style="background: linear-gradient(135deg, #c9a0dc 0%, #a0c4e8 100%); color: white; padding: 15px 40px; text-decoration: none; border-radius: 30px; font-size: 16px; font-weight: bold;">Iniciar sesión</a>
            </div>
            <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
            <p style="color: #999; font-size: 12px; text-align: center;">© ${new Date().getFullYear()} Psicólogos en Red.</p>
        </div>`;

        await transporter.sendMail({
            from: '"Psicólogos en Red" <contacto@psicologosenred.com>',
            to: dest.email,
            bcc: 'contacto@psicologosenred.com',
            subject: '💬 ' + nombreRemitente + ' está tratando de comunicarse contigo - Psicólogos en Red',
            html
        });
        await pool.query(
            `INSERT INTO chat_notificacion_email (destinatario_id, remitente_id, enviado_at) VALUES ($1, $2, NOW())
             ON CONFLICT (destinatario_id, remitente_id) DO UPDATE SET enviado_at = NOW()`,
            [destinatarioId, remitenteId]
        );
    } catch (e) {
        console.error('Error enviando correo notificación chat:', e.message);
    }
}

/** Job: enviar recordatorios 30 min antes. Ejecuta cada 5 min y envía a citas en ventana 25–35 min. */
async function ejecutarRecordatoriosCitas() {
    try {
        const res = await pool.query(`
            SELECT c.id, c.paciente_id, c.psicologo_id, c.fecha, c.hora
            FROM citas c
            WHERE c.estado IN ('pendiente', 'confirmada')
              AND c.recordatorio_enviado_at IS NULL
              AND (c.fecha + c.hora) > NOW()
              AND (c.fecha + c.hora) - NOW() <= INTERVAL '35 minutes'
              AND (c.fecha + c.hora) - NOW() >= INTERVAL '25 minutes'
        `);
        for (const row of res.rows) {
            try {
                await enviarCorreosRecordatorioCita(row.paciente_id, row.psicologo_id, row.fecha, row.hora, row.id);
                await pool.query('UPDATE citas SET recordatorio_enviado_at = NOW() WHERE id = $1', [row.id]);
            } catch (e) { console.error('Error enviando recordatorio cita', row.id, e.message); }
        }
    } catch (e) { console.error('Error en job recordatorios:', e.message); }
}

// 2. CONFIGURACIONES
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Configuración de Sesiones
app.use(session({
    secret: 'mi-clave-secreta-psicologos', 
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Cambiar a true si usas HTTPS en el futuro
}));

// Middleware: El "Cadenero" que protege rutas
function authRequired(req, res, next) {
    if (req.session.usuario) {
        next(); // Tiene permiso
    } else {
        // Si es una llamada a la API, devolvemos JSON (evita HTML que rompe fetch/json)
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ error: 'No autorizado' });
        }
        res.redirect('/login'); // No tiene permiso, lo echamos al login
    }
}

// Configuración Jitsi as a Service (JaaS) - solo App ID; el frontend lo usa para 8x8.vc
app.get('/api/jaas-config', (req, res) => {
    const appId = limpiaEnv(process.env.JAAS_APP_ID);
    res.json({ appId });
});

// Limpia valores de .env para App ID y KID: quita espacios, saltos de línea y \\n literales
function limpiaEnv(s) {
    if (typeof s !== 'string') return '';
    return s.replace(/\\n/g, '').replace(/\s+/g, '').trim();
}

// JWT para JaaS: reuniones con límite extendido (requiere JAAS_KID y JAAS_PRIVATE_KEY en .env)
app.get('/api/jaas-jwt', authRequired, (req, res) => {
    const appId = limpiaEnv(process.env.JAAS_APP_ID);
    const kid = limpiaEnv(process.env.JAAS_KID);
    let privateKey = (process.env.JAAS_PRIVATE_KEY || '').trim();
    if (!appId || !kid || !privateKey) {
        return res.status(503).json({ error: 'JaaS JWT no configurado (JAAS_APP_ID, JAAS_KID, JAAS_PRIVATE_KEY)' });
    }
    const displayName = (req.query.displayName || req.session?.usuario?.nombre || 'Usuario').trim();
    const moderator = req.query.moderator === 'true' || req.query.moderator === true;
    try {
        if (privateKey.includes('\\n')) {
            privateKey = privateKey.replace(/\\n/g, '\n');
        }
        const now = Math.floor(Date.now() / 1000);
        // room: '*' = token válido para cualquier sala del App ID (evita "not allowed to join")
        const payload = {
            aud: 'jitsi',
            iss: 'chat',
            sub: appId,
            room: '*',
            exp: now + 7200,
            nbf: now - 10,
            context: {
                user: {
                    id: String(req.session.usuario?.id || ''),
                    name: displayName,
                    email: req.session.usuario?.email || '',
                    moderator: moderator ? 'true' : 'false'
                },
                features: {
                    livestreaming: 'false',
                    recording: 'false',
                    transcription: 'false',
                    'outbound-call': 'false',
                    'sip-outbound-call': 'false'
                },
                room: { regex: false }
            }
        };
        const token = jwt.sign(
            payload,
            privateKey,
            { algorithm: 'RS256', keyid: kid }
        );
        res.json({ jwt: token });
    } catch (err) {
        console.error('Error generando JWT JaaS:', err);
        res.status(500).json({ error: 'Error al generar token' });
    }
});

// 3. RUTAS DE NAVEGACIÓN (Páginas)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.get('/registro', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'registro.html'));
});

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

// Página de registro exitoso (pendiente de verificación)
app.get('/registro-exitoso', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'registro-exitoso.html'));
});

// Verificación de email
app.get('/verificar-email', async (req, res) => {
    const { token } = req.query;
    
    if (!token) {
        return res.send(`
            <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 50px auto; padding: 30px; text-align: center; background: #f8d7da; border-radius: 10px;">
                <h2 style="color: #721c24;">❌ Enlace inválido</h2>
                <p style="color: #721c24;">El enlace de verificación no es válido.</p>
                <a href="/login" style="color: #721c24;">Ir al login</a>
            </div>
        `);
    }
    
    try {
        const result = await pool.query(
            'SELECT id, nombre, token_verificacion_expira FROM usuarios WHERE token_verificacion = $1',
            [token]
        );
        
        if (result.rows.length === 0) {
            return res.send(`
                <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 50px auto; padding: 30px; text-align: center; background: #f8d7da; border-radius: 10px;">
                    <h2 style="color: #721c24;">❌ Enlace inválido</h2>
                    <p style="color: #721c24;">El enlace de verificación no existe o ya fue utilizado.</p>
                    <a href="/login" style="color: #721c24;">Ir al login</a>
                </div>
            `);
        }
        
        const usuario = result.rows[0];
        
        // Verificar si el token expiró
        if (new Date() > new Date(usuario.token_verificacion_expira)) {
            return res.send(`
                <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 50px auto; padding: 30px; text-align: center; background: #f8d7da; border-radius: 10px;">
                    <h2 style="color: #721c24;">⏰ Enlace expirado</h2>
                    <p style="color: #721c24;">El enlace de verificación ha expirado. Intenta iniciar sesión para solicitar uno nuevo.</p>
                    <a href="/login" style="color: #721c24;">Ir al login</a>
                </div>
            `);
        }
        
        // Verificar el email
        await pool.query(
            'UPDATE usuarios SET email_verificado = true, token_verificacion = NULL, token_verificacion_expira = NULL WHERE id = $1',
            [usuario.id]
        );
        
        res.send(`
            <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 50px auto; padding: 30px; text-align: center; background: #d4edda; border-radius: 10px;">
                <h2 style="color: #155724;">✅ ¡Correo verificado!</h2>
                <p style="color: #155724;">Hola ${usuario.nombre}, tu cuenta ha sido verificada exitosamente.</p>
                <p style="color: #155724;">Ya puedes iniciar sesión.</p>
                <a href="/login" style="display: inline-block; margin-top: 15px; padding: 12px 30px; background: linear-gradient(135deg, #c9a0dc 0%, #a0c4e8 100%); color: white; text-decoration: none; border-radius: 25px; font-weight: bold;">Iniciar sesión</a>
            </div>
        `);
    } catch (error) {
        console.error('Error verificando email:', error);
        res.status(500).send('Error al verificar el correo.');
    }
});

// Reenviar correo de verificación
app.get('/reenviar-verificacion', async (req, res) => {
    const { email } = req.query;
    
    if (!email) {
        return res.redirect('/login');
    }
    
    try {
        const result = await pool.query('SELECT id, nombre, email_verificado FROM usuarios WHERE email = $1', [email]);
        
        if (result.rows.length === 0) {
            return res.send(`
                <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 50px auto; padding: 30px; text-align: center; background: #f8d7da; border-radius: 10px;">
                    <h2 style="color: #721c24;">❌ Usuario no encontrado</h2>
                    <a href="/login" style="color: #721c24;">Ir al login</a>
                </div>
            `);
        }
        
        const usuario = result.rows[0];
        
        if (usuario.email_verificado) {
            return res.send(`
                <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 50px auto; padding: 30px; text-align: center; background: #d4edda; border-radius: 10px;">
                    <h2 style="color: #155724;">✅ Tu correo ya está verificado</h2>
                    <a href="/login" style="display: inline-block; margin-top: 15px; padding: 12px 30px; background: linear-gradient(135deg, #c9a0dc 0%, #a0c4e8 100%); color: white; text-decoration: none; border-radius: 25px; font-weight: bold;">Iniciar sesión</a>
                </div>
            `);
        }
        
        // Generar nuevo token
        const tokenVerificacion = crypto.randomBytes(32).toString('hex');
        const tokenExpira = new Date(Date.now() + 24 * 60 * 60 * 1000);
        
        await pool.query(
            'UPDATE usuarios SET token_verificacion = $1, token_verificacion_expira = $2 WHERE id = $3',
            [tokenVerificacion, tokenExpira, usuario.id]
        );
        
        // Enviar email
        const enlaceVerificacion = `${BASE_URL}/verificar-email?token=${tokenVerificacion}`;
        
        await transporter.sendMail({
            from: '"Psicólogos en Red" <contacto@psicologosenred.com>',
            to: email,
            subject: '✅ Verifica tu cuenta - Psicólogos en Red',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                    <div style="text-align: center; margin-bottom: 30px;">
                        <h1 style="color: #c9a0dc;">Psicólogos en Red</h1>
                    </div>
                    <h2 style="color: #333;">¡Hola ${usuario.nombre}!</h2>
                    <p style="color: #666; font-size: 16px;">Has solicitado un nuevo enlace de verificación. Por favor verifica tu correo electrónico haciendo clic en el siguiente botón:</p>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${enlaceVerificacion}" style="background: linear-gradient(135deg, #c9a0dc 0%, #a0c4e8 100%); color: white; padding: 15px 40px; text-decoration: none; border-radius: 30px; font-size: 16px; font-weight: bold;">Verificar mi cuenta</a>
                    </div>
                    <p style="color: #999; font-size: 14px;">Este enlace expira en 24 horas.</p>
                    <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
                    <p style="color: #999; font-size: 12px; text-align: center;">© ${new Date().getFullYear()} Psicólogos en Red. Todos los derechos reservados.</p>
                </div>
            `
        });
        
        res.send(`
            <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 50px auto; padding: 30px; text-align: center; background: #d4edda; border-radius: 10px;">
                <h2 style="color: #155724;">📧 ¡Correo enviado!</h2>
                <p style="color: #155724;">Hemos enviado un nuevo enlace de verificación a <strong>${email}</strong>.</p>
                <p style="color: #155724;">Revisa tu bandeja de entrada (y spam).</p>
                <a href="/login" style="display: inline-block; margin-top: 15px; padding: 12px 30px; background: #28a745; color: white; text-decoration: none; border-radius: 25px;">Volver al login</a>
            </div>
        `);
    } catch (error) {
        console.error('Error reenviando verificación:', error);
        res.status(500).send('Error al reenviar el correo de verificación.');
    }
});

app.get('/nosotros', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'nosotros.html'));
});

app.get('/terminos-condiciones', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'terminos-condiciones.html'));
});

app.get('/aviso-privacidad', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'aviso-privacidad.html'));
});

app.get('/contacto', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'contacto.html'));
});

app.get('/trabaja-con-nosotros', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'trabaja-con-nosotros.html'));
});

// Recibir solicitudes de trabajo → se envía por email a contacto@psicologosenred.com
app.post('/api/aplicacion-trabajo', async (req, res) => {
    const { nombre, telefono, email, pais, razones, experiencia } = req.body;
    
    if (!nombre || !telefono || !email || !pais || !razones || !experiencia) {
        return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const escBr = (s) => esc(s).replace(/\n/g, '<br>');

    try {
        const html = `
            <h2>Nueva solicitud de trabajo</h2>
            <p><strong>Nombre:</strong> ${esc(nombre)}</p>
            <p><strong>Teléfono:</strong> ${esc(telefono)}</p>
            <p><strong>Email:</strong> ${esc(email)}</p>
            <p><strong>País:</strong> ${esc(pais)}</p>
            <p><strong>¿Por qué quiere trabajar con nosotros?</strong></p>
            <p>${escBr(razones)}</p>
            <p><strong>Experiencia:</strong></p>
            <p>${escBr(experiencia)}</p>
            <p style="color:#888;font-size:12px;">Enviado el ${new Date().toLocaleString('es-MX')}</p>
        `;
        await transporter.sendMail({
            from: '"Psicólogos en Red" <contacto@psicologosenred.com>',
            to: 'contacto@psicologosenred.com',
            replyTo: email,
            subject: `[Trabaja con nosotros] ${esc(nombre)} - ${esc(pais)}`,
            html
        });
        res.json({ success: true, message: 'Solicitud recibida' });
    } catch (error) {
        console.error('Error al procesar solicitud:', error);
        res.status(500).json({ error: 'Error al enviar solicitud' });
    }
});

// Recibir mensajes del formulario de contacto → se envía por email a contacto@psicologosenred.com
app.post('/api/contacto', async (req, res) => {
    const { nombre, email, telefono, asunto, mensaje } = req.body;
    
    if (!nombre || !email || !asunto || !mensaje) {
        return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const escBr = (s) => esc(s).replace(/\n/g, '<br>');

    try {
        const html = `
            <h2>Nuevo mensaje de contacto</h2>
            <p><strong>Nombre:</strong> ${esc(nombre)}</p>
            <p><strong>Email:</strong> ${esc(email)}</p>
            <p><strong>Teléfono:</strong> ${esc(telefono || 'No proporcionado')}</p>
            <p><strong>Asunto:</strong> ${esc(asunto)}</p>
            <p><strong>Mensaje:</strong></p>
            <p>${escBr(mensaje)}</p>
            <p style="color:#888;font-size:12px;">Enviado el ${new Date().toLocaleString('es-MX')}</p>
        `;
        await transporter.sendMail({
            from: '"Psicólogos en Red" <contacto@psicologosenred.com>',
            to: 'contacto@psicologosenred.com',
            replyTo: email,
            subject: `[Contacto] ${esc(asunto)} - ${esc(nombre)}`,
            html
        });
        res.json({ success: true, message: 'Mensaje recibido' });
    } catch (error) {
        console.error('Error al procesar contacto:', error);
        res.status(500).json({ error: 'Error al enviar mensaje' });
    }
});

// RUTA PROTEGIDA: Solo entran logueados
app.get('/perfil', authRequired, (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'perfil.html'));
});

app.get('/catalogo', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'catalogo.html'));
});

// Helper: obtener precio según IP (Promise)
function getPrecioRegionAsync(req) {
    return new Promise((resolve) => {
        const clientIp = (req.get('x-forwarded-for') || '').split(',')[0].trim() || req.socket?.remoteAddress || req.ip || '127.0.0.1';
        const isLocalhost = /^127\.|^::1$|^::ffff:127\./i.test(clientIp);
        if (isLocalhost) {
            return resolve({ amount: 500, currency: 'MXN', inMexico: true });
        }
        const url = `https://ip-api.com/json/${encodeURIComponent(clientIp)}?fields=countryCode`;
        https.get(url, (apiRes) => {
            let data = '';
            apiRes.on('data', chunk => { data += chunk; });
            apiRes.on('end', () => {
                try {
                    const json = JSON.parse(data || '{}');
                    const inMexico = json.countryCode === 'MX';
                    resolve(inMexico ? { amount: 500, currency: 'MXN', inMexico: true } : { amount: 50, currency: 'USD', inMexico: false });
                } catch (e) {
                    resolve({ amount: 500, currency: 'MXN', inMexico: true });
                }
            });
        }).on('error', () => resolve({ amount: 500, currency: 'MXN', inMexico: true }));
    });
}

// API: precio según región (IP). México → $500 MXN; fuera → $50 USD
app.get('/api/precio-region', (req, res) => {
    getPrecioRegionAsync(req).then(data => res.json(data));
});

app.get('/academia', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'academia.html'));
});

// API pública: listado de diplomados activos para la página Academia
app.get('/api/diplomados', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, area, titulo, fecha_inicio, descripcion_corta, descripcion_larga, url_imagen, mensaje_whatsapp, orden
             FROM diplomados
             WHERE activo = true
             ORDER BY orden ASC, id ASC`
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error listando diplomados:', err);
        res.status(500).json({ error: 'Error al cargar diplomados' });
    }
});

// API para que el frontend obtenga los datos completos del usuario conectado
app.get('/api/user-data', async (req, res) => {
    if (!req.session.usuario) return res.status(401).json({ error: "No autorizado" });

    try {
        // Hacemos el cruce usando la nueva columna usuario_id
        const query = `
            SELECT 
                u.id AS usuario_id, 
                u.nombre, 
                u.email, 
                u.telefono,
                u.rol, 
                p.id AS psicologo_id
            FROM usuarios u
            LEFT JOIN psicologos p ON u.id = p.usuario_id
            WHERE u.id = $1
        `;
        
        const result = await pool.query(query, [req.session.usuario.id]);
        
        if (result.rows.length > 0) {
            const user = result.rows[0];
            res.json({
                id: user.usuario_id,      // El 6 (identidad de persona/chat)
                psicologo_id: user.psicologo_id, // El 1 (identidad profesional/citas)
                nombre: user.nombre,
                email: user.email,
                telefono: user.telefono,
                rol: user.rol
            });
        } else {
            res.status(404).json({ error: "Usuario no encontrado" });
        }
    } catch (error) {
        console.error("Error en user-data:", error);
        res.status(500).json({ error: "Error interno del servidor" });
    }
});

// API para saber si hay alguien logueado y quién es
app.get('/api/estado-sesion', async (req, res) => {
    if (req.session.usuario) {
        try {
            // Buscamos el nombre actualizado directamente de la DB usando el ID de la sesión
            const result = await pool.query('SELECT nombre FROM usuarios WHERE id = $1', [req.session.usuario.id]);
            const nombreActualizado = result.rows[0].nombre;

            res.json({
                autenticado: true,
                nombre: nombreActualizado, // <--- Enviamos el nombre real de la DB
                rol: req.session.usuario.rol
            });
        } catch (err) {
            res.json({ autenticado: false });
        }
    } else {
        res.json({ autenticado: false });
    }
});

app.get('/panel-doctor', authRequired, (req, res) => {
    if (req.session.usuario.rol !== 'psicologo') {
        return res.status(403).send('Acceso denegado: Esta zona es solo para psicólogos.');
    }
    res.sendFile(path.join(__dirname, 'views', 'panel-doctor.html'));
});

// ========== PANEL ADMIN ==========
app.get('/panel-admin', authRequired, (req, res) => {
    if (req.session.usuario.rol !== 'admin') {
        return res.status(403).send('Acceso denegado: Esta zona es solo para administradores.');
    }
    res.sendFile(path.join(__dirname, 'views', 'panel-admin.html'));
});

// API: Estadísticas generales para admin
app.get('/api/admin/estadisticas', authRequired, async (req, res) => {
    if (req.session.usuario.rol !== 'admin') {
        return res.status(403).json({ error: 'No autorizado' });
    }
    try {
        // Total usuarios por rol
        const usuarios = await pool.query(`
            SELECT rol, COUNT(*) as total FROM usuarios GROUP BY rol
        `);
        
        // Citas HOY por estado
        const citasHoy = await pool.query(`
            SELECT COALESCE(estado, 'pendiente') as estado, COUNT(*) as total 
            FROM citas WHERE fecha = CURRENT_DATE 
            GROUP BY estado
        `);
        
        // Citas SEMANA por estado
        const citasSemana = await pool.query(`
            SELECT COALESCE(estado, 'pendiente') as estado, COUNT(*) as total 
            FROM citas WHERE fecha >= CURRENT_DATE - INTERVAL '7 days' 
            GROUP BY estado
        `);
        
        // Citas MES por estado
        const citasMes = await pool.query(`
            SELECT COALESCE(estado, 'pendiente') as estado, COUNT(*) as total 
            FROM citas WHERE fecha >= DATE_TRUNC('month', CURRENT_DATE) 
            GROUP BY estado
        `);
        
        // Citas HISTORICO por estado
        const citasTotal = await pool.query(`
            SELECT COALESCE(estado, 'pendiente') as estado, COUNT(*) as total 
            FROM citas GROUP BY estado
        `);

        // Función helper para convertir array a objeto
        const toObj = (rows) => {
            const obj = { pendiente: 0, confirmada: 0, realizada: 0, cancelada: 0, 'no realizada': 0, total: 0 };
            rows.forEach(r => {
                obj[r.estado] = parseInt(r.total) || 0;
                obj.total += parseInt(r.total) || 0;
            });
            return obj;
        };
        
        res.json({
            usuarios: usuarios.rows,
            hoy: toObj(citasHoy.rows),
            semana: toObj(citasSemana.rows),
            mes: toObj(citasMes.rows),
            historico: toObj(citasTotal.rows)
        });
    } catch (error) {
        console.error('Error en estadísticas admin:', error);
        res.status(500).json({ error: 'Error al obtener estadísticas' });
    }
});

// API: Lista de todas las citas para admin
app.get('/api/admin/citas', authRequired, async (req, res) => {
    if (req.session.usuario.rol !== 'admin') {
        return res.status(403).json({ error: 'No autorizado' });
    }
    try {
        await marcarCitasNoRealizadas();
        const result = await pool.query(`
            SELECT c.id, c.fecha, c.hora, c.estado,
                   pac.nombre as paciente_nombre, pac.email as paciente_email,
                   psi.nombre as psicologo_nombre
            FROM citas c
            JOIN usuarios pac ON c.paciente_id = pac.id
            JOIN psicologos psi ON c.psicologo_id = psi.id
            ORDER BY c.fecha DESC, c.hora DESC
            LIMIT 100
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Error al obtener citas admin:', error);
        res.status(500).json({ error: 'Error al obtener citas' });
    }
});

// API: Lista de psicólogos para admin
app.get('/api/admin/psicologos', authRequired, async (req, res) => {
    if (req.session.usuario.rol !== 'admin') {
        return res.status(403).json({ error: 'No autorizado' });
    }
    try {
        const result = await pool.query(`
            SELECT p.id, p.nombre, p.especialidad, u.email, u.telefono, p.usuario_id,
                   (SELECT COUNT(*) FROM citas WHERE psicologo_id = p.id) as total_citas,
                   (SELECT COUNT(*) FROM citas WHERE psicologo_id = p.id AND fecha = CURRENT_DATE) as citas_hoy,
                   COALESCE(p.rating, 0) as calificacion,
                   (SELECT COUNT(*) FROM opiniones WHERE psicologo_id = p.id) as total_opiniones,
                   (SELECT COUNT(*) FROM opiniones WHERE psicologo_id = p.id AND estrellas < 3) as opiniones_negativas
            FROM psicologos p
            JOIN usuarios u ON p.usuario_id = u.id
            ORDER BY p.nombre
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Error al obtener psicólogos admin:', error);
        res.status(500).json({ error: 'Error al obtener psicólogos' });
    }
});

// API: Estadísticas de cartera por psicólogo para gráfico
app.get('/api/admin/cartera-psicologos', authRequired, async (req, res) => {
    if (req.session.usuario.rol !== 'admin') {
        return res.status(403).json({ error: 'No autorizado' });
    }
    try {
        // Obtener todos los psicólogos
        const psicologos = await pool.query('SELECT id, nombre FROM psicologos ORDER BY nombre');
        
        const resultado = [];
        
        for (const psi of psicologos.rows) {
            // Pacientes con cita futura
            const conCita = await pool.query(`
                SELECT COUNT(DISTINCT paciente_id) as total
                FROM citas 
                WHERE psicologo_id = $1 AND fecha >= CURRENT_DATE AND estado NOT IN ('cancelada')
            `, [psi.id]);
            
            // Pacientes con última cita hace menos de 15 días (sin cita futura)
            const enSeguimiento = await pool.query(`
                SELECT COUNT(*) as total FROM (
                    SELECT paciente_id, MAX(fecha) as ultima
                    FROM citas WHERE psicologo_id = $1 AND fecha < CURRENT_DATE
                    GROUP BY paciente_id
                    HAVING MAX(fecha) >= CURRENT_DATE - INTERVAL '15 days'
                ) sub
                WHERE paciente_id NOT IN (
                    SELECT DISTINCT paciente_id FROM citas 
                    WHERE psicologo_id = $1 AND fecha >= CURRENT_DATE AND estado NOT IN ('cancelada')
                )
            `, [psi.id]);
            
            // Pacientes con última cita hace más de 30 días (sin cita futura)
            const enRiesgo = await pool.query(`
                SELECT COUNT(*) as total FROM (
                    SELECT paciente_id, MAX(fecha) as ultima
                    FROM citas WHERE psicologo_id = $1
                    GROUP BY paciente_id
                    HAVING MAX(fecha) < CURRENT_DATE - INTERVAL '30 days'
                ) sub
                WHERE paciente_id NOT IN (
                    SELECT DISTINCT paciente_id FROM citas 
                    WHERE psicologo_id = $1 AND fecha >= CURRENT_DATE AND estado NOT IN ('cancelada')
                )
            `, [psi.id]);
            
            resultado.push({
                id: psi.id,
                nombre: psi.nombre,
                con_cita: parseInt(conCita.rows[0].total) || 0,
                en_seguimiento: parseInt(enSeguimiento.rows[0].total) || 0,
                en_riesgo: parseInt(enRiesgo.rows[0].total) || 0
            });
        }
        
        res.json(resultado);
    } catch (error) {
        console.error('Error al obtener cartera:', error);
        res.status(500).json({ error: 'Error al obtener datos' });
    }
});

// API: Lista de pacientes para admin
app.get('/api/admin/pacientes', authRequired, async (req, res) => {
    if (req.session.usuario.rol !== 'admin') {
        return res.status(403).json({ error: 'No autorizado' });
    }
    try {
        const result = await pool.query(`
            SELECT u.id, u.nombre, u.email, u.telefono, u.acepto_publicidad,
                   (SELECT COUNT(*) FROM citas WHERE paciente_id = u.id) as total_citas,
                   (SELECT MAX(fecha) FROM citas WHERE paciente_id = u.id AND fecha < CURRENT_DATE) as ultima_cita,
                   (SELECT COUNT(*) FROM citas WHERE paciente_id = u.id AND fecha >= CURRENT_DATE AND estado NOT IN ('cancelada')) as citas_futuras
            FROM usuarios u
            WHERE u.rol = 'paciente'
            ORDER BY u.nombre
            LIMIT 200
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Error al obtener pacientes admin:', error);
        res.status(500).json({ error: 'Error al obtener pacientes' });
    }
});

app.get('/api/psicologos', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM psicologos');
        // 'result.rows' ya contiene 'problemas_principales' como un array de JS
        // Ejemplo: ["Ansiedad", "Depresión", "Estrés laboral"]
        res.json(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al obtener catálogo');
    }
});

// API para que el PACIENTE vea sus citas (con el nombre del psicólogo)
app.get('/api/mis-citas-paciente', authRequired, async (req, res) => {
    try {
        await marcarCitasNoRealizadas();
        const result = await pool.query(
            `SELECT c.id, c.fecha, c.hora, c.estado, c.link_sesion, c.psicologo_id, p.nombre as psicologo_nombre
             FROM citas c 
             JOIN psicologos p ON c.psicologo_id = p.id 
             WHERE c.paciente_id = $1 
             ORDER BY c.fecha ASC, c.hora ASC`,
            [req.session.usuario.id]
        );
        res.json(result.rows);
    } catch (error) {
        console.error("Error al obtener citas del paciente:", error);
        res.status(500).json({ error: 'Error al obtener citas' });
    }
});

// 4. RUTAS DE LÓGICA (Registro/Login/Logout)

// Registro
app.post('/registrar-usuario', async (req, res) => {
    const { nombre, email, password, rol, acepto_terminos, acepto_publicidad, telefono } = req.body;
    try {
        // Verificar si el email ya existe
        const existente = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
        if (existente.rows.length > 0) {
            return res.send('<h1>Este correo ya está registrado</h1><a href="/login">Ir al Login</a>');
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const aceptoTerminos = acepto_terminos === 'on';
        const aceptoPublicidad = acepto_publicidad === 'on';
        const telefonoNorm = (telefono && String(telefono).trim()) || null;
        
        // Generar token de verificación
        const tokenVerificacion = crypto.randomBytes(32).toString('hex');
        const tokenExpira = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 horas
        
        await pool.query(
            `INSERT INTO usuarios (nombre, email, telefono, password, rol, acepto_terminos, acepto_publicidad, email_verificado, token_verificacion, token_verificacion_expira) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [nombre, email, telefonoNorm, hashedPassword, rol || 'paciente', aceptoTerminos, aceptoPublicidad, false, tokenVerificacion, tokenExpira]
        );

        // Enviar email de verificación (si falla, igual redirigimos para que pueda usar "Reenviar verificación")
        const enlaceVerificacion = `${BASE_URL}/verificar-email?token=${tokenVerificacion}`;
        const fromEmail = process.env.EMAIL_USER || 'contacto@psicologosenred.com';
        try {
            await transporter.sendMail({
                from: `"Psicólogos en Red" <${fromEmail}>`,
                to: email,
                subject: '✅ Verifica tu cuenta - Psicólogos en Red',
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                        <div style="text-align: center; margin-bottom: 30px;">
                            <h1 style="color: #c9a0dc;">Psicólogos en Red</h1>
                        </div>
                        <h2 style="color: #333;">¡Hola ${nombre}!</h2>
                        <p style="color: #666; font-size: 16px;">Gracias por registrarte en Psicólogos en Red. Para completar tu registro y acceder a tu cuenta, por favor verifica tu correo electrónico haciendo clic en el siguiente botón:</p>
                        <div style="text-align: center; margin: 30px 0;">
                            <a href="${enlaceVerificacion}" style="background: linear-gradient(135deg, #c9a0dc 0%, #a0c4e8 100%); color: white; padding: 15px 40px; text-decoration: none; border-radius: 30px; font-size: 16px; font-weight: bold;">Verificar mi cuenta</a>
                        </div>
                        <p style="color: #999; font-size: 14px;">Este enlace expira en 24 horas.</p>
                        <p style="color: #999; font-size: 14px;">Si no creaste esta cuenta, puedes ignorar este correo.</p>
                        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
                        <p style="color: #999; font-size: 12px; text-align: center;">© ${new Date().getFullYear()} Psicólogos en Red. Todos los derechos reservados.</p>
                    </div>
                `
            });
        } catch (errMail) {
            console.error('Error enviando correo de verificación:', errMail.message);
            if (errMail.code) console.error('Código:', errMail.code);
        }

        res.redirect('/registro-exitoso');
    } catch (error) {
        console.error('Error en registro:', error);
        res.status(500).send('Error en el registro. Por favor intenta de nuevo.');
    }
});

app.post('/auth/olvide-password', async (req, res) => {
    const { email } = req.body;
    try {
        const result = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
        
        if (result.rows.length === 0) {
            return res.json({ message: "Si el correo existe en nuestro sistema, recibirás instrucciones pronto." });
        }

        const usuario = result.rows[0];
        
        // Token seguro de un solo uso, expira en 1 hora
        const tokenReset = crypto.randomBytes(32).toString('hex');
        const tokenExpira = new Date(Date.now() + 60 * 60 * 1000);
        
        await pool.query(
            'UPDATE usuarios SET token_reset_password = $1, token_reset_expira = $2 WHERE id = $3',
            [tokenReset, tokenExpira, usuario.id]
        );

        const resetLink = `${BASE_URL}/reestablecer-password?token=${tokenReset}`;

        await transporter.sendMail({
            from: '"Psicólogos en Red" <contacto@psicologosenred.com>',
            to: email,
            subject: "Reestablece tu contraseña - Psicólogos en Red 🔐",
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                    <div style="text-align: center; margin-bottom: 30px;">
                        <h1 style="color: #c9a0dc;">Psicólogos en Red</h1>
                    </div>
                    <h2 style="color: #333;">Hola, ${usuario.nombre}</h2>
                    <p style="color: #666; font-size: 16px;">Recibimos una solicitud para reestablecer tu contraseña en Psicólogos en Red.</p>
                    <p style="color: #666; font-size: 16px;">Haz clic en el siguiente botón para crear una nueva contraseña:</p>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${resetLink}" style="background: linear-gradient(135deg, #c9a0dc 0%, #a0c4e8 100%); color: white; padding: 15px 40px; text-decoration: none; border-radius: 30px; font-size: 16px; font-weight: bold;">Reestablecer contraseña</a>
                    </div>
                    <p style="color: #999; font-size: 14px;">Este enlace expira en 1 hora.</p>
                    <p style="color: #999; font-size: 14px;">Si no solicitaste esto, puedes ignorar este correo. Tu contraseña no cambiará.</p>
                    <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
                    <p style="color: #999; font-size: 12px; text-align: center;">© ${new Date().getFullYear()} Psicólogos en Red. Todos los derechos reservados.</p>
                </div>
            `
        });

        res.json({ message: "Si el correo existe en nuestro sistema, recibirás instrucciones pronto." });
    } catch (error) {
        console.error('Error olvide-password:', error);
        res.status(500).json({ message: "Error al procesar la solicitud. Intenta de nuevo." });
    }
});

// Página de reestablecer contraseña (solo si token válido)
app.get('/reestablecer-password', async (req, res) => {
    const { token } = req.query;
    
    if (!token) {
        return res.send(`
            <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 50px auto; padding: 30px; text-align: center; background: #f8d7da; border-radius: 10px;">
                <h2 style="color: #721c24;">❌ Enlace inválido</h2>
                <p style="color: #721c24;">Falta el enlace de recuperación. Solicita uno nuevo desde el login.</p>
                <a href="/login" style="display: inline-block; margin-top: 15px; padding: 12px 25px; background: #c9a0dc; color: white; text-decoration: none; border-radius: 25px;">Ir al login</a>
            </div>
        `);
    }
    
    try {
        const result = await pool.query(
            'SELECT id FROM usuarios WHERE token_reset_password = $1 AND token_reset_expira > NOW()',
            [token]
        );
        
        if (result.rows.length === 0) {
            return res.send(`
                <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 50px auto; padding: 30px; text-align: center; background: #f8d7da; border-radius: 10px;">
                    <h2 style="color: #721c24;">❌ Enlace inválido o expirado</h2>
                    <p style="color: #721c24;">El enlace de recuperación no es válido o ya expiró (1 hora). Solicita uno nuevo.</p>
                    <a href="/login" style="display: inline-block; margin-top: 15px; padding: 12px 25px; background: #c9a0dc; color: white; text-decoration: none; border-radius: 25px;">Ir al login</a>
                </div>
            `);
        }
        
        res.sendFile(path.join(__dirname, 'views', 'reestablecer-password.html'));
    } catch (error) {
        console.error('Error reestablecer-password:', error);
        res.status(500).send('Error al cargar la página.');
    }
});

// Actualizar contraseña usando token (invalida el token después)
app.post('/auth/update-password-forgotten', async (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) {
        return res.status(400).json({ error: "Faltan datos." });
    }
    try {
        const result = await pool.query(
            'SELECT id FROM usuarios WHERE token_reset_password = $1 AND token_reset_expira > NOW()',
            [token]
        );
        
        if (result.rows.length === 0) {
            return res.status(400).json({ error: "Enlace inválido o expirado. Solicita uno nuevo desde el login." });
        }
        
        const usuarioId = result.rows[0].id;
        const hashedPassword = await bcrypt.hash(password, 10);
        
        await pool.query(
            'UPDATE usuarios SET password = $1, token_reset_password = NULL, token_reset_expira = NULL WHERE id = $2',
            [hashedPassword, usuarioId]
        );

        res.json({ success: true });
    } catch (error) {
        console.error('Error update-password-forgotten:', error);
        res.status(500).json({ error: "Error al actualizar la contraseña." });
    }
});

app.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
        if (result.rows.length > 0) {
            const usuario = result.rows[0];
            
            // Verificar si el email está verificado (excepto admin)
            if (usuario.rol !== 'admin' && !usuario.email_verificado) {
                return res.send(`
                    <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 50px auto; padding: 30px; text-align: center; background: #fff3cd; border-radius: 10px; border: 1px solid #ffc107;">
                        <h2 style="color: #856404;">⚠️ Correo no verificado</h2>
                        <p style="color: #856404;">Necesitas verificar tu correo electrónico antes de iniciar sesión.</p>
                        <p style="color: #856404;">Revisa tu bandeja de entrada (y spam) para encontrar el enlace de verificación.</p>
                        <a href="/reenviar-verificacion?email=${encodeURIComponent(email)}" style="display: inline-block; margin-top: 15px; padding: 10px 25px; background: #ffc107; color: #856404; text-decoration: none; border-radius: 5px; font-weight: bold;">Reenviar correo de verificación</a>
                        <br><br>
                        <a href="/login" style="color: #856404;">Volver al login</a>
                    </div>
                `);
            }
            
            const match = await bcrypt.compare(password, usuario.password);

            if (match) {
                req.session.usuario = {
                    id: usuario.id,
                    nombre: usuario.nombre,
                    email: usuario.email,
                    rol: usuario.rol 
                };

                // Contador de inicios de sesión (solo paciente y psicólogo; para encuesta en 6to login)
                if (usuario.rol === 'paciente' || usuario.rol === 'psicologo') {
                    await pool.query(
                        'UPDATE usuarios SET veces_inicio_sesion = COALESCE(veces_inicio_sesion, 0) + 1 WHERE id = $1',
                        [usuario.id]
                    );
                }

                // REDIRECCIÓN INTELIGENTE
                if (usuario.rol === 'admin') {
                    res.redirect('/panel-admin');
                } else if (usuario.rol === 'psicologo') {
                    res.redirect('/panel-doctor');
                } else {
                    res.redirect('/perfil');
                }
            } else {
                res.send('Contraseña incorrecta. <a href="/login">Volver</a>');
            }
        } else {
            res.send('Usuario no encontrado. <a href="/registro">Regístrate</a>');
        }
    } catch (error) {
        console.error(error);
        res.status(500).send('Error en el servidor');
    }
});

// Encuesta de satisfacción: se muestra la 6ta vez que inicia sesión (paciente o psicólogo)
app.get('/api/encuesta-satisfaccion/estado', authRequired, async (req, res) => {
    const rol = req.session.usuario.rol;
    if (rol !== 'paciente' && rol !== 'psicologo') {
        return res.json({ mostrarEncuesta: false });
    }
    try {
        const r = await pool.query(
            'SELECT veces_inicio_sesion, encuesta_satisfaccion_mostrada FROM usuarios WHERE id = $1',
            [req.session.usuario.id]
        );
        if (r.rows.length === 0) return res.json({ mostrarEncuesta: false });
        const { veces_inicio_sesion, encuesta_satisfaccion_mostrada } = r.rows[0];
        const veces = parseInt(veces_inicio_sesion, 10) || 0;
        const yaMostrada = !!encuesta_satisfaccion_mostrada;
        const mostrarEncuesta = veces >= 6 && !yaMostrada;
        res.json({ mostrarEncuesta });
    } catch (e) {
        console.error(e);
        res.json({ mostrarEncuesta: false });
    }
});

app.post('/api/encuesta-satisfaccion', authRequired, async (req, res) => {
    const rol = req.session.usuario.rol;
    if (rol !== 'paciente' && rol !== 'psicologo') {
        return res.status(403).json({ error: 'No aplica' });
    }
    const usuarioId = req.session.usuario.id;
    const { valoracion, comentario } = req.body || {};
    try {
        await pool.query(
            'UPDATE usuarios SET encuesta_satisfaccion_mostrada = true WHERE id = $1',
            [usuarioId]
        );
        try {
            await pool.query(
                'INSERT INTO encuestas_satisfaccion (usuario_id, rol, valoracion, comentario) VALUES ($1, $2, $3, $4)',
                [usuarioId, rol, valoracion != null ? String(valoracion) : null, comentario || null]
            );
        } catch (_) {
            // Tabla opcional; si no existe, no fallar
        }
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Error al guardar' });
    }
});

// Testimonios públicos para el index (comentarios de la encuesta de satisfacción)
app.get('/api/testimonios-encuesta', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT e.comentario, e.valoracion, e.rol, u.nombre
            FROM encuestas_satisfaccion e
            JOIN usuarios u ON u.id = e.usuario_id
            WHERE e.comentario IS NOT NULL AND TRIM(e.comentario) != ''
            ORDER BY e.fecha DESC
            LIMIT 100
        `);
        res.json(result.rows);
    } catch (e) {
        console.error(e);
        res.json([]);
    }
});

// Obtener configuración de disponibilidad del psicólogo (para Flatpickr)
app.get('/api/disponibilidad-calendario/:psicologoId', async (req, res) => {
    const psicologoId = parseInt(req.params.psicologoId, 10);
    if (Number.isNaN(psicologoId)) {
        return res.status(400).json({ error: 'ID inválido' });
    }

    try {
        // 1. Obtener días de la semana que trabaja
        const horarioResult = await pool.query(
            `SELECT DISTINCT dia_semana FROM horario_laboral WHERE psicologo_id = $1`,
            [psicologoId]
        );
        const diasLaborales = horarioResult.rows.map(r => r.dia_semana);
        
        // Días que NO trabaja (0-6, donde 0=Domingo)
        const todosDias = [0, 1, 2, 3, 4, 5, 6];
        const diasNoLaborales = todosDias.filter(d => !diasLaborales.includes(d));

        // 2. Obtener fechas bloqueadas (vacaciones) - próximos 6 meses
        const vacacionesResult = await pool.query(
            `SELECT fecha_inicio, fecha_fin FROM vacaciones 
             WHERE psicologo_id = $1 
             AND (fecha_fin >= CURRENT_DATE OR fecha_inicio >= CURRENT_DATE)`,
            [psicologoId]
        );

        // Expandir rangos a fechas individuales
        const fechasBloqueadas = [];
        for (const vac of vacacionesResult.rows) {
            let current = new Date(vac.fecha_inicio);
            const end = new Date(vac.fecha_fin || vac.fecha_inicio);
            while (current <= end) {
                fechasBloqueadas.push(current.toISOString().split('T')[0]);
                current.setDate(current.getDate() + 1);
            }
        }

        res.json({
            diasNoLaborales,  // [0, 6] = no trabaja domingo y sábado
            fechasBloqueadas  // ["2024-02-15", "2024-02-16", ...]
        });
    } catch (error) {
        console.error('Error al obtener disponibilidad:', error);
        res.status(500).json({ error: 'Error al obtener disponibilidad' });
    }
});

// Obtener horarios disponibles para un psicólogo en una fecha
app.get('/api/horarios-disponibles/:psicologoId', async (req, res) => {
    const psicologoId = parseInt(req.params.psicologoId, 10);
    const { fecha } = req.query; // formato: YYYY-MM-DD

    if (!fecha || Number.isNaN(psicologoId)) {
        return res.status(400).json({ error: 'Fecha y psicólogo son requeridos' });
    }

    try {
        const fechaDate = new Date(fecha + 'T12:00:00');
        const diaSemana = fechaDate.getDay(); // 0=Domingo, 1=Lunes, etc.

        // 1. Verificar si la fecha está bloqueada (vacaciones)
        const vacacionesResult = await pool.query(
            `SELECT id FROM vacaciones 
             WHERE psicologo_id = $1 
             AND $2::date BETWEEN fecha_inicio AND COALESCE(fecha_fin, fecha_inicio)`,
            [psicologoId, fecha]
        );
        if (vacacionesResult.rows.length > 0) {
            return res.json({ disponible: false, horarios: [], mensaje: 'El psicólogo no está disponible en esta fecha' });
        }

        // 2. Obtener horario laboral para ese día de la semana
        const horarioResult = await pool.query(
            `SELECT hora_inicio, hora_fin FROM horario_laboral 
             WHERE psicologo_id = $1 AND dia_semana = $2
             ORDER BY hora_inicio`,
            [psicologoId, diaSemana]
        );

        if (horarioResult.rows.length === 0) {
            return res.json({ disponible: false, horarios: [], mensaje: 'El psicólogo no trabaja este día' });
        }

        // 3. Generar todos los horarios posibles (bloques de 1 hora)
        let horariosDisponibles = [];
        for (const bloque of horarioResult.rows) {
            let horaActual = parseInt(bloque.hora_inicio.split(':')[0], 10);
            const horaFin = parseInt(bloque.hora_fin.split(':')[0], 10);
            while (horaActual < horaFin) {
                horariosDisponibles.push(`${String(horaActual).padStart(2, '0')}:00`);
                horaActual++;
            }
        }

        // 4. Quitar horarios ya ocupados por citas
        const citasResult = await pool.query(
            `SELECT TO_CHAR(hora, 'HH24:MI') as hora_ocupada FROM citas 
             WHERE psicologo_id = $1 AND fecha = $2 AND estado NOT IN ('cancelada')`,
            [psicologoId, fecha]
        );
        const horasOcupadas = citasResult.rows.map(c => c.hora_ocupada);
        horariosDisponibles = horariosDisponibles.filter(h => !horasOcupadas.includes(h));

        // 5. Si es hoy, quitar horarios pasados
        const hoy = new Date().toISOString().split('T')[0];
        if (fecha === hoy) {
            const horaActual = new Date().getHours();
            horariosDisponibles = horariosDisponibles.filter(h => parseInt(h.split(':')[0], 10) > horaActual);
        }

        res.json({ disponible: true, horarios: horariosDisponibles });
    } catch (error) {
        console.error('Error al obtener horarios disponibles:', error);
        res.status(500).json({ error: 'Error al obtener horarios' });
    }
});

// Crear sesión de pago Stripe (redirige a Checkout); la cita se crea en el webhook
app.post('/api/crear-sesion-pago', authRequired, async (req, res) => {
    if (!stripe) {
        return res.status(503).json({ error: 'Pagos no configurados. Contacta al administrador.' });
    }
    const { psicologo_id, fecha, hora, servicio_interes } = req.body;
    const paciente_id = req.session.usuario.id;

    if (!psicologo_id || !fecha || !hora) {
        return res.status(400).json({ error: 'Faltan datos para agendar' });
    }
    if (!process.env.STRIPE_SECRET_KEY) {
        return res.status(503).json({ error: 'Pagos no configurados. Contacta al administrador.' });
    }

    try {
        const fechaDate = new Date(fecha + 'T12:00:00');
        const diaSemana = fechaDate.getDay();

        const vacCheck = await pool.query(
            `SELECT id FROM vacaciones 
             WHERE psicologo_id = $1 
             AND $2::date BETWEEN fecha_inicio AND COALESCE(fecha_fin, fecha_inicio)`,
            [psicologo_id, fecha]
        );
        if (vacCheck.rows.length > 0) {
            return res.status(400).json({ error: 'El psicólogo no está disponible en esta fecha' });
        }

        const horarioCheck = await pool.query(
            `SELECT id FROM horario_laboral 
             WHERE psicologo_id = $1 AND dia_semana = $2
             AND $3::time >= hora_inicio AND $3::time < hora_fin`,
            [psicologo_id, diaSemana, hora]
        );
        if (horarioCheck.rows.length === 0) {
            return res.status(400).json({ error: 'El horario seleccionado no está disponible' });
        }

        const citaCheck = await pool.query(
            `SELECT id FROM citas 
             WHERE psicologo_id = $1 AND fecha = $2 AND hora = $3 AND estado NOT IN ('cancelada')`,
            [psicologo_id, fecha, hora]
        );
        if (citaCheck.rows.length > 0) {
            return res.status(400).json({ error: 'Este horario ya está ocupado' });
        }

        const region = await getPrecioRegionAsync(req);
        const useUsd = region.currency === 'USD';

        const psiRow = await pool.query(
            `SELECT precio_terapia_individual, precio_terapia_pareja, precio_asesoria_crianza,
                    precio_terapia_individual_usd, precio_terapia_pareja_usd, precio_asesoria_crianza_usd
             FROM psicologos WHERE id = $1`,
            [psicologo_id]
        );
        if (psiRow.rows.length === 0) {
            return res.status(400).json({ error: 'Psicólogo no encontrado' });
        }
        const p = psiRow.rows[0];
        let monto;
        let currency;
        if (useUsd) {
            const pi = Number(p.precio_terapia_individual_usd) || 55;
            const pp = Number(p.precio_terapia_pareja_usd) ?? pi;
            const pc = Number(p.precio_asesoria_crianza_usd) ?? pi;
            const svc = (servicio_interes || '').toLowerCase();
            monto = svc.includes('pareja') ? pp : (svc.includes('crianza') ? pc : pi);
            currency = 'usd';
            monto = Math.round(monto * 100);
        } else {
            const precioIndividual = Number(p.precio_terapia_individual) || 500;
            const precioPareja = Number(p.precio_terapia_pareja) ?? precioIndividual;
            const precioCrianza = Number(p.precio_asesoria_crianza) ?? precioIndividual;
            monto = precioIndividual;
            const svc = (servicio_interes || '').toLowerCase();
            if (svc.includes('pareja')) monto = precioPareja;
            else if (svc.includes('crianza')) monto = precioCrianza;
            currency = 'mxn';
            monto = Math.round(monto * 100);
        }

        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            line_items: [{
                price_data: {
                    currency,
                    unit_amount: monto,
                    product_data: {
                        name: servicio_interes || 'Sesión de psicoterapia',
                        description: `1 sesión - ${fecha} ${hora}`,
                    },
                },
                quantity: 1,
            }],
            success_url: `${BASE_URL}/catalogo?pago=exito`,
            cancel_url: `${BASE_URL}/catalogo`,
            metadata: {
                paciente_id: String(paciente_id),
                psicologo_id: String(psicologo_id),
                fecha,
                hora,
                ...(servicio_interes && { servicio_interes: String(servicio_interes) }),
            },
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error('Error crear sesión Stripe:', error);
        res.status(500).json({ error: 'No se pudo iniciar el pago. Intenta de nuevo.' });
    }
});

app.post('/api/agendar-cita', authRequired, async (req, res) => {
    const { psicologo_id, fecha, hora } = req.body;
    const paciente_id = req.session.usuario.id;

    if (!psicologo_id || !fecha || !hora) {
        return res.status(400).json({ error: 'Faltan datos para agendar' });
    }

    try {
        // Validar disponibilidad antes de agendar
        const fechaDate = new Date(fecha + 'T12:00:00');
        const diaSemana = fechaDate.getDay();

        // Verificar vacaciones
        const vacCheck = await pool.query(
            `SELECT id FROM vacaciones 
             WHERE psicologo_id = $1 
             AND $2::date BETWEEN fecha_inicio AND COALESCE(fecha_fin, fecha_inicio)`,
            [psicologo_id, fecha]
        );
        if (vacCheck.rows.length > 0) {
            return res.status(400).json({ error: 'El psicólogo no está disponible en esta fecha' });
        }

        // Verificar horario laboral
        const horarioCheck = await pool.query(
            `SELECT id FROM horario_laboral 
             WHERE psicologo_id = $1 AND dia_semana = $2
             AND $3::time >= hora_inicio AND $3::time < hora_fin`,
            [psicologo_id, diaSemana, hora]
        );
        if (horarioCheck.rows.length === 0) {
            return res.status(400).json({ error: 'El horario seleccionado no está disponible' });
        }

        // Verificar que no haya otra cita en ese horario
        const citaCheck = await pool.query(
            `SELECT id FROM citas 
             WHERE psicologo_id = $1 AND fecha = $2 AND hora = $3 AND estado NOT IN ('cancelada')`,
            [psicologo_id, fecha, hora]
        );
        if (citaCheck.rows.length > 0) {
            return res.status(400).json({ error: 'Este horario ya está ocupado' });
        }

        const insertResult = await pool.query(
            'INSERT INTO citas (paciente_id, psicologo_id, fecha, hora, link_sesion) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [paciente_id, psicologo_id, fecha, hora, `/perfil?sala=sesion-${paciente_id}-${psicologo_id}`]
        );
        const cita_id = insertResult.rows[0]?.id || null;
        try { await enviarCorreosCitaAgendada(paciente_id, psicologo_id, fecha, hora, cita_id); } catch (e) { console.error('Error enviando correos cita:', e); }
        res.json({ success: true, message: 'Cita agendada correctamente' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'No se pudo agendar la cita' });
    }
});

// Reagendar una cita existente (solo del paciente dueño)
app.post('/api/reagendar-cita', authRequired, async (req, res) => {
    const { cita_id, fecha, hora } = req.body;
    const paciente_id = req.session.usuario.id;

    if (!cita_id || !fecha || !hora) {
        return res.status(400).json({ error: 'Faltan datos para reagendar' });
    }

    try {
        // 1) Validar propiedad/estado/tiempo antes de reagendar
        const citaInfo = await pool.query(
            `SELECT 
                id,
                estado,
                EXTRACT(EPOCH FROM ((fecha + hora) - NOW())) AS seconds_until
             FROM citas
             WHERE id = $1 AND paciente_id = $2
             LIMIT 1`,
            [cita_id, paciente_id]
        );

        if (citaInfo.rows.length === 0) {
            return res.status(404).json({ error: 'Cita no encontrada' });
        }

        const { estado, seconds_until } = citaInfo.rows[0];

        if (!['pendiente', 'confirmada'].includes(estado)) {
            return res.status(403).json({ error: 'Solo puedes reagendar citas pendientes o confirmadas.' });
        }

        const hoursUntil = Number(seconds_until) / 3600;
        if (!(hoursUntil >= 24)) {
            return res.status(403).json({ error: 'Solo puedes reagendar con 24 horas de anticipación.' });
        }

        // Obtener psicologo_id de la cita
        const citaData = await pool.query('SELECT psicologo_id FROM citas WHERE id = $1', [cita_id]);
        const psicologo_id = citaData.rows[0]?.psicologo_id;

        // Validar disponibilidad del nuevo horario
        const fechaDate = new Date(fecha + 'T12:00:00');
        const diaSemana = fechaDate.getDay();

        // Verificar vacaciones
        const vacCheck = await pool.query(
            `SELECT id FROM vacaciones 
             WHERE psicologo_id = $1 
             AND $2::date BETWEEN fecha_inicio AND COALESCE(fecha_fin, fecha_inicio)`,
            [psicologo_id, fecha]
        );
        if (vacCheck.rows.length > 0) {
            return res.status(400).json({ error: 'El psicólogo no está disponible en esta fecha' });
        }

        // Verificar horario laboral
        const horarioCheck = await pool.query(
            `SELECT id FROM horario_laboral 
             WHERE psicologo_id = $1 AND dia_semana = $2
             AND $3::time >= hora_inicio AND $3::time < hora_fin`,
            [psicologo_id, diaSemana, hora]
        );
        if (horarioCheck.rows.length === 0) {
            return res.status(400).json({ error: 'El horario seleccionado no está disponible' });
        }

        // Verificar que no haya otra cita en ese horario (excluyendo la actual)
        const citaCheck = await pool.query(
            `SELECT id FROM citas 
             WHERE psicologo_id = $1 AND fecha = $2 AND hora = $3 AND id != $4 AND estado NOT IN ('cancelada')`,
            [psicologo_id, fecha, hora, cita_id]
        );
        if (citaCheck.rows.length > 0) {
            return res.status(400).json({ error: 'Este horario ya está ocupado' });
        }

        const result = await pool.query(
            `UPDATE citas
             SET fecha = $1, hora = $2, estado = 'pendiente'
             WHERE id = $3 AND paciente_id = $4
               AND estado IN ('pendiente', 'confirmada')
               AND ($1::date + $2::time) > NOW()
             RETURNING id`,
            [fecha, hora, cita_id, paciente_id]
        );

        if (result.rowCount === 0) {
            return res.status(400).json({ error: 'La nueva fecha/hora debe ser futura.' });
        }

        try { await enviarCorreosCitaReagendada(paciente_id, psicologo_id, fecha, hora, cita_id); } catch (e) { console.error('Error enviando correos reagendar:', e); }
        res.json({ success: true });
    } catch (error) {
        console.error("Error al reagendar cita:", error);
        res.status(500).json({ error: 'Error al reagendar cita' });
    }
});

// Cancelar una cita existente (solo del paciente dueño)
app.post('/api/cancelar-cita', authRequired, async (req, res) => {
    const { cita_id } = req.body;
    const paciente_id = req.session.usuario.id;

    if (!cita_id) {
        return res.status(400).json({ error: 'Falta cita_id' });
    }

    try {
        const citaInfo = await pool.query(
            `SELECT 
                id,
                estado,
                EXTRACT(EPOCH FROM ((fecha + hora) - NOW())) AS seconds_until
             FROM citas
             WHERE id = $1 AND paciente_id = $2
             LIMIT 1`,
            [cita_id, paciente_id]
        );

        if (citaInfo.rows.length === 0) {
            return res.status(404).json({ error: 'Cita no encontrada' });
        }

        const { estado, seconds_until } = citaInfo.rows[0];

        if (!['pendiente', 'confirmada'].includes(estado)) {
            return res.status(403).json({ error: 'Solo puedes cancelar citas pendientes o confirmadas.' });
        }

        const hoursUntil = Number(seconds_until) / 3600;
        if (!(hoursUntil >= 36)) {
            return res.status(403).json({ error: 'Solo puedes cancelar con 36 horas de anticipación.' });
        }

        const result = await pool.query(
            `UPDATE citas
             SET estado = 'cancelada'
             WHERE id = $1 AND paciente_id = $2 AND estado IN ('pendiente', 'confirmada')
             RETURNING id, fecha, hora, psicologo_id`,
            [cita_id, paciente_id]
        );

        if (result.rowCount === 0) {
            return res.status(403).json({ error: 'No se pudo cancelar esta cita' });
        }

        const row = result.rows[0];
        const psicologo_id = row.psicologo_id;
        // Normalizar fecha/hora: RETURNING puede devolver Date u otro formato; pasamos valor seguro
        let fechaCita = row.fecha;
        if (fechaCita instanceof Date) fechaCita = fechaCita.toISOString().slice(0, 10);
        else if (fechaCita != null) fechaCita = String(fechaCita).slice(0, 10);
        const horaCita = row.hora != null ? String(row.hora).substring(0, 5) : '';
        try { await enviarCorreosCitaCancelada(paciente_id, psicologo_id, fechaCita, horaCita, cita_id); } catch (e) { console.error('Error enviando correos cancelación:', e); }
        res.json({ success: true });
    } catch (error) {
        console.error("Error al cancelar cita:", error);
        res.status(500).json({ error: 'Error al cancelar cita' });
    }
});

// --- CONFIGURACIÓN PSICÓLOGO: HORARIO LABORAL ---
async function getPsicologoIdFromSession(req) {
    const userId = req.session?.usuario?.id;
    if (!userId) return null;
    const r = await pool.query('SELECT id FROM psicologos WHERE usuario_id = $1 LIMIT 1', [userId]);
    return r.rows.length ? r.rows[0].id : null;
}

app.get('/api/horario-laboral', authRequired, async (req, res) => {
    if (req.session.usuario.rol !== 'psicologo') return res.status(403).json({ error: 'Acceso denegado' });
    try {
        const psicologoId = await getPsicologoIdFromSession(req);
        if (!psicologoId) return res.status(404).json({ error: 'Perfil de psicólogo no encontrado' });

        const result = await pool.query(
            `SELECT id, psicologo_id, dia_semana, hora_inicio, hora_fin
             FROM horario_laboral
             WHERE psicologo_id = $1
             ORDER BY dia_semana ASC, hora_inicio ASC`,
            [psicologoId]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Error al obtener horario_laboral:', error);
        res.status(500).json({ error: 'Error al obtener horario' });
    }
});

app.post('/api/horario-laboral', authRequired, async (req, res) => {
    if (req.session.usuario.rol !== 'psicologo') return res.status(403).json({ error: 'Acceso denegado' });
    const { dia_semana, hora_inicio, hora_fin } = req.body;

    if (dia_semana === undefined || hora_inicio === undefined || hora_fin === undefined) {
        return res.status(400).json({ error: 'Faltan datos (dia_semana, hora_inicio, hora_fin)' });
    }

    try {
        const psicologoId = await getPsicologoIdFromSession(req);
        if (!psicologoId) return res.status(404).json({ error: 'Perfil de psicólogo no encontrado' });

        // Insert simple (si luego quieres upsert por día/hora, lo armamos con UNIQUE)
        const result = await pool.query(
            `INSERT INTO horario_laboral (psicologo_id, dia_semana, hora_inicio, hora_fin)
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [psicologoId, dia_semana, hora_inicio, hora_fin]
        );

        res.json({ success: true, id: result.rows[0].id });
    } catch (error) {
        console.error('Error al guardar horario_laboral:', error);
        res.status(500).json({ error: 'Error al guardar horario' });
    }
});

app.put('/api/horario-laboral/:id', authRequired, async (req, res) => {
    if (req.session.usuario.rol !== 'psicologo') return res.status(403).json({ error: 'Acceso denegado' });
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });

    const { dia_semana, hora_inicio, hora_fin } = req.body;
    if (dia_semana === undefined || hora_inicio === undefined || hora_fin === undefined) {
        return res.status(400).json({ error: 'Faltan datos (dia_semana, hora_inicio, hora_fin)' });
    }

    try {
        const psicologoId = await getPsicologoIdFromSession(req);
        if (!psicologoId) return res.status(404).json({ error: 'Perfil de psicólogo no encontrado' });

        const result = await pool.query(
            `UPDATE horario_laboral
             SET dia_semana = $1, hora_inicio = $2, hora_fin = $3
             WHERE id = $4 AND psicologo_id = $5`,
            [dia_semana, hora_inicio, hora_fin, id, psicologoId]
        );

        if (result.rowCount === 0) return res.status(404).json({ error: 'No encontrado' });
        res.json({ success: true });
    } catch (error) {
        console.error('Error al actualizar horario_laboral:', error);
        res.status(500).json({ error: 'Error al actualizar horario' });
    }
});

app.delete('/api/horario-laboral/:id', authRequired, async (req, res) => {
    if (req.session.usuario.rol !== 'psicologo') return res.status(403).json({ error: 'Acceso denegado' });
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    try {
        const psicologoId = await getPsicologoIdFromSession(req);
        if (!psicologoId) return res.status(404).json({ error: 'Perfil de psicólogo no encontrado' });

        const result = await pool.query(
            `DELETE FROM horario_laboral WHERE id = $1 AND psicologo_id = $2`,
            [id, psicologoId]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'No encontrado' });
        res.json({ success: true });
    } catch (error) {
        console.error('Error al borrar horario_laboral:', error);
        res.status(500).json({ error: 'Error al borrar horario' });
    }
});

// Ruta para actualizar el perfil del usuario
app.post('/api/update-profile', authRequired, async (req, res) => {
    const { nombre, telefono, password } = req.body;
    const usuarioId = req.session.usuario.id;

    try {
        console.log("Intentando actualizar usuario ID:", usuarioId); // Log de depuración

        if (password && password.trim() !== "" && password !== '********') {
            // Caso con contraseña nueva
            const hashedPassword = await bcrypt.hash(password, 10);
            await pool.query(
                'UPDATE usuarios SET nombre = $1, telefono = $2, password = $3 WHERE id = $4',
                [nombre, telefono, hashedPassword, usuarioId]
            );
        } else {
            // Caso sin cambiar contraseña
            await pool.query(
                'UPDATE usuarios SET nombre = $1, telefono = $2 WHERE id = $3',
                [nombre, telefono, usuarioId]
            );
        }

        // Actualizamos el nombre en la sesión para que el saludo cambie sin reloguear
        req.session.usuario.nombre = nombre;

        res.json({ success: true });
    } catch (error) {
        console.error("ERROR REAL EN EL SERVIDOR:", error); // MIRA ESTO EN TU TERMINAL
        res.status(500).send("Error interno: " + error.message);
    }
});

// --- CONFIGURACIÓN PSICÓLOGO: VACACIONES (bloqueo de fechas) ---
app.get('/api/vacaciones', authRequired, async (req, res) => {
    if (req.session.usuario.rol !== 'psicologo') return res.status(403).json({ error: 'Acceso denegado' });
    try {
        const psicologoId = await getPsicologoIdFromSession(req);
        if (!psicologoId) return res.status(404).json({ error: 'Perfil de psicólogo no encontrado' });

        const result = await pool.query(
            `SELECT id, psicologo_id, fecha_inicio, fecha_fin, motivo
             FROM vacaciones
             WHERE psicologo_id = $1
             ORDER BY fecha_inicio ASC`,
            [psicologoId]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Error al obtener vacaciones:', error);
        res.status(500).json({ error: 'Error al obtener vacaciones' });
    }
});

app.post('/api/vacaciones', authRequired, async (req, res) => {
    if (req.session.usuario.rol !== 'psicologo') return res.status(403).json({ error: 'Acceso denegado' });
    const { fecha_inicio, fecha_fin, motivo } = req.body;
    if (!fecha_inicio) return res.status(400).json({ error: 'fecha_inicio es requerida' });
    try {
        const psicologoId = await getPsicologoIdFromSession(req);
        if (!psicologoId) return res.status(404).json({ error: 'Perfil de psicólogo no encontrado' });

        const result = await pool.query(
            `INSERT INTO vacaciones (psicologo_id, fecha_inicio, fecha_fin, motivo)
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [psicologoId, fecha_inicio, fecha_fin || fecha_inicio, motivo || null]
        );
        res.json({ success: true, id: result.rows[0].id });
    } catch (error) {
        console.error('Error al guardar vacaciones:', error);
        res.status(500).json({ error: 'Error al guardar vacaciones' });
    }
});

app.delete('/api/vacaciones/:id', authRequired, async (req, res) => {
    if (req.session.usuario.rol !== 'psicologo') return res.status(403).json({ error: 'Acceso denegado' });
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    try {
        const psicologoId = await getPsicologoIdFromSession(req);
        if (!psicologoId) return res.status(404).json({ error: 'Perfil de psicólogo no encontrado' });

        const result = await pool.query(
            `DELETE FROM vacaciones WHERE id = $1 AND psicologo_id = $2`,
            [id, psicologoId]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'No encontrado' });
        res.json({ success: true });
    } catch (error) {
        console.error('Error al borrar vacaciones:', error);
        res.status(500).json({ error: 'Error al borrar vacaciones' });
    }
});

// ============================
// DOCUMENTOS DEL PSICÓLOGO
// ============================

const uploadsDir = path.join(__dirname, 'uploads', 'documentos');
if (!fs.existsSync(path.join(__dirname, 'uploads'))) fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const uploadDocumento = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const n = (file.originalname || '').toLowerCase();
        if (n.endsWith('.pdf') || n.endsWith('.doc') || n.endsWith('.docx')) return cb(null, true);
        cb(new Error('Solo se permiten archivos PDF o Word (.doc, .docx)'));
    }
}).single('archivo');

// Listar documentos (con tipo, ruta_archivo, orden)
app.get('/api/documentos', authRequired, async (req, res) => {
    if (req.session.usuario.rol !== 'psicologo') return res.status(403).json({ error: 'Acceso denegado' });
    try {
        const psicologoId = await getPsicologoIdFromSession(req);
        if (!psicologoId) return res.status(404).json({ error: 'Perfil de psicólogo no encontrado' });

        const result = await pool.query(
            `SELECT id, titulo, tipo, ruta_archivo, created_at, updated_at, orden 
             FROM documentos_psicologo 
             WHERE psicologo_id = $1 
             ORDER BY orden ASC NULLS LAST, updated_at DESC`,
            [psicologoId]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Error al listar documentos:', error);
        res.status(500).json({ error: 'Error al obtener documentos' });
    }
});

// Subir archivo Word o PDF
app.post('/api/documentos/upload', authRequired, (req, res) => {
    if (req.session.usuario.rol !== 'psicologo') return res.status(403).json({ error: 'Acceso denegado' });
    uploadDocumento(req, res, async (err) => {
        if (err) return res.status(400).json({ error: err.message || 'Error al subir' });
        if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'No se recibió ningún archivo' });
        try {
            const psicologoId = await getPsicologoIdFromSession(req);
            if (!psicologoId) return res.status(404).json({ error: 'Perfil de psicólogo no encontrado' });
            const nombreOriginal = (req.file.originalname || 'archivo').replace(/[^a-zA-Z0-9._-]/g, '_');
            const ext = path.extname(nombreOriginal).toLowerCase();
            const tipo = ext === '.pdf' ? 'pdf' : 'word';
            const subDir = path.join(uploadsDir, String(psicologoId));
            if (!fs.existsSync(subDir)) fs.mkdirSync(subDir, { recursive: true });
            const nombreGuardado = Date.now() + '-' + nombreOriginal;
            const rutaCompleta = path.join(subDir, nombreGuardado);
            fs.writeFileSync(rutaCompleta, req.file.buffer);
            const rutaRelativa = path.join('documentos', String(psicologoId), nombreGuardado);

            let contenido = '';
            if (ext === '.docx' || ext === '.doc') {
                try {
                    const result = await mammoth.extractRawText({ buffer: req.file.buffer });
                    contenido = result.value || '';
                } catch (_) { contenido = ''; }
            }
            const titulo = (req.file.originalname || 'Documento').replace(/\.[^.]+$/, '') || 'Sin título';

            const maxOrden = await pool.query(
                'SELECT COALESCE(MAX(orden), 0) + 1 AS next FROM documentos_psicologo WHERE psicologo_id = $1',
                [psicologoId]
            );
            const orden = maxOrden.rows[0].next;

            const result = await pool.query(
                `INSERT INTO documentos_psicologo (psicologo_id, titulo, contenido, tipo, ruta_archivo, orden) 
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                [psicologoId, titulo, contenido, tipo, rutaRelativa, orden]
            );
            res.json(result.rows[0]);
        } catch (error) {
            console.error('Error en upload documento:', error);
            res.status(500).json({ error: 'Error al guardar el documento' });
        }
    });
});

// Actualizar orden de documentos
app.put('/api/documentos/orden', authRequired, async (req, res) => {
    if (req.session.usuario.rol !== 'psicologo') return res.status(403).json({ error: 'Acceso denegado' });
    const ids = req.body.ids;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'Se requiere un array ids' });
    try {
        const psicologoId = await getPsicologoIdFromSession(req);
        if (!psicologoId) return res.status(404).json({ error: 'Perfil de psicólogo no encontrado' });
        for (let i = 0; i < ids.length; i++) {
            await pool.query(
                'UPDATE documentos_psicologo SET orden = $1 WHERE id = $2 AND psicologo_id = $3',
                [i, ids[i], psicologoId]
            );
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Error al actualizar orden:', error);
        res.status(500).json({ error: 'Error al actualizar orden' });
    }
});

// Servir archivo de un documento (solo psicólogo dueño)
app.get('/api/documentos/:id/archivo', authRequired, async (req, res) => {
    if (req.session.usuario.rol !== 'psicologo') return res.status(403).json({ error: 'Acceso denegado' });
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    try {
        const psicologoId = await getPsicologoIdFromSession(req);
        if (!psicologoId) return res.status(404).json({ error: 'Perfil no encontrado' });
        const doc = await pool.query(
            'SELECT ruta_archivo, tipo FROM documentos_psicologo WHERE id = $1 AND psicologo_id = $2',
            [id, psicologoId]
        );
        if (doc.rows.length === 0 || !doc.rows[0].ruta_archivo) return res.status(404).send('Archivo no encontrado');
        const rutaCompleta = path.join(__dirname, 'uploads', doc.rows[0].ruta_archivo);
        if (!fs.existsSync(rutaCompleta)) return res.status(404).send('Archivo no encontrado');
        const ruta = doc.rows[0].ruta_archivo || '';
        const contentType = ruta.toLowerCase().endsWith('.pdf') ? 'application/pdf'
            : ruta.toLowerCase().endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : 'application/msword';
        res.setHeader('Content-Type', contentType);
        res.sendFile(rutaCompleta);
    } catch (error) {
        console.error('Error al servir archivo:', error);
        res.status(500).send('Error');
    }
});

// Obtener un documento específico
app.get('/api/documentos/:id', authRequired, async (req, res) => {
    if (req.session.usuario.rol !== 'psicologo') return res.status(403).json({ error: 'Acceso denegado' });
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    try {
        const psicologoId = await getPsicologoIdFromSession(req);
        if (!psicologoId) return res.status(404).json({ error: 'Perfil de psicólogo no encontrado' });

        const result = await pool.query(
            `SELECT * FROM documentos_psicologo WHERE id = $1 AND psicologo_id = $2`,
            [id, psicologoId]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Documento no encontrado' });
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error al obtener documento:', error);
        res.status(500).json({ error: 'Error al obtener documento' });
    }
});

// Crear documento
app.post('/api/documentos', authRequired, async (req, res) => {
    if (req.session.usuario.rol !== 'psicologo') return res.status(403).json({ error: 'Acceso denegado' });
    try {
        const psicologoId = await getPsicologoIdFromSession(req);
        if (!psicologoId) return res.status(404).json({ error: 'Perfil de psicólogo no encontrado' });

        const { titulo, contenido } = req.body;
        const result = await pool.query(
            `INSERT INTO documentos_psicologo (psicologo_id, titulo, contenido) 
             VALUES ($1, $2, $3) 
             RETURNING *`,
            [psicologoId, titulo || 'Nuevo documento', contenido || '']
        );
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error al crear documento:', error);
        res.status(500).json({ error: 'Error al crear documento' });
    }
});

// Actualizar documento
app.put('/api/documentos/:id', authRequired, async (req, res) => {
    if (req.session.usuario.rol !== 'psicologo') return res.status(403).json({ error: 'Acceso denegado' });
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    try {
        const psicologoId = await getPsicologoIdFromSession(req);
        if (!psicologoId) return res.status(404).json({ error: 'Perfil de psicólogo no encontrado' });

        const { titulo, contenido } = req.body;
        const result = await pool.query(
            `UPDATE documentos_psicologo 
             SET titulo = COALESCE($1, titulo), 
                 contenido = COALESCE($2, contenido), 
                 updated_at = CURRENT_TIMESTAMP 
             WHERE id = $3 AND psicologo_id = $4 
             RETURNING *`,
            [titulo, contenido, id, psicologoId]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Documento no encontrado' });
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error al actualizar documento:', error);
        res.status(500).json({ error: 'Error al actualizar documento' });
    }
});

// Eliminar documento
app.delete('/api/documentos/:id', authRequired, async (req, res) => {
    if (req.session.usuario.rol !== 'psicologo') return res.status(403).json({ error: 'Acceso denegado' });
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    try {
        const psicologoId = await getPsicologoIdFromSession(req);
        if (!psicologoId) return res.status(404).json({ error: 'Perfil de psicólogo no encontrado' });

        const result = await pool.query(
            `DELETE FROM documentos_psicologo WHERE id = $1 AND psicologo_id = $2`,
            [id, psicologoId]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Documento no encontrado' });
        res.json({ success: true });
    } catch (error) {
        console.error('Error al eliminar documento:', error);
        res.status(500).json({ error: 'Error al eliminar documento' });
    }
});

app.get('/api/psicologo/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const pResult = await pool.query('SELECT * FROM psicologos WHERE id = $1', [id]);
        
        if (pResult.rows.length === 0) return res.status(404).send('No encontrado');

        const oResult = await pool.query(`
            SELECT o.*, u.nombre as paciente_nombre 
            FROM opiniones o 
            JOIN usuarios u ON o.paciente_id = u.id 
            WHERE o.psicologo_id = $1
            ORDER BY o.fecha DESC
        `, [id]);

        res.json({ datos: pResult.rows[0], opiniones: oResult.rows });
    } catch (error) {
        console.error("CRASH EN DETALLE PSICOLOGO:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// --- COLOCAR EN server.js ---

app.post('/api/dejar-opinion', authRequired, async (req, res) => {
    const { psicologo_id, comentario, estrellas } = req.body;
    const paciente_id = req.session.usuario.id;

    try {
        // 1. Verificación de cita (el candado que ya teníamos)
        const citaExistente = await pool.query(
            'SELECT id FROM citas WHERE paciente_id = $1 AND psicologo_id = $2 AND estado = \'realizada\' LIMIT 1',
            [paciente_id, psicologo_id]
        );

        if (citaExistente.rows.length === 0) {
            return res.status(403).json({ error: "No puedes opinar sin haber tenido una cita." });
        }

        // 2. Insertar la nueva opinión
        await pool.query(
            'INSERT INTO opiniones (psicologo_id, paciente_id, comentario, estrellas) VALUES ($1, $2, $3, $4)',
            [psicologo_id, paciente_id, comentario, estrellas]
        );

        // 3. Recalcular promedio y total de reseñas, y actualizar tabla psicologos
        const stats = await pool.query(
            'SELECT AVG(estrellas) as promedio, COUNT(*) as total FROM opiniones WHERE psicologo_id = $1',
            [psicologo_id]
        );
        
        const nuevoRating = parseFloat(stats.rows[0].promedio).toFixed(1);
        const totalResenas = parseInt(stats.rows[0].total, 10) || 0;

        // Actualizamos rating y total_resenas del psicólogo
        await pool.query(
            'UPDATE psicologos SET rating = $1, total_resenas = $2 WHERE id = $3',
            [nuevoRating, totalResenas, psicologo_id]
        );

        res.json({ mensaje: "¡Opinión guardada y rating actualizado!", nuevoRating });

    } catch (error) {
        console.error("Error completo:", error);
        res.status(500).json({ error: "Error al procesar la reseña" });
    }
});

// Borrar una fecha específica
app.delete('/api/borrar-fecha-especifica/:id', authRequired, async (req, res) => {
    try {
        await pool.query('DELETE FROM disponibilidad_especifica WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).send('Error');
    }
});

// Logout: Para cerrar la sesión
app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

// PRUEBA DE CONEXIÓN INMEDIATA
pool.connect((err, client, release) => {
    if (err) {
        return console.error('❌ ERROR AL CONECTAR A POSTGRES:', err.message);
    }
    console.log('✅ CONEXIÓN EXITOSA A LA BASE DE DATOS');
    release();
});

// A. Obtener lista de psicólogos con los que el paciente tiene citas
app.get('/api/mis-psicologos-contacto', authRequired, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT DISTINCT p.id, p.nombre, p.usuario_id 
             FROM psicologos p
             JOIN citas c ON p.id = c.psicologo_id
             WHERE c.paciente_id = $1`,
            [req.session.usuario.id]
        );
        res.json(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al obtener contactos');
    }
});

// B. Obtener historial de mensajes con un psicólogo específico
app.get('/api/mensajes/:destinatarioId', authRequired, async (req, res) => {
    const miId = req.session.usuario.id; 
    const suId = req.params.destinatarioId;

    if (!suId || suId === 'undefined' || isNaN(suId)) {
        return res.json({ mensajes: [], miId: miId }); 
    }

    try {
        // Validación para psicólogos: Solo pueden ver mensajes de pacientes con citas previas
        if (req.session.usuario.rol === 'psicologo') {
            const hasAppointment = await hasHadAppointment(miId, parseInt(suId));
            if (!hasAppointment) {
                return res.status(403).json({ error: "No tienes permiso para ver este historial de mensajes." });
            }
        }
        // Para pacientes, la lista de psicólogos con los que pueden chatear ya debería estar filtrada en el frontend.

        const result = await pool.query(
            `SELECT * FROM mensajes 
             WHERE (remitente_id = $1 AND destinatario_id = $2)
                OR (remitente_id = $2 AND destinatario_id = $1)
             ORDER BY fecha_envio ASC`,
            [miId, parseInt(suId)]
        );

        res.json({ 
            mensajes: result.rows, 
            miId: miId 
        });

    } catch (error) {
        console.error("Error en DB mensajes:", error);
        res.status(500).json({ error: 'Error al cargar mensajes' });
    }
});

// Ruta para que el frontend sepa quién está logueado
app.get('/api/quien-soy', authRequired, (req, res) => {
    res.json({ id: req.session.usuario.id });
});

// --- NOTAS POR CITA (PSICÓLOGO) ---
app.get('/api/citas/:citaId/notas', authRequired, async (req, res) => {
    if (!req.session.usuario || req.session.usuario.rol !== 'psicologo') {
        return res.status(403).json({ error: 'Acceso denegado' });
    }

    const citaId = parseInt(req.params.citaId, 10);
    if (Number.isNaN(citaId)) return res.status(400).json({ error: 'citaId inválido' });

    try {
        const result = await pool.query(
            `SELECT c.notas
             FROM citas c
             JOIN psicologos p ON c.psicologo_id = p.id
             WHERE c.id = $1 AND p.usuario_id = $2
             LIMIT 1`,
            [citaId, req.session.usuario.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Cita no encontrada' });
        }

        res.json({ notas: result.rows[0].notas || '' });
    } catch (error) {
        console.error('Error al obtener notas:', error);
        res.status(500).json({ error: 'Error al obtener notas' });
    }
});

app.post('/api/citas/:citaId/notas', authRequired, async (req, res) => {
    if (!req.session.usuario || req.session.usuario.rol !== 'psicologo') {
        return res.status(403).json({ error: 'Acceso denegado' });
    }

    const citaId = parseInt(req.params.citaId, 10);
    if (Number.isNaN(citaId)) return res.status(400).json({ error: 'citaId inválido' });

    const { notas } = req.body;
    const notasStr = (notas ?? '').toString();

    try {
        const result = await pool.query(
            `UPDATE citas c
             SET notas = $1
             FROM psicologos p
             WHERE c.id = $2 AND c.psicologo_id = p.id AND p.usuario_id = $3
             RETURNING c.id`,
            [notasStr, citaId, req.session.usuario.id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Cita no encontrada' });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error al guardar notas:', error);
        res.status(500).json({ error: 'Error al guardar notas' });
    }
});

// Registrar que el paciente o el psicólogo entró a la sala de video (para marcar cita como realizada cuando ambos entren)
app.post('/api/citas/:citaId/registrar-entrada', authRequired, async (req, res) => {
    const citaId = parseInt(req.params.citaId, 10);
    if (Number.isNaN(citaId)) return res.status(400).json({ error: 'citaId inválido' });
    const rol = req.body.rol === 'paciente' ? 'paciente' : req.body.rol === 'psicologo' ? 'psicologo' : null;
    if (!rol) return res.status(400).json({ error: 'rol debe ser "paciente" o "psicologo"' });

    try {
        if (rol === 'paciente') {
            const r = await pool.query(
                `UPDATE citas SET paciente_entro_at = COALESCE(paciente_entro_at, NOW())
                 WHERE id = $1 AND paciente_id = $2
                 RETURNING id, paciente_entro_at, psicologo_entro_at`,
                [citaId, req.session.usuario.id]
            );
            if (r.rows.length === 0) return res.status(404).json({ error: 'Cita no encontrada' });
            const row = r.rows[0];
            if (row.paciente_entro_at && row.psicologo_entro_at) {
                await pool.query(`UPDATE citas SET estado = 'realizada' WHERE id = $1`, [citaId]);
            }
            return res.json({ success: true, estado: row.paciente_entro_at && row.psicologo_entro_at ? 'realizada' : null });
        }
        // psicologo
        const r = await pool.query(
            `UPDATE citas c SET psicologo_entro_at = COALESCE(c.psicologo_entro_at, NOW())
             FROM psicologos p
             WHERE c.id = $1 AND c.psicologo_id = p.id AND p.usuario_id = $2
             RETURNING c.id, c.paciente_entro_at, c.psicologo_entro_at`,
            [citaId, req.session.usuario.id]
        );
        if (r.rows.length === 0) return res.status(404).json({ error: 'Cita no encontrada' });
        const row = r.rows[0];
        if (row.paciente_entro_at && row.psicologo_entro_at) {
            await pool.query(`UPDATE citas SET estado = 'realizada' WHERE id = $1`, [citaId]);
        }
        return res.json({ success: true, estado: row.paciente_entro_at && row.psicologo_entro_at ? 'realizada' : null });
    } catch (err) {
        if (err.code === '42703') return res.status(500).json({ error: 'Ejecuta la migración add_asistencia_sesion.sql en la base de datos' });
        console.error('Error registrar-entrada:', err);
        return res.status(500).json({ error: 'Error al registrar entrada' });
    }
});

// API para que el DOCTOR vea su agenda personal usando su EMAIL de sesión
app.get('/api/mis-citas-doctor', authRequired, async (req, res) => {
    try {
        await marcarCitasNoRealizadas();
        const query = `
            SELECT 
                c.id AS cita_id,
                c.fecha,
                c.hora,
                c.estado,
                c.link_sesion,
                c.notas,
                u.nombre AS paciente_nombre,
                u.id AS paciente_usuario_id,
                u.id AS id_para_chat
            FROM citas c
            JOIN vista_psicologos v ON c.psicologo_id = v.psicologo_id_tabla
            JOIN usuarios u ON c.paciente_id = u.id 
            WHERE v.usuario_id = $1
            ORDER BY c.fecha ASC, c.hora ASC`;

        const result = await pool.query(query, [req.session.usuario.id]);
        res.json(result.rows);
    } catch (error) {
        res.status(500).send("Error");
    }
});

// C. Enviar un nuevo mensaje
app.post('/api/enviar-mensaje', authRequired, async (req, res) => {
    const { destinatarioId, contenido } = req.body;
    const remitenteId = req.session.usuario.id;

    try {
        // Validación: Si el remitente es un psicólogo, debe haber tenido una cita previa con el paciente.
        if (req.session.usuario.rol === 'psicologo') {
            const hasAppointment = await hasHadAppointment(remitenteId, destinatarioId);
            if (!hasAppointment) {
                return res.status(403).json({ error: "No puedes enviar mensajes a este paciente sin una cita previa." });
            }
        }
        // Si el remitente es paciente, el `destinatarioId` debería ser de un psicólogo con quien ya tiene citas,
        // esto se manejaría en el frontend al mostrar solo los contactos válidos.

        await pool.query(
            'INSERT INTO mensajes (remitente_id, destinatario_id, contenido) VALUES ($1, $2, $3)',
            [remitenteId, destinatarioId, contenido]
        );
        enviarCorreoNotificacionChatSiAplica(destinatarioId, remitenteId).catch(e => console.error('Notif chat:', e.message));
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'No se pudo enviar el mensaje' });
    }
});

// Chat: subir adjunto PDF (solo PDF)
const uploadsChatDir = path.join(__dirname, 'uploads', 'chat');
if (!fs.existsSync(uploadsChatDir)) fs.mkdirSync(uploadsChatDir, { recursive: true });
const uploadChatPdf = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const n = (file.originalname || '').toLowerCase();
        if (n.endsWith('.pdf')) return cb(null, true);
        cb(new Error('Solo se permiten archivos PDF en el chat.'));
    }
}).single('archivo');

app.post('/api/chat/adjunto', authRequired, (req, res) => {
    uploadChatPdf(req, res, async (err) => {
        if (err) return res.status(400).json({ error: err.message || 'Error al subir' });
        if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'No se recibió ningún archivo PDF' });
        const destinatarioId = parseInt(req.body.destinatarioId, 10);
        if (!destinatarioId) return res.status(400).json({ error: 'Falta destinatarioId' });
        const remitenteId = req.session.usuario.id;
        try {
            if (req.session.usuario.rol === 'psicologo') {
                const hasAppointment = await hasHadAppointment(remitenteId, destinatarioId);
                if (!hasAppointment) return res.status(403).json({ error: 'No tienes permiso para enviar a este contacto.' });
            }
            const nombreOriginal = (req.file.originalname || 'documento.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
            if (!nombreOriginal.toLowerCase().endsWith('.pdf')) nombreOriginal += '.pdf';
            const subDir = path.join(uploadsChatDir, String(remitenteId));
            if (!fs.existsSync(subDir)) fs.mkdirSync(subDir, { recursive: true });
            const nombreGuardado = Date.now() + '-' + nombreOriginal;
            const rutaCompleta = path.join(subDir, nombreGuardado);
            fs.writeFileSync(rutaCompleta, req.file.buffer);
            const rutaRelativa = path.join('chat', String(remitenteId), nombreGuardado);
            await pool.query(
                'INSERT INTO mensajes (remitente_id, destinatario_id, contenido, ruta_adjunto, nombre_adjunto) VALUES ($1, $2, $3, $4, $5)',
                [remitenteId, destinatarioId, '[PDF adjunto]', rutaRelativa, req.file.originalname || nombreOriginal]
            );
            enviarCorreoNotificacionChatSiAplica(destinatarioId, remitenteId).catch(e => console.error('Notif chat:', e.message));
            res.json({ success: true });
        } catch (error) {
            console.error('Error chat adjunto:', error);
            res.status(500).json({ error: 'Error al enviar el archivo' });
        }
    });
});

// Servir archivo adjunto del chat (solo si eres remitente o destinatario)
app.get('/api/chat/archivo/:mensajeId', authRequired, async (req, res) => {
    const mensajeId = parseInt(req.params.mensajeId, 10);
    if (Number.isNaN(mensajeId)) return res.status(400).send('ID inválido');
    try {
        const r = await pool.query(
            'SELECT ruta_adjunto, nombre_adjunto, remitente_id, destinatario_id FROM mensajes WHERE id = $1',
            [mensajeId]
        );
        if (r.rows.length === 0 || !r.rows[0].ruta_adjunto) return res.status(404).send('Archivo no encontrado');
        const row = r.rows[0];
        const miId = req.session.usuario.id;
        if (row.remitente_id !== miId && row.destinatario_id !== miId) return res.status(403).send('No autorizado');
        const rutaCompleta = path.join(__dirname, 'uploads', row.ruta_adjunto);
        if (!fs.existsSync(rutaCompleta)) return res.status(404).send('Archivo no encontrado');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="' + (row.nombre_adjunto || 'documento.pdf') + '"');
        res.sendFile(rutaCompleta);
    } catch (error) {
        console.error('Error servir archivo chat:', error);
        res.status(500).send('Error');
    }
});

// 5. ENCENDIDO DEL SERVIDOR (Railway/hosting usan process.env.PORT)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('Servidor funcionando en puerto', PORT);
    ejecutarRecordatoriosCitas();
    setInterval(ejecutarRecordatoriosCitas, 5 * 60 * 1000);
});
