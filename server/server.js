'use strict';

// reputation.dotrino.com — registro de reputación del ecosistema Dotrino.
// HTTP/JSON sobre Node nativo + Postgres. PERSISTENTE (a diferencia de geo/proxy):
// guarda atestaciones firmadas. NO calcula score — el cliente pondera por
// confianza (anti-sybil). Ver README.md y el paquete @dotrino/reputation.
//
// Endpoints:
//   PUT    /ratings   publica/reemplaza una atestación firmada {data, signature}
//   DELETE /ratings   retira la atestación del emisor (tombstone firmado)
//   GET    /ratings?subject=<JWK>   atestaciones crudas sobre un sujeto (pública)
//   GET    /health

const http = require('node:http');
const db = require('./db.js');
const { verifySignature, pubkeyId, samePubkey, verifyReceipt } = require('./signature.js');
const rl = require('./rateLimiter.js');

const PORT = Number(process.env.PORT || 8091);
const DATABASE_URL = process.env.DATABASE_URL || '';
const CLOCK_SKEW_MS = Number(process.env.REP_CLOCK_SKEW_MS || 5 * 60 * 1000);
const MAX_BODY = 32 * 1024;          // sobres con recibo pueden ser algo más grandes
const MAX_QUERY_LIMIT = 500;

function send(res, status, obj, extraHeaders) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,PUT,DELETE,OPTIONS',
        'access-control-allow-headers': 'content-type',
        'cache-control': 'no-store',
        ...(extraHeaders || {})
    });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0; const chunks = [];
        req.on('data', c => {
            size += c.length;
            if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => {
            try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
            catch (_) { reject(new Error('invalid json')); }
        });
        req.on('error', reject);
    });
}

function freshEnough(ts, now) {
    return typeof ts === 'number' && Math.abs(now - ts) <= CLOCK_SKEW_MS;
}

// Construye/valida el mapa de indicadores desde `indicators` (mapa) y/o `rating`
// (=confianza). Devuelve el mapa, o null si algún valor provisto es inválido.
// Nombres: slug corto [a-z][a-z0-9_]{0,23}. Valores: entero 0..5. Máx 12.
function normalizeIndicators(indicators, rating) {
    const out = {};
    if (rating !== undefined) {
        if (!Number.isInteger(rating) || rating < 0 || rating > 5) return null;
        out.confianza = rating;
    }
    if (indicators !== undefined) {
        if (!indicators || typeof indicators !== 'object' || Array.isArray(indicators)) return null;
        for (const [k, v] of Object.entries(indicators)) {
            if (!/^[a-z][a-z0-9_]{0,23}$/.test(k)) return null;
            if (!Number.isInteger(v) || v < 0 || v > 5) return null;
            out[k] = v;
        }
    }
    return Object.fromEntries(Object.entries(out).slice(0, 12));
}

async function handlePut(req, res, now) {
    const { data, signature } = (await readBody(req)) || {};
    if (!data || typeof data !== 'object') return send(res, 400, { error: 'falta data' });
    // Tipo "atestación" por CANAL independiente (modelo nuevo). Cada indicador es
    // su propio registro firmado: {op:'rate', subject, issuer, channel, value, ts}.
    if (data.op === 'rate') return await handleRate(res, now, data, signature);
    if (data.op !== 'rating') return send(res, 400, { error: 'op debe ser "rate" o "rating"' });
    if (typeof data.issuer !== 'string' || typeof data.subject !== 'string')
        return send(res, 400, { error: 'issuer y subject requeridos (JWK)' });
    if (samePubkey(data.issuer, data.subject))
        return send(res, 400, { error: 'no podés calificarte a vos mismo' });
    // MULTIINDICADOR: aceptamos `indicators` (mapa) y/o `rating` (=confianza, compat).
    const indicators = normalizeIndicators(data.indicators, data.rating);
    if (!indicators) return send(res, 400, { error: 'indicador inválido (entero 0..5, nombre slug)' });
    if (!Object.keys(indicators).length) return send(res, 400, { error: 'indicators o rating requerido' });
    // La atestación debe estar firmada por el EMISOR.
    if (!verifySignature(data, signature, data.issuer))
        return send(res, 401, { error: 'firma inválida' });
    if (!freshEnough(data.ts, now))
        return send(res, 401, { error: 'sobre vencido o reloj fuera de rango' });

    // Recibo opcional: si viene, debe ser válido (no guardamos recibos falsos).
    let txBound = false;
    if (data.receipt !== undefined) {
        if (!verifyReceipt(data.receipt, data.issuer, data.subject))
            return send(res, 400, { error: 'recibo inválido' });
        txBound = true;
    }

    await db.upsertRating({
        issuerId: pubkeyId(data.issuer),
        subjectId: pubkeyId(data.subject),
        issuer: data.issuer, subject: data.subject,
        rating: typeof indicators.confianza === 'number' ? indicators.confianza : null,
        indicators,
        notes: typeof data.notes === 'string' ? data.notes.slice(0, 280) : null,
        ts: data.ts,
        receipt: txBound ? data.receipt : null,
        txBound,
        signature,
        updatedAt: now
    });
    return send(res, 200, { ok: true, txBound });
}

async function handleDelete(req, res, now) {
    const { data, signature } = (await readBody(req)) || {};
    if (!data || typeof data !== 'object') return send(res, 400, { error: 'falta data' });
    if (data.op !== 'unrate') return send(res, 400, { error: 'op debe ser "unrate"' });
    if (typeof data.issuer !== 'string' || typeof data.subject !== 'string')
        return send(res, 400, { error: 'issuer y subject requeridos' });
    if (!verifySignature(data, signature, data.issuer))
        return send(res, 401, { error: 'firma inválida' });
    if (!freshEnough(data.ts, now)) return send(res, 401, { error: 'sobre vencido' });
    await db.deleteRating(pubkeyId(data.issuer), pubkeyId(data.subject));
    return send(res, 200, { ok: true });
}

async function handleGet(req, res, url) {
    const subject = url.searchParams.get('subject');
    if (!subject) return send(res, 400, { error: 'subject requerido (pubkey JWK)' });
    let limit = Number(url.searchParams.get('limit') || 200);
    limit = Math.max(1, Math.min(MAX_QUERY_LIMIT, limit || 200));
    const sid = pubkeyId(subject);
    // Modelo nuevo: una atestación por (emisor, canal). Legacy: bundle indicators.
    // Se fusionan y deduplican por (emisor, canal), prefiriendo el registro nuevo.
    const fresh = await db.attestationsForSubject(sid, limit);
    const legacy = await db.ratingsForSubject(sid, limit);
    const seen = new Set();
    const out = [];
    for (const a of fresh) {
        const ch = Object.keys(a.indicators)[0];
        const k = pubkeyId(a.issuer) + ':' + ch;
        if (!seen.has(k)) { seen.add(k); out.push(a); }
    }
    for (const r of legacy) {
        for (const [ch, val] of Object.entries(r.indicators || {})) {
            const k = pubkeyId(r.issuer) + ':' + ch;
            if (seen.has(k)) continue;
            seen.add(k);
            out.push({ issuer: r.issuer, subject: r.subject, indicators: { [ch]: val }, rating: ch === 'confianza' ? val : undefined, notes: r.notes, ts: r.ts, txBound: r.txBound });
        }
    }
    return send(res, 200, { attestations: out });
}

// Atestación por CANAL independiente (tipo "atestación"): {op:'rate', subject,
// issuer, channel, value, ts, notes?, receipt?}. Cada indicador su propio registro.
async function handleRate(res, now, data, signature) {
    const { subject, issuer, channel, value, ts } = data;
    if (typeof subject !== 'string' || typeof issuer !== 'string')
        return send(res, 400, { error: 'issuer y subject requeridos (JWK)' });
    if (samePubkey(issuer, subject)) return send(res, 400, { error: 'no podés calificarte a vos mismo' });
    if (typeof channel !== 'string' || !/^[a-z][a-z0-9_]{0,23}$/.test(channel))
        return send(res, 400, { error: 'channel inválido (slug a-z0-9_)' });
    if (db.isDerivedIndicator(channel))
        return send(res, 400, { error: `"${channel}" es un indicador derivado: se reporta por /events, no por atestación` });
    if (!Number.isInteger(value) || value < 0 || value > 5)
        return send(res, 400, { error: 'value debe ser entero 0..5' });
    if (!verifySignature(data, signature, issuer)) return send(res, 401, { error: 'firma inválida' });
    if (!freshEnough(ts, now)) return send(res, 401, { error: 'sobre vencido o reloj fuera de rango' });
    let txBound = false;
    if (data.receipt !== undefined) {
        if (!verifyReceipt(data.receipt, issuer, subject)) return send(res, 400, { error: 'recibo inválido' });
        txBound = true;
    }
    await db.upsertAttestation({
        issuerId: pubkeyId(issuer), subjectId: pubkeyId(subject), channel, issuer, subject, value,
        notes: typeof data.notes === 'string' ? data.notes.slice(0, 280) : null,
        ts, receipt: txBound ? data.receipt : null, txBound, signature, updatedAt: now
    });
    return send(res, 200, { ok: true, channel, txBound });
}

// PUT /events — evento de un indicador DERIVADO, CO-FIRMADO por ambas partes:
// { data:{op:'event', indicator, scope, a, b, outcome, ts}, sigA, sigB }. El server
// computa el indicador (p.ej. ELO) y actualiza el valor derivado de a y b.
async function handlePutEvent(req, res, now) {
    const { data, sigA, sigB } = (await readBody(req)) || {};
    if (!data || typeof data !== 'object' || data.op !== 'event')
        return send(res, 400, { error: 'op debe ser "event"' });
    const { indicator, scope, a, b, outcome, ts } = data;
    if (typeof indicator !== 'string' || !db.isDerivedIndicator(indicator))
        return send(res, 400, { error: 'indicator derivado desconocido' });
    if (typeof scope !== 'string' || typeof a !== 'string' || typeof b !== 'string')
        return send(res, 400, { error: 'scope, a, b requeridos' });
    if (samePubkey(a, b)) return send(res, 400, { error: 'a y b deben ser distintos' });
    if (outcome !== 'a' && outcome !== 'b' && outcome !== 'draw')
        return send(res, 400, { error: 'outcome debe ser "a", "b" o "draw"' });
    if (typeof ts !== 'number') return send(res, 400, { error: 'ts requerido' });
    if (typeof sigA !== 'string' || typeof sigB !== 'string')
        return send(res, 400, { error: 'sigA y sigB requeridos' });
    if (!verifySignature(data, sigA, a) || !verifySignature(data, sigB, b))
        return send(res, 401, { error: 'co-firma inválida' });

    const eventId = pubkeyId(`event|${indicator}|${scope}|${a}|${b}|${ts}`); // sha256 estable (idempotente)
    const r = await db.insertEventAndApply({
        eventId, indicator, scope, a, b, outcome, ts, sigA, sigB,
        aId: pubkeyId(a), bId: pubkeyId(b), now
    });
    return send(res, 200, { ok: true, applied: r.applied, indicator, scope, a: r.a, b: r.b });
}

// GET /derived?player=<JWK>&indicator=<id>&scope=<id> — valor derivado actual.
async function handleGetDerived(req, res, url) {
    const player = url.searchParams.get('player');
    const indicator = url.searchParams.get('indicator');
    const scope = url.searchParams.get('scope') || '';
    if (!player || !indicator) return send(res, 400, { error: 'player e indicator requeridos' });
    const d = await db.getDerived(pubkeyId(player), indicator, scope);
    return send(res, 200, { player, indicator, scope, value: d.value, count: d.count });
}

const server = http.createServer(async (req, res) => {
    const now = Date.now();
    try {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        if (req.method === 'OPTIONS') return send(res, 204, {});
        if (url.pathname === '/health') return send(res, 200, { ok: true });

        if (url.pathname === '/ratings') {
            const cls = req.method === 'GET' ? 'read' : 'write';
            const { allowed, retryAfter } = rl.take(cls, rl.clientIp(req), now);
            if (!allowed) return send(res, 429, { error: 'demasiadas solicitudes' }, { 'retry-after': String(retryAfter) });
            if (req.method === 'PUT') return await handlePut(req, res, now);
            if (req.method === 'DELETE') return await handleDelete(req, res, now);
            if (req.method === 'GET') return await handleGet(req, res, url);
            return send(res, 405, { error: 'método no permitido' });
        }

        // ── Indicadores derivados (ELO y futuros) ───────────────────────
        if (url.pathname === '/events') {
            const { allowed, retryAfter } = rl.take('write', rl.clientIp(req), now);
            if (!allowed) return send(res, 429, { error: 'demasiadas solicitudes' }, { 'retry-after': String(retryAfter) });
            if (req.method === 'PUT') return await handlePutEvent(req, res, now);
            return send(res, 405, { error: 'método no permitido' });
        }
        if (url.pathname === '/derived') {
            const { allowed, retryAfter } = rl.take('read', rl.clientIp(req), now);
            if (!allowed) return send(res, 429, { error: 'demasiadas solicitudes' }, { 'retry-after': String(retryAfter) });
            if (req.method === 'GET') return await handleGetDerived(req, res, url);
            return send(res, 405, { error: 'método no permitido' });
        }
        return send(res, 404, { error: 'not found' });
    } catch (err) {
        const msg = err && err.message ? err.message : 'error';
        const status = (msg === 'body too large' || msg === 'invalid json') ? 400 : 500;
        return send(res, status, { error: msg });
    }
});

async function main() {
    await db.init(DATABASE_URL);
    setInterval(() => rl.prune(Date.now()), 60 * 1000).unref();
    server.listen(PORT, () => console.log(`[reputation] reputation.dotrino.com escuchando en :${PORT}`));
}

main().catch(err => { console.error('[reputation] fatal', err); process.exit(1); });
