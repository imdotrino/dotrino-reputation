'use strict';

// Rate limiting por IP, en memoria, con token bucket. Best-effort: amortigua
// floods de lectura/escritura sin bloquear uso legítimo. NO es seguridad fuerte
// (la IP puede falsearse si no se confía en el proxy de delante); para eso está
// la firma del sobre y, idealmente, una regla en Cloudflare por delante.
//
// Dos clases independientes de cubeta por IP:
//   - read:  GET /pins   (consultas; las apps pueden pollear)
//   - write: PUT/DELETE   (publicar/retirar; más caras: verifican firma)
//
// Defaults GENEROSOS (configurables por env). capacity = ráfaga máxima;
// refillPerSec = ritmo sostenido. Un cliente normal nunca los toca.

const READ_PER_MIN = Number(process.env.REP_RL_READ_PER_MIN || 600);   // 10/s sostenido
const WRITE_PER_MIN = Number(process.env.REP_RL_WRITE_PER_MIN || 120); // 2/s sostenido
const DISABLED = process.env.REP_RL_DISABLED === '1';
// Confiar en X-Forwarded-For para la IP real. El despliegue estándar pone nginx
// (nuestro, autohosteado) delante, que setea XFF. NO dependemos de Cloudflare ni
// de ningún tercero: si en el futuro nginx atiende directo, XFF = IP del cliente
// igual. Si se expone el server sin proxy, poné REP_TRUST_PROXY=0 y se usa el
// socket. (XFF es spoofeable; esto es amortiguación best-effort, no seguridad.)
const TRUST_PROXY = process.env.REP_TRUST_PROXY !== '0';

const CLASSES = {
    read:  { capacity: READ_PER_MIN,  refillPerSec: READ_PER_MIN / 60 },
    write: { capacity: WRITE_PER_MIN, refillPerSec: WRITE_PER_MIN / 60 }
};

// Map<`${cls}:${ip}`, { tokens, last }>
const buckets = new Map();

/**
 * Extrae la IP del cliente. Con nginx delante, el socket es 127.0.0.1 y la IP
 * real viene en el primer hop de X-Forwarded-For (que nginx setea). Funciona
 * igual si en algún momento se quita Cloudflare: XFF lo pone nuestro nginx.
 */
function clientIp(req) {
    if (TRUST_PROXY) {
        const xff = req.headers['x-forwarded-for'];
        if (xff && typeof xff === 'string') {
            const first = xff.split(',')[0].trim();
            if (first) return first;
        }
    }
    return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * Consume 1 token de la cubeta (cls, ip). Devuelve {allowed, retryAfter} donde
 * retryAfter son segundos (entero) hasta tener 1 token, si se denegó.
 */
function take(cls, ip, now) {
    if (DISABLED) return { allowed: true, retryAfter: 0 };
    const conf = CLASSES[cls];
    if (!conf) return { allowed: true, retryAfter: 0 };
    const key = cls + ':' + ip;
    let b = buckets.get(key);
    if (!b) { b = { tokens: conf.capacity, last: now }; buckets.set(key, b); }
    const elapsed = Math.max(0, (now - b.last) / 1000);
    b.tokens = Math.min(conf.capacity, b.tokens + elapsed * conf.refillPerSec);
    b.last = now;
    if (b.tokens >= 1) {
        b.tokens -= 1;
        return { allowed: true, retryAfter: 0 };
    }
    return { allowed: false, retryAfter: Math.ceil((1 - b.tokens) / conf.refillPerSec) };
}

// Poda cubetas llenas e inactivas (vuelven al estado inicial igualmente).
function prune(now, idleMs = 10 * 60 * 1000) {
    for (const [key, b] of buckets) {
        const cls = key.slice(0, key.indexOf(':'));
        const conf = CLASSES[cls];
        if (conf && b.tokens >= conf.capacity && (now - b.last) > idleMs) {
            buckets.delete(key);
        }
    }
}

function stats() {
    return { buckets: buckets.size, disabled: DISABLED, readPerMin: READ_PER_MIN, writePerMin: WRITE_PER_MIN };
}

module.exports = { clientIp, take, prune, stats, CLASSES };
