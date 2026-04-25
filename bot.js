// ╔══════════════════════════════════════════════════════════╗
// ║          NEXUSBOT v2.1 - TERMUX (ESTABLE)                ║
// ║          Fix: sin bucle, sin QR innecesario              ║
// ╚══════════════════════════════════════════════════════════╝

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers
} = require('@whiskeysockets/baileys');
const qrcode  = require('qrcode-terminal');
const pino    = require('pino');
const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const http    = require('http');

// ══════════════════════════════════════════
//  CONFIGURACIÓN
// ══════════════════════════════════════════
const CONFIG = {
    prefijo:      '!',
    nombre:       'NexusBot',
    version:      '2.1.0',
    authFolder:   'auth_info',
    dataFolder:   'bot_data',
    maxRetries:   10,
    // Versión fija de WA Web — evita fetchLatestBaileysVersion que puede colgar en Termux
    waVersion:    [2, 3000, 1015901307]
};

// ══════════════════════════════════════════
//  COLORES / LOG
// ══════════════════════════════════════════
const c = {
    r:'\x1b[0m', g:'\x1b[32m', y:'\x1b[33m', b:'\x1b[34m',
    m:'\x1b[35m', cy:'\x1b[36m', re:'\x1b[31m', bold:'\x1b[1m'
};
const log = {
    info:  (t) => console.log(`${c.cy}[INFO]${c.r}  ${t}`),
    ok:    (t) => console.log(`${c.g}[OK]${c.r}    ${t}`),
    warn:  (t) => console.log(`${c.y}[WARN]${c.r}  ${t}`),
    err:   (t) => console.log(`${c.re}[ERROR]${c.r} ${t}`),
    msg:   (t) => console.log(`${c.m}[MSG]${c.r}   ${t}`),
    cmd:   (t) => console.log(`${c.b}[CMD]${c.r}   ${t}`),
};

// ══════════════════════════════════════════
//  BASE DE DATOS LOCAL (JSON simple)
// ══════════════════════════════════════════
class DB {
    constructor() {
        if (!fs.existsSync(CONFIG.dataFolder)) fs.mkdirSync(CONFIG.dataFolder, { recursive: true });
        this.files = {
            respuestas: path.join(CONFIG.dataFolder, 'respuestas.json'),
            grupos:     path.join(CONFIG.dataFolder, 'grupos.json'),
            usuarios:   path.join(CONFIG.dataFolder, 'usuarios.json'),
            config:     path.join(CONFIG.dataFolder, 'config.json'),
        };
        const defaults = {
            respuestas: {},
            grupos:     {},
            usuarios:   {},
            config:     { dueno: '', admins: [] }
        };
        for (const [k, v] of Object.entries(defaults)) {
            if (!fs.existsSync(this.files[k])) this._write(k, v);
        }
    }
    _read(k)      { return JSON.parse(fs.readFileSync(this.files[k], 'utf8')); }
    _write(k, v)  { fs.writeFileSync(this.files[k], JSON.stringify(v, null, 2)); }

    getCfg()          { return this._read('config'); }
    setCfg(patch)     { this._write('config', { ...this._read('config'), ...patch }); }

    getRespuestas()           { return this._read('respuestas'); }
    addResp(trigger, texto)   { const d = this._read('respuestas'); d[trigger.toLowerCase()] = texto; this._write('respuestas', d); }
    delResp(trigger)          { const d = this._read('respuestas'); delete d[trigger.toLowerCase()]; this._write('respuestas', d); }

    getGrupo(jid) {
        const d = this._read('grupos');
        if (!d[jid]) { d[jid] = { bienvenida:true, despedida:true, antilink:false, soloAdmins:false }; this._write('grupos', d); }
        return d[jid];
    }
    setGrupo(jid, patch) { const d = this._read('grupos'); d[jid] = { ...this.getGrupo(jid), ...patch }; this._write('grupos', d); }

    getUser(num) {
        const d = this._read('usuarios');
        if (!d[num]) { d[num] = { msgs:0, ban:false, warns:0 }; this._write('usuarios', d); }
        return d[num];
    }
    setUser(num, patch) { const d = this._read('usuarios'); d[num] = { ...this.getUser(num), ...patch }; this._write('usuarios', d); }
}

// ══════════════════════════════════════════
//  UTILIDADES
// ══════════════════════════════════════════
const U = {
    jidNum:   (jid) => jid.replace(/[@:].*/g, '').replace(/\D/g,''),
    esGrupo:  (jid) => jid.endsWith('@g.us'),

    uptime() {
        const s = Math.floor(process.uptime());
        return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m ${s%60}s`;
    },

    fechaHora() {
        const n = new Date();
        return {
            fecha: n.toLocaleDateString('es-ES', { weekday:'long', year:'numeric', month:'long', day:'numeric' }),
            hora:  n.toLocaleTimeString('es-ES', { hour:'2-digit', minute:'2-digit', second:'2-digit' })
        };
    },

    bytes(b) {
        if (b < 1024) return b + ' B';
        if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
        return (b/1048576).toFixed(1) + ' MB';
    },

    fetchJSON(url, timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            const mod = url.startsWith('https') ? https : http;
            let raw = '';
            const req = mod.get(url, { headers: { 'User-Agent': 'NexusBot/2.1' } }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    return U.fetchJSON(res.headers.location, timeoutMs).then(resolve).catch(reject);
                }
                res.on('data', d => raw += d);
                res.on('end', () => {
                    try { resolve(JSON.parse(raw)); }
                    catch { resolve({ _raw: raw }); }
                });
                res.on('error', reject);
            });
            req.on('error', reject);
            req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
        });
    },

    getMsgText(msg) {
        return (
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption ||
            ''
        ).trim();
    },

    getMentions(msg) {
        return msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    }
};

// ══════════════════════════════════════════
//  COMANDOS
//  Firma: async (sock, msg, args, ctx)
//  ctx = { db, jid, numero, esAdmin, esAdminBot, esDueno, esGrupo }
// ══════════════════════════════════════════
const CMD = {

    async menu(sock, msg, args, { jid }) {
        const p = CONFIG.prefijo;
        await sock.sendMessage(jid, { text:
`╔═══════════════════════╗
║  🤖 *${CONFIG.nombre} v${CONFIG.version}*  ║
╚═══════════════════════╝

*📌 GENERALES*
${p}menu · ${p}info · ${p}ping · ${p}hora · ${p}uptime

*🌐 APIS GRATUITAS*
${p}clima [ciudad] — Clima actual
${p}wiki [tema] — Wikipedia ES
${p}yt [url] — Info YouTube
${p}ig [url] — Info Instagram
${p}tiktok [url] — Info TikTok

*🎲 DIVERSIÓN*
${p}dado · ${p}moneda · ${p}calc [expr]
${p}8ball [pregunta] · ${p}frase · ${p}chiste

*🤖 RESPUESTAS AUTO (admin)*
${p}addresp [trigger] | [respuesta]
${p}delresp [trigger]
${p}listresp

*👥 GRUPOS (admin grupo)*
${p}bienvenida on/off
${p}despedida on/off
${p}antilink on/off
${p}soloadmins on/off
${p}kick @u · ${p}promote @u · ${p}demote @u
${p}warn @u · ${p}ban @u

*🔑 OWNER*
${p}addadmin @u · ${p}deladmin @u
${p}reiniciar`
        });
    },

    async info(sock, msg, args, { jid }) {
        const { fecha, hora } = U.fechaHora();
        const mem = process.memoryUsage();
        await sock.sendMessage(jid, { text:
`🤖 *${CONFIG.nombre} v${CONFIG.version}*

• *Node.js:* ${process.version}
• *Uptime:* ${U.uptime()}
• *RAM:* ${U.bytes(mem.heapUsed)} / ${U.bytes(mem.heapTotal)}
• *Fecha:* ${fecha}
• *Hora:* ${hora}
• *Plataforma:* Termux / Android`
        });
    },

    async ping(sock, msg, args, { jid }) {
        const t = Date.now();
        await sock.sendMessage(jid, { text: `🏓 *Pong!* — ${Date.now() - t}ms` });
    },

    async hora(sock, msg, args, { jid }) {
        const { fecha, hora } = U.fechaHora();
        await sock.sendMessage(jid, { text: `🕐 *Hora:* ${hora}\n📅 *Fecha:* ${fecha}` });
    },

    async uptime(sock, msg, args, { jid }) {
        await sock.sendMessage(jid, { text: `⏱️ *Uptime:* ${U.uptime()}` });
    },

    async dado(sock, msg, args, { jid }) {
        const n = Math.floor(Math.random() * 6) + 1;
        const e = ['','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣'];
        await sock.sendMessage(jid, { text: `🎲 *Dado:* ${e[n]} (${n})` });
    },

    async moneda(sock, msg, args, { jid }) {
        await sock.sendMessage(jid, { text: Math.random() > .5 ? '🪙 *¡CARA!*' : '🪙 *¡CRUZ!*' });
    },

    async calc(sock, msg, args, { jid }) {
        if (!args.length) return sock.sendMessage(jid, { text: '🔢 Uso: !calc 2+2*3' });
        const expr = args.join('').replace(/[^0-9+\-*/().,% ]/g, '');
        try {
            // eslint-disable-next-line no-new-func
            const res = Function('"use strict"; return (' + expr + ')')();
            await sock.sendMessage(jid, { text: `🔢 *${expr}* = *${res}*` });
        } catch {
            await sock.sendMessage(jid, { text: '❌ Expresión inválida.' });
        }
    },

    async '8ball'(sock, msg, args, { jid }) {
        if (!args.length) return sock.sendMessage(jid, { text: '❓ Escribe una pregunta.' });
        const opts = [
            '✅ Sí, definitivamente.','✅ Es muy probable.','✅ Puedes contar con ello.',
            '⚠️ No es seguro.','⚠️ Las señales son confusas.','⚠️ Vuelve a intentarlo.',
            '❌ No cuentes con ello.','❌ Mis fuentes dicen que no.','❌ La perspectiva no es buena.'
        ];
        await sock.sendMessage(jid, { text:
            `🎱 *8-Ball*\n❓ ${args.join(' ')}\n🔮 ${opts[Math.floor(Math.random()*opts.length)]}`
        });
    },

    async frase(sock, msg, args, { jid }) {
        const list = [
            '"El éxito no es definitivo, el fracaso no es fatal." — Churchill',
            '"No cuentes los días, haz que los días cuenten." — Muhammad Ali',
            '"La vida es lo que pasa mientras haces otros planes." — John Lennon',
            '"Sé el cambio que deseas ver en el mundo." — Gandhi',
            '"El único modo de hacer un gran trabajo es amar lo que haces." — Steve Jobs',
            '"La imaginación es más importante que el conocimiento." — Einstein',
        ];
        await sock.sendMessage(jid, { text: `💬 _${list[Math.floor(Math.random()*list.length)]}_` });
    },

    async chiste(sock, msg, args, { jid }) {
        const list = [
            '¿Por qué los programadores prefieren el frío? Porque tienen miedo a los bugs.',
            'Mi contraseña es "incorrecto". Así cuando me equivoco, el sistema me dice cuál es.',
            '¿Cómo llama un Java developer a su café? Java.',
            '¿Por qué los programadores usan gafas oscuras? Porque no les gusta el #FFFFFF.',
            'Un DBA entra a un bar y pide una mesa para 1.000.000 de personas.',
        ];
        await sock.sendMessage(jid, { text: `😂 ${list[Math.floor(Math.random()*list.length)]}` });
    },

    async clima(sock, msg, args, { jid }) {
        if (!args.length) return sock.sendMessage(jid, { text: '🌤️ Uso: !clima Madrid' });
        try {
            const ciudad = encodeURIComponent(args.join(' '));
            const data = await U.fetchJSON(`https://wttr.in/${ciudad}?format=j1`);
            if (!data.current_condition) throw new Error('no encontrado');
            const cc   = data.current_condition[0];
            const area = data.nearest_area?.[0];
            await sock.sendMessage(jid, { text:
`🌍 *Clima en ${area?.areaName?.[0]?.value || args.join(' ')}, ${area?.country?.[0]?.value || ''}*

🌡️ *Temp:* ${cc.temp_C}°C / ${cc.temp_F}°F
💧 *Humedad:* ${cc.humidity}%
💨 *Viento:* ${cc.windspeedKmph} km/h
☁️ *Condición:* ${cc.weatherDesc?.[0]?.value || 'N/A'}
🌡️ *Sensación:* ${cc.FeelsLikeC}°C
👁️ *Visibilidad:* ${cc.visibility} km`
            });
        } catch {
            await sock.sendMessage(jid, { text: `❌ No pude obtener el clima de "${args.join(' ')}".` });
        }
    },

    async wiki(sock, msg, args, { jid }) {
        if (!args.length) return sock.sendMessage(jid, { text: '📖 Uso: !wiki Node.js' });
        try {
            const tema = encodeURIComponent(args.join(' '));
            const data = await U.fetchJSON(`https://es.wikipedia.org/api/rest_v1/page/summary/${tema}`);
            if (!data.extract) throw new Error('no encontrado');
            await sock.sendMessage(jid, { text:
                `📖 *${data.title}*\n\n${data.extract.substring(0, 700)}...\n\n🔗 ${data.content_urls?.desktop?.page || ''}`
            });
        } catch {
            await sock.sendMessage(jid, { text: `❌ No encontré "${args.join(' ')}" en Wikipedia.` });
        }
    },

    async yt(sock, msg, args, { jid }) {
        if (!args.length) return sock.sendMessage(jid, { text: '▶️ Uso: !yt [url de YouTube]' });
        try {
            const url  = args[0];
            const data = await U.fetchJSON(`https://noembed.com/embed?url=${encodeURIComponent(url)}`);
            if (data.error || !data.title) throw new Error('no encontrado');
            await sock.sendMessage(jid, { text:
`▶️ *YouTube*
📌 *Título:* ${data.title}
👤 *Canal:* ${data.author_name || 'N/A'}
🔗 ${url}

💡 _Para descargar en Termux:_
\`yt-dlp "${url}"\`
\`yt-dlp -x --audio-format mp3 "${url}"\` _(solo audio)_`
            });
        } catch {
            await sock.sendMessage(jid, { text: '❌ No pude obtener info. Verifica la URL.' });
        }
    },

    async ig(sock, msg, args, { jid }) {
        if (!args.length) return sock.sendMessage(jid, { text: '📸 Uso: !ig [url de Instagram]' });
        try {
            const data = await U.fetchJSON(`https://noembed.com/embed?url=${encodeURIComponent(args[0])}`);
            if (data.error || !data.title) throw new Error();
            await sock.sendMessage(jid, { text: `📸 *Instagram*\n📌 ${data.title}\n👤 ${data.author_name || 'N/A'}\n🔗 ${args[0]}` });
        } catch {
            await sock.sendMessage(jid, { text: '❌ No pude obtener info del post.' });
        }
    },

    async tiktok(sock, msg, args, { jid }) {
        if (!args.length) return sock.sendMessage(jid, { text: '🎵 Uso: !tiktok [url]' });
        try {
            const data = await U.fetchJSON(`https://noembed.com/embed?url=${encodeURIComponent(args[0])}`);
            if (data.error || !data.title) throw new Error();
            await sock.sendMessage(jid, { text: `🎵 *TikTok*\n📌 ${data.title}\n👤 ${data.author_name || 'N/A'}\n🔗 ${args[0]}` });
        } catch {
            await sock.sendMessage(jid, { text: '❌ No pude obtener info del video.' });
        }
    },

    // ── RESPUESTAS AUTOMÁTICAS ───────────────────────────────
    async addresp(sock, msg, args, { jid, db, esAdminBot }) {
        if (!esAdminBot) return sock.sendMessage(jid, { text: '❌ Solo admins del bot.' });
        const full   = args.join(' ');
        const partes = full.split('|');
        if (partes.length < 2) return sock.sendMessage(jid, { text: '❌ Uso: !addresp hola mundo | ¡Hola!' });
        const trigger = partes[0].trim();
        const texto   = partes.slice(1).join('|').trim();
        db.addResp(trigger, texto);
        await sock.sendMessage(jid, { text: `✅ Guardado:\n🔹 *"${trigger}"* → ${texto}` });
    },

    async delresp(sock, msg, args, { jid, db, esAdminBot }) {
        if (!esAdminBot) return sock.sendMessage(jid, { text: '❌ Solo admins del bot.' });
        if (!args.length) return sock.sendMessage(jid, { text: '❌ Uso: !delresp trigger' });
        db.delResp(args.join(' '));
        await sock.sendMessage(jid, { text: `✅ Respuesta "${args.join(' ')}" eliminada.` });
    },

    async listresp(sock, msg, args, { jid, db, esAdminBot }) {
        if (!esAdminBot) return sock.sendMessage(jid, { text: '❌ Solo admins del bot.' });
        const resps = db.getRespuestas();
        const keys  = Object.keys(resps);
        if (!keys.length) return sock.sendMessage(jid, { text: '📭 Sin respuestas automáticas guardadas.' });
        let txt = `🤖 *RESPUESTAS AUTO (${keys.length})*\n\n`;
        keys.forEach((k, i) => { txt += `${i+1}. *${k}* → ${resps[k]}\n`; });
        await sock.sendMessage(jid, { text: txt });
    },

    // ── ADMIN GRUPOS ─────────────────────────────────────────
    async bienvenida(sock, msg, args, { jid, db, esAdmin, esGrupo }) {
        if (!esGrupo)  return sock.sendMessage(jid, { text: '❌ Solo en grupos.' });
        if (!esAdmin)  return sock.sendMessage(jid, { text: '❌ Solo admins.' });
        const on = args[0] === 'on';
        db.setGrupo(jid, { bienvenida: on });
        await sock.sendMessage(jid, { text: `👋 Bienvenida *${on ? 'activada ✅':'desactivada ❌'}*` });
    },

    async despedida(sock, msg, args, { jid, db, esAdmin, esGrupo }) {
        if (!esGrupo)  return sock.sendMessage(jid, { text: '❌ Solo en grupos.' });
        if (!esAdmin)  return sock.sendMessage(jid, { text: '❌ Solo admins.' });
        const on = args[0] === 'on';
        db.setGrupo(jid, { despedida: on });
        await sock.sendMessage(jid, { text: `🚪 Despedida *${on ? 'activada ✅':'desactivada ❌'}*` });
    },

    async antilink(sock, msg, args, { jid, db, esAdmin, esGrupo }) {
        if (!esGrupo)  return sock.sendMessage(jid, { text: '❌ Solo en grupos.' });
        if (!esAdmin)  return sock.sendMessage(jid, { text: '❌ Solo admins.' });
        const on = args[0] === 'on';
        db.setGrupo(jid, { antilink: on });
        await sock.sendMessage(jid, { text: `🔗 Anti-link *${on ? 'activado ✅':'desactivado ❌'}*` });
    },

    async soloadmins(sock, msg, args, { jid, db, esAdmin, esGrupo }) {
        if (!esGrupo)  return sock.sendMessage(jid, { text: '❌ Solo en grupos.' });
        if (!esAdmin)  return sock.sendMessage(jid, { text: '❌ Solo admins.' });
        const on = args[0] === 'on';
        db.setGrupo(jid, { soloAdmins: on });
        await sock.sendMessage(jid, { text: `🔒 Solo admins *${on ? 'activado ✅':'desactivado ❌'}*` });
    },

    async kick(sock, msg, args, { jid, esAdmin, esGrupo }) {
        if (!esGrupo)  return sock.sendMessage(jid, { text: '❌ Solo en grupos.' });
        if (!esAdmin)  return sock.sendMessage(jid, { text: '❌ Solo admins.' });
        const menciones = U.getMentions(msg);
        if (!menciones.length) return sock.sendMessage(jid, { text: '❌ Uso: !kick @usuario' });
        await sock.groupParticipantsUpdate(jid, menciones, 'remove');
        await sock.sendMessage(jid, { text: '✅ Usuario expulsado.' });
    },

    async promote(sock, msg, args, { jid, esAdmin, esGrupo }) {
        if (!esGrupo)  return sock.sendMessage(jid, { text: '❌ Solo en grupos.' });
        if (!esAdmin)  return sock.sendMessage(jid, { text: '❌ Solo admins.' });
        const menciones = U.getMentions(msg);
        if (!menciones.length) return sock.sendMessage(jid, { text: '❌ Uso: !promote @usuario' });
        await sock.groupParticipantsUpdate(jid, menciones, 'promote');
        await sock.sendMessage(jid, { text: '✅ Usuario promovido a admin.' });
    },

    async demote(sock, msg, args, { jid, esAdmin, esGrupo }) {
        if (!esGrupo)  return sock.sendMessage(jid, { text: '❌ Solo en grupos.' });
        if (!esAdmin)  return sock.sendMessage(jid, { text: '❌ Solo admins.' });
        const menciones = U.getMentions(msg);
        if (!menciones.length) return sock.sendMessage(jid, { text: '❌ Uso: !demote @usuario' });
        await sock.groupParticipantsUpdate(jid, menciones, 'demote');
        await sock.sendMessage(jid, { text: '✅ Rango de admin removido.' });
    },

    async warn(sock, msg, args, { jid, db, esAdmin, esGrupo }) {
        if (!esGrupo)  return sock.sendMessage(jid, { text: '❌ Solo en grupos.' });
        if (!esAdmin)  return sock.sendMessage(jid, { text: '❌ Solo admins.' });
        const menciones = U.getMentions(msg);
        if (!menciones.length) return sock.sendMessage(jid, { text: '❌ Uso: !warn @usuario' });
        const num = U.jidNum(menciones[0]);
        const u   = db.getUser(num);
        u.warns   = (u.warns || 0) + 1;
        db.setUser(num, u);
        await sock.sendMessage(jid, {
            text: `⚠️ *ADVERTENCIA ${u.warns}/3* a @${num}`,
            mentions: menciones
        });
        if (u.warns >= 3) {
            await sock.sendMessage(jid, { text: `🔨 @${num} → 3 advertencias. Expulsado.`, mentions: menciones });
            try { await sock.groupParticipantsUpdate(jid, menciones, 'remove'); } catch {}
            db.setUser(num, { warns: 0 });
        }
    },

    async ban(sock, msg, args, { jid, db, esAdminBot }) {
        if (!esAdminBot) return sock.sendMessage(jid, { text: '❌ Solo admins del bot.' });
        const menciones = U.getMentions(msg);
        if (!menciones.length) return sock.sendMessage(jid, { text: '❌ Uso: !ban @usuario' });
        const num = U.jidNum(menciones[0]);
        db.setUser(num, { ban: true });
        await sock.sendMessage(jid, { text: `🔨 @${num} baneado del bot.`, mentions: menciones });
    },

    // ── OWNER ────────────────────────────────────────────────
    async addadmin(sock, msg, args, { jid, db, esDueno }) {
        if (!esDueno) return sock.sendMessage(jid, { text: '❌ Solo el dueño.' });
        const menciones = U.getMentions(msg);
        const num = menciones[0] ? U.jidNum(menciones[0]) : args[0]?.replace(/\D/g,'');
        if (!num) return sock.sendMessage(jid, { text: '❌ Uso: !addadmin @usuario' });
        const cfg = db.getCfg();
        if (!cfg.admins.includes(num)) cfg.admins.push(num);
        db.setCfg(cfg);
        await sock.sendMessage(jid, { text: `✅ ${num} es ahora admin del bot.` });
    },

    async deladmin(sock, msg, args, { jid, db, esDueno }) {
        if (!esDueno) return sock.sendMessage(jid, { text: '❌ Solo el dueño.' });
        const menciones = U.getMentions(msg);
        const num = menciones[0] ? U.jidNum(menciones[0]) : args[0]?.replace(/\D/g,'');
        if (!num) return sock.sendMessage(jid, { text: '❌ Uso: !deladmin @usuario' });
        const cfg = db.getCfg();
        cfg.admins = cfg.admins.filter(a => a !== num);
        db.setCfg(cfg);
        await sock.sendMessage(jid, { text: `✅ ${num} removido de admins.` });
    },

    async reiniciar(sock, msg, args, { jid, esAdminBot }) {
        if (!esAdminBot) return sock.sendMessage(jid, { text: '❌ Sin permiso.' });
        await sock.sendMessage(jid, { text: '🔄 Reiniciando...' });
        setTimeout(() => process.exit(0), 1500);
    },
};

// ══════════════════════════════════════════
//  NÚCLEO DEL BOT
//  - bandera `conectando` evita instancias duplicadas
//  - versión de WA fija (sin fetchLatestBaileysVersion)
//  - backoff exponencial en reconexión
// ══════════════════════════════════════════
const db       = new DB();
let conectando = false;
let retries    = 0;

async function iniciarBot() {
    if (conectando) return;
    conectando = true;

    try {
        const { state, saveCreds } = await useMultiFileAuthState(CONFIG.authFolder);

        const sock = makeWASocket({
            version:                CONFIG.waVersion,
            printQRInTerminal:      false,
            auth:                   state,
            logger:                 pino({ level: 'silent' }),
            browser:                Browsers.ubuntu('NexusBot'),
            syncFullHistory:        false,
            markOnlineOnConnect:    false,
            retryRequestDelayMs:    2000,
            maxMsgRetryCount:       3,
        });

        sock.ev.on('creds.update', saveCreds);

        // ── Conexión ──────────────────────────────────────────
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log(`\n${c.y}📱 ESCANEA EL QR CON WHATSAPP:${c.r}`);
                qrcode.generate(qr, { small: true });
                log.warn('QR generado — tienes ~60s para escanearlo');
            }

            if (connection === 'open') {
                retries    = 0;
                conectando = false;

                const numero = U.jidNum(sock.user.id);

                // Registrar dueño la primera vez
                const cfg = db.getCfg();
                if (!cfg.dueno) {
                    cfg.dueno = numero;
                    if (!cfg.admins.includes(numero)) cfg.admins.unshift(numero);
                    db.setCfg(cfg);
                    log.ok(`Dueño registrado: ${numero}`);
                }

                console.log(`\n${c.bold}${c.g}╔══════════════════════════════╗${c.r}`);
                console.log(`${c.bold}${c.g}║  ✅ NEXUSBOT CONECTADO       ║${c.r}`);
                console.log(`${c.bold}${c.g}║  📱 ${numero.padEnd(26)}║${c.r}`);
                console.log(`${c.bold}${c.g}║  ⏱️  Uptime: ${U.uptime().padEnd(19)}║${c.r}`);
                console.log(`${c.bold}${c.g}╚══════════════════════════════╝${c.r}\n`);

                // Notificar al dueño
                setTimeout(async () => {
                    try {
                        await sock.sendMessage(`${numero}@s.whatsapp.net`, {
                            text: `🤖 *${CONFIG.nombre} v${CONFIG.version}* listo\n✅ Escribe *!menu* para ver los comandos.`
                        });
                    } catch(e) {
                        log.warn('No se pudo enviar mensaje de inicio: ' + e.message);
                    }
                }, 4000);
            }

            if (connection === 'close') {
                conectando = false;
                const code = lastDisconnect?.error?.output?.statusCode;
                log.warn(`Conexión cerrada — código: ${code ?? 'desconocido'}`);

                // Sesión expirada → salir y avisar
                if (code === DisconnectReason.loggedOut || code === 401) {
                    log.err('Sesión inválida o cerrada desde el teléfono.');
                    log.err('Ejecuta: rm -rf auth_info && node bot.js');
                    process.exit(1);
                }

                // Cualquier otro corte → reintentar con backoff
                if (retries < CONFIG.maxRetries) {
                    retries++;
                    const delay = Math.min(3000 * retries, 60000);
                    log.info(`Reconectando en ${delay/1000}s (intento ${retries}/${CONFIG.maxRetries})...`);
                    setTimeout(iniciarBot, delay);
                } else {
                    log.err('Demasiados reintentos. Reinicia manualmente con: node bot.js');
                    process.exit(1);
                }
            }
        });

        // ── Mensajes ──────────────────────────────────────────
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const msg of messages) {
                if (msg.key.fromMe)              continue;
                if (!msg.message)                continue;
                const jid = msg.key.remoteJid;
                if (jid === 'status@broadcast')  continue;

                const texto = U.getMsgText(msg);
                if (!texto)                      continue;

                const esGrupo = U.esGrupo(jid);
                const numero  = msg.key.participant ? U.jidNum(msg.key.participant) : U.jidNum(jid);

                // Ban check
                const usuario = db.getUser(numero);
                if (usuario.ban) continue;
                db.setUser(numero, { msgs: (usuario.msgs || 0) + 1 });

                // Permisos
                const cfg        = db.getCfg();
                const esDueno    = numero === cfg.dueno;
                const esAdminBot = esDueno || cfg.admins.includes(numero);

                let esAdminGrupo = false;
                if (esGrupo) {
                    try {
                        const meta = await sock.groupMetadata(jid);
                        const p    = meta.participants.find(p => U.jidNum(p.id) === numero);
                        esAdminGrupo = p?.admin != null;
                    } catch { /* sin acceso */ }
                }

                const esAdmin = esAdminBot || esAdminGrupo;
                const ctx     = { db, jid, numero, esAdmin, esAdminBot, esDueno, esGrupo };

                // Moderación de grupo
                if (esGrupo) {
                    const gcfg = db.getGrupo(jid);

                    if (gcfg.antilink && !esAdmin) {
                        if (/https?:\/\/|wa\.me\/|t\.me\/|bit\.ly/i.test(texto)) {
                            await sock.sendMessage(jid, {
                                text: `⛔ @${numero} Los enlaces no están permitidos.`,
                                mentions: [`${numero}@s.whatsapp.net`]
                            });
                            try { await sock.groupParticipantsUpdate(jid, [`${numero}@s.whatsapp.net`], 'remove'); } catch {}
                            continue;
                        }
                    }

                    if (gcfg.soloAdmins && !esAdmin) {
                        try { await sock.sendMessage(jid, { delete: msg.key }); } catch {}
                        continue;
                    }
                }

                // Respuestas automáticas
                const resps = db.getRespuestas();
                const match = resps[texto.toLowerCase()];
                if (match) {
                    await sock.sendMessage(jid, { text: match }).catch(() => {});
                    log.msg(`Auto-resp: "${texto}" → "${match}"`);
                }

                // Comandos
                if (!texto.startsWith(CONFIG.prefijo)) continue;

                const parts = texto.slice(CONFIG.prefijo.length).trim().split(/\s+/);
                const cmd   = parts[0].toLowerCase();
                const args  = parts.slice(1);

                log.cmd(`[${numero}] !${cmd}${args.length ? ' ' + args.join(' ') : ''}`);

                if (CMD[cmd]) {
                    try {
                        await CMD[cmd](sock, msg, args, ctx);
                    } catch(e) {
                        log.err(`Error en !${cmd}: ${e.message}`);
                        await sock.sendMessage(jid, { text: `⚠️ Error en !${cmd}: ${e.message}` }).catch(() => {});
                    }
                } else {
                    await sock.sendMessage(jid, {
                        text: `❓ *!${cmd}* no existe. Escribe *!menu* para ver los comandos.`
                    }).catch(() => {});
                }
            }
        });

        // ── Bienvenida / Despedida ────────────────────────────
        sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
            try {
                const gcfg = db.getGrupo(id);
                const meta = await sock.groupMetadata(id);
                const total = meta.participants.length;

                if (action === 'add' && gcfg.bienvenida) {
                    for (const p of participants) {
                        await sock.sendMessage(id, {
                            text: `👋 *¡Bienvenido/a!*\nHola @${U.jidNum(p)}, bienvenido a *${meta.subject}* 🎉\nYa somos *${total}* miembros.`,
                            mentions: [p]
                        });
                    }
                }

                if ((action === 'remove' || action === 'leave') && gcfg.despedida) {
                    for (const p of participants) {
                        await sock.sendMessage(id, {
                            text: `🚪 @${U.jidNum(p)} salió de *${meta.subject}*.\nAhora somos *${total}* miembros.`,
                            mentions: [p]
                        });
                    }
                }
            } catch(e) {
                log.warn(`Evento grupo: ${e.message}`);
            }
        });

    } catch(e) {
        conectando = false;
        log.err(`Error iniciando bot: ${e.message}`);
        if (retries < CONFIG.maxRetries) {
            retries++;
            setTimeout(iniciarBot, 5000);
        } else {
            process.exit(1);
        }
    }
}

// ══════════════════════════════════════════
//  ARRANQUE
// ══════════════════════════════════════════
console.log(`\n${c.bold}${c.cy}╔════════════════════════════════════════╗${c.r}`);
console.log(`${c.bold}${c.cy}║   🤖 NEXUSBOT v2.1 — TERMUX EDITION   ║${c.r}`);
console.log(`${c.bold}${c.cy}╚════════════════════════════════════════╝${c.r}\n`);
log.info(`Prefijo: "${CONFIG.prefijo}"  |  Auth: ${CONFIG.authFolder}/  |  Data: ${CONFIG.dataFolder}/`);
log.info('Iniciando...\n');

iniciarBot();

process.on('unhandledRejection', (e) => log.warn(`UnhandledRejection: ${e?.message || e}`));
process.on('uncaughtException',  (e) => log.warn(`UncaughtException: ${e?.message || e}`));
