'use strict';

// reputation.dotrino.com — registro de reputación del ecosistema Dotrino.
// HTTP/JSON sobre Node nativo + Postgres. PERSISTENTE (a diferencia de geo/proxy):
// guarda atestaciones firmadas. NO calcula score — el cliente pondera por
// confianza (anti-sybil). Ver README.md y el paquete @dotrino/reputation.
//
// Endpoints:
//   PUT    /ratings   publica/reemplaza una atestación firmada {data, signature}
//   DELETE /ratings   retira la atestación del emisor (tombstone; con `channel` = un eje)
//   GET    /ratings?subject=<ref>   atestaciones crudas sobre un sujeto (pública)
//   PUT    /questions  publica una pregunta firmada sobre un sujeto → {questionId}
//   DELETE /questions  retira la propia pregunta (tombstone firmado)
//   GET    /questions?subject=<ref>  preguntas crudas de un sujeto (pública)
//   PUT    /answers    publica/reemplaza la propia respuesta a una pregunta
//   DELETE /answers    retira la propia respuesta (tombstone firmado)
//   GET    /answers?question=<id>    respuestas crudas a una pregunta (pública)
//   GET    /health

const http = require('node:http');
const db = require('./db.js');
const { verifySignature, verifySignedBy, canonicalStringify, pubkeyId, samePubkey, verifyReceipt, sha256hex } = require('./signature.js');
const rl = require('./rateLimiter.js');

const PORT = Number(process.env.PORT || 8091);
const DATABASE_URL = process.env.DATABASE_URL || '';
const CLOCK_SKEW_MS = Number(process.env.REP_CLOCK_SKEW_MS || 5 * 60 * 1000);
/**
 * PARA QUIÉN firman los clientes: la URL pública del SERVICIO. Se admite una lista para
 * cuando responde en varios nombres (este registro se llamó `reputation.` antes que `rep.`).
 *
 * SIN VALOR NO SE ARRANCA. Un registro que acepta cualquier destinatario no comprueba
 * nada, y el fallo sería mudo: entrarían atestaciones firmadas para otro servicio.
 */
const AUDIENCES = (process.env.REP_AUDIENCE || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
/** ¿Viene dirigido a mí? Se mira antes que la firma: una firma válida para otro no es para mí. */
const isForMe = (data) => typeof data?.aud === 'string' && AUDIENCES.includes(data.aud.replace(/\/+$/, ''));
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
    const { data, signature, signer, chain } = (await readBody(req)) || {};
    if (!data || typeof data !== 'object') return send(res, 400, { error: 'missing data' });
    // Tipo "atestación" por CANAL independiente (modelo nuevo). Cada indicador es
    // su propio registro firmado: {op:'rate', subject, issuer, channel, value, ts}.
    if (data.op === 'rate') return await handleRate(res, now, data, signature, signer, chain);
    if (data.op !== 'rating') return send(res, 400, { error: 'op must be "rate" or "rating"' });
    if (typeof data.issuer !== 'string' || typeof data.subject !== 'string')
        return send(res, 400, { error: 'issuer and subject required (JWK)' });
    if (samePubkey(data.issuer, data.subject))
        return send(res, 400, { error: 'you cannot rate yourself' });
    // MULTIINDICADOR: aceptamos `indicators` (mapa) y/o `rating` (=confianza, compat).
    const indicators = normalizeIndicators(data.indicators, data.rating);
    if (!indicators) return send(res, 400, { error: 'invalid indicator (integer 0..5, slug name)' });
    if (!Object.keys(indicators).length) return send(res, 400, { error: 'indicators o rating requerido' });
    // La atestación la firma un APARATO, a nombre de una identidad. La cadena de
    // selladores es lo que prueba que ese aparato habla por esa identidad; sin ella no se
    // acepta, porque creerle el `issuer` a quien lo escribe es no comprobar nada.
    if (!isForMe(data)) return send(res, 401, { error: 'audience missing or for another service' });
    if (!await verifySignedBy(data, signature, signer, chain, data.aud))
        return send(res, 401, { error: 'invalid signature or a chain that does not prove the identity' });
    if (!freshEnough(data.ts, now))
        return send(res, 401, { error: 'envelope expired or clock out of range' });

    // Recibo opcional: si viene, debe ser válido (no guardamos recibos falsos).
    let txBound = false;
    if (data.receipt !== undefined) {
        if (!await verifyReceipt(data.receipt, data.issuer, data.subject))
            return send(res, 400, { error: 'invalid receipt' });
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
    const { data, signature, signer, chain } = (await readBody(req)) || {};
    if (!data || typeof data !== 'object') return send(res, 400, { error: 'missing data' });
    if (data.op !== 'unrate') return send(res, 400, { error: 'op must be "unrate"' });
    if (typeof data.issuer !== 'string' || typeof data.subject !== 'string')
        return send(res, 400, { error: 'issuer and subject required' });
    if (!isForMe(data)) return send(res, 401, { error: 'audience missing or for another service' });
    if (!await verifySignedBy(data, signature, signer, chain, data.aud))
        return send(res, 401, { error: 'invalid signature or a chain that does not prove the identity' });
    if (!freshEnough(data.ts, now)) return send(res, 401, { error: 'envelope expired' });
    const issuerId = pubkeyId(data.issuer), subjectId = pubkeyId(data.subject);
    if (typeof data.channel === 'string' && data.channel) {
        // Des-calificar UN eje (modelo por-canal).
        if (!/^[a-z][a-z0-9_]{0,23}$/.test(data.channel)) return send(res, 400, { error: 'invalid channel (slug)' });
        await db.deleteAttestation(issuerId, subjectId, data.channel);
    } else {
        // Des-calificar TODO: bundle legacy + todos los canales del par.
        await db.deleteRating(issuerId, subjectId);
        await db.deleteAttestationsForPair(issuerId, subjectId);
    }
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
async function handleRate(res, now, data, signature, signer, chain) {
    const { subject, issuer, channel, value, ts } = data;
    if (typeof subject !== 'string' || typeof issuer !== 'string')
        return send(res, 400, { error: 'issuer and subject required (JWK)' });
    if (samePubkey(issuer, subject)) return send(res, 400, { error: 'you cannot rate yourself' });
    if (typeof channel !== 'string' || !/^[a-z][a-z0-9_]{0,23}$/.test(channel))
        return send(res, 400, { error: 'invalid channel (slug a-z0-9_)' });
    if (db.isDerivedIndicator(channel))
        return send(res, 400, { error: `"${channel}" is a derived indicator: it is reported through /events, not by attestation` });
    if (!Number.isInteger(value) || value < 0 || value > 5)
        return send(res, 400, { error: 'value must be an integer 0..5' });
    if (!isForMe(data)) return send(res, 401, { error: 'audience missing or for another service' });
    // Firma el APARATO a nombre de la identidad, y la cadena lo prueba. Antes se comprobaba
    // contra `issuer` a secas, así que calificar o preguntar desde un segundo aparato de tu
    // cuenta daba «firma inválida».
    if (!await verifySignedBy(data, signature, signer, chain, data.aud))
        return send(res, 401, { error: 'invalid signature or a chain that does not prove the identity' });
    if (!freshEnough(ts, now)) return send(res, 401, { error: 'envelope expired or clock out of range' });
    let txBound = false;
    if (data.receipt !== undefined) {
        if (!await verifyReceipt(data.receipt, issuer, subject)) return send(res, 400, { error: 'invalid receipt' });
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
    const { data, sigA, sigB, signerA, chainA, signerB, chainB } = (await readBody(req)) || {};
    if (!data || typeof data !== 'object' || data.op !== 'event')
        return send(res, 400, { error: 'op must be "event"' });
    const { indicator, scope, a, b, outcome, ts } = data;
    if (typeof indicator !== 'string' || !db.isDerivedIndicator(indicator))
        return send(res, 400, { error: 'indicator derivado desconocido' });
    if (typeof scope !== 'string' || typeof a !== 'string' || typeof b !== 'string')
        return send(res, 400, { error: 'scope, a, b requeridos' });
    if (samePubkey(a, b)) return send(res, 400, { error: 'a and b must be different' });
    if (outcome !== 'a' && outcome !== 'b' && outcome !== 'draw')
        return send(res, 400, { error: 'outcome must be "a", "b" or "draw"' });
    if (typeof ts !== 'number') return send(res, 400, { error: 'ts requerido' });
    if (typeof sigA !== 'string' || typeof sigB !== 'string')
        return send(res, 400, { error: 'sigA and sigB required' });
    // CO-FIRMADO POR DOS, Y CADA MITAD SE COMPRUEBA IGUAL QUE LO DEMÁS: el destinatario
    // primero, y después que quien firmó habla por ese jugador. Antes se verificaba contra
    // `a` y `b` a secas, así que una partida jugada desde un segundo aparato no contaba.
    if (!isForMe(data)) return send(res, 401, { error: 'audience missing or for another service' });
    if (!await verifySignedBy(data, sigA, signerA, chainA, data.aud, a) ||
        !await verifySignedBy(data, sigB, signerB, chainB, data.aud, b))
        return send(res, 401, { error: 'invalid co-signature or a chain that does not prove the identity' });

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
    if (!player || !indicator) return send(res, 400, { error: 'player and indicator required' });
    const d = await db.getDerived(pubkeyId(player), indicator, scope);
    return send(res, 200, { player, indicator, scope, value: d.value, count: d.count });
}

// ── Preguntas y respuestas ──────────────────────────────────────────────────
// Registros públicos FIRMADOS, como las atestaciones: el server sólo almacena y
// sirve crudo; el ORDEN de relevancia lo pondera el CLIENTE (rankQuestions) por
// la credibilidad de quienes responden (anti-sybil). question_id es
// content-addressed: sha256(canónico {op:'question',subject,issuer,text,ts}).
async function handlePutQuestion(req, res, now) {
    const { data, signature, signer, chain } = (await readBody(req)) || {};
    if (!data || typeof data !== 'object' || data.op !== 'question')
        return send(res, 400, { error: 'op must be "question"' });
    const { subject, issuer, text, ts } = data;
    if (typeof subject !== 'string' || !subject || typeof issuer !== 'string' || !issuer)
        return send(res, 400, { error: 'subject and issuer required' });
    if (typeof text !== 'string' || !text.trim()) return send(res, 400, { error: 'text requerido' });
    if (text.length > 280) return send(res, 400, { error: 'text max 280' });
    if (!isForMe(data)) return send(res, 401, { error: 'audience missing or for another service' });
    // Firma el APARATO a nombre de la identidad, y la cadena lo prueba. Antes se comprobaba
    // contra `issuer` a secas, así que calificar o preguntar desde un segundo aparato de tu
    // cuenta daba «firma inválida».
    if (!await verifySignedBy(data, signature, signer, chain, data.aud))
        return send(res, 401, { error: 'invalid signature or a chain that does not prove the identity' });
    if (!freshEnough(ts, now)) return send(res, 401, { error: 'envelope expired or clock out of range' });
    const questionId = sha256hex(canonicalStringify({ op: 'question', subject, issuer, text, ts }));
    await db.upsertQuestion({
        questionId, subjectId: pubkeyId(subject), subject,
        issuerId: pubkeyId(issuer), issuer, text, ts, signature, updatedAt: now
    });
    return send(res, 200, { ok: true, questionId });
}

async function handleDeleteQuestion(req, res, now) {
    const { data, signature, signer, chain } = (await readBody(req)) || {};
    if (!data || typeof data !== 'object' || data.op !== 'delquestion')
        return send(res, 400, { error: 'op must be "delquestion"' });
    const { questionId, issuer, ts } = data;
    if (typeof questionId !== 'string' || typeof issuer !== 'string')
        return send(res, 400, { error: 'questionId and issuer required' });
    if (!isForMe(data)) return send(res, 401, { error: 'audience missing or for another service' });
    // Firma el APARATO a nombre de la identidad, y la cadena lo prueba. Antes se comprobaba
    // contra `issuer` a secas, así que calificar o preguntar desde un segundo aparato de tu
    // cuenta daba «firma inválida».
    if (!await verifySignedBy(data, signature, signer, chain, data.aud))
        return send(res, 401, { error: 'invalid signature or a chain that does not prove the identity' });
    if (!freshEnough(ts, now)) return send(res, 401, { error: 'envelope expired' });
    const removed = await db.deleteQuestion(questionId, pubkeyId(issuer));
    return send(res, 200, { ok: true, removed: removed > 0 });
}

async function handleGetQuestions(req, res, url) {
    const subject = url.searchParams.get('subject');
    if (!subject) return send(res, 400, { error: 'subject requerido' });
    let limit = Number(url.searchParams.get('limit') || 200);
    limit = Math.max(1, Math.min(MAX_QUERY_LIMIT, limit || 200));
    const questions = await db.questionsForSubject(pubkeyId(subject), limit);
    return send(res, 200, { questions });
}

async function handlePutAnswer(req, res, now) {
    const { data, signature, signer, chain } = (await readBody(req)) || {};
    if (!data || typeof data !== 'object' || data.op !== 'answer')
        return send(res, 400, { error: 'op must be "answer"' });
    const { questionId, issuer, text, ts } = data;
    if (typeof questionId !== 'string' || !questionId || typeof issuer !== 'string' || !issuer)
        return send(res, 400, { error: 'questionId and issuer required' });
    if (typeof text !== 'string' || !text.trim()) return send(res, 400, { error: 'text requerido' });
    if (text.length > 280) return send(res, 400, { error: 'text max 280' });
    if (!isForMe(data)) return send(res, 401, { error: 'audience missing or for another service' });
    // Firma el APARATO a nombre de la identidad, y la cadena lo prueba. Antes se comprobaba
    // contra `issuer` a secas, así que calificar o preguntar desde un segundo aparato de tu
    // cuenta daba «firma inválida».
    if (!await verifySignedBy(data, signature, signer, chain, data.aud))
        return send(res, 401, { error: 'invalid signature or a chain that does not prove the identity' });
    if (!freshEnough(ts, now)) return send(res, 401, { error: 'envelope expired or clock out of range' });
    if (!(await db.questionExists(questionId))) return send(res, 400, { error: 'pregunta inexistente' });
    await db.upsertAnswer({
        questionId, issuerId: pubkeyId(issuer), issuer, text, ts, signature, updatedAt: now
    });
    return send(res, 200, { ok: true });
}

async function handleDeleteAnswer(req, res, now) {
    const { data, signature, signer, chain } = (await readBody(req)) || {};
    if (!data || typeof data !== 'object' || data.op !== 'delanswer')
        return send(res, 400, { error: 'op must be "delanswer"' });
    const { questionId, issuer, ts } = data;
    if (typeof questionId !== 'string' || typeof issuer !== 'string')
        return send(res, 400, { error: 'questionId and issuer required' });
    if (!isForMe(data)) return send(res, 401, { error: 'audience missing or for another service' });
    // Firma el APARATO a nombre de la identidad, y la cadena lo prueba. Antes se comprobaba
    // contra `issuer` a secas, así que calificar o preguntar desde un segundo aparato de tu
    // cuenta daba «firma inválida».
    if (!await verifySignedBy(data, signature, signer, chain, data.aud))
        return send(res, 401, { error: 'invalid signature or a chain that does not prove the identity' });
    if (!freshEnough(ts, now)) return send(res, 401, { error: 'envelope expired' });
    const removed = await db.deleteAnswer(questionId, pubkeyId(issuer));
    return send(res, 200, { ok: true, removed: removed > 0 });
}

async function handleGetAnswers(req, res, url) {
    const questionId = url.searchParams.get('question');
    if (!questionId) return send(res, 400, { error: 'question requerido' });
    let limit = Number(url.searchParams.get('limit') || 500);
    limit = Math.max(1, Math.min(MAX_QUERY_LIMIT, limit || 500));
    const answers = await db.answersForQuestion(questionId, limit);
    return send(res, 200, { answers });
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
            if (!allowed) return send(res, 429, { error: 'too many requests' }, { 'retry-after': String(retryAfter) });
            if (req.method === 'PUT') return await handlePut(req, res, now);
            if (req.method === 'DELETE') return await handleDelete(req, res, now);
            if (req.method === 'GET') return await handleGet(req, res, url);
            return send(res, 405, { error: 'method not allowed' });
        }

        // ── Preguntas y respuestas sobre un sujeto ──────────────────────
        if (url.pathname === '/questions') {
            const cls = req.method === 'GET' ? 'read' : 'write';
            const { allowed, retryAfter } = rl.take(cls, rl.clientIp(req), now);
            if (!allowed) return send(res, 429, { error: 'too many requests' }, { 'retry-after': String(retryAfter) });
            if (req.method === 'PUT') return await handlePutQuestion(req, res, now);
            if (req.method === 'DELETE') return await handleDeleteQuestion(req, res, now);
            if (req.method === 'GET') return await handleGetQuestions(req, res, url);
            return send(res, 405, { error: 'method not allowed' });
        }
        if (url.pathname === '/answers') {
            const cls = req.method === 'GET' ? 'read' : 'write';
            const { allowed, retryAfter } = rl.take(cls, rl.clientIp(req), now);
            if (!allowed) return send(res, 429, { error: 'too many requests' }, { 'retry-after': String(retryAfter) });
            if (req.method === 'PUT') return await handlePutAnswer(req, res, now);
            if (req.method === 'DELETE') return await handleDeleteAnswer(req, res, now);
            if (req.method === 'GET') return await handleGetAnswers(req, res, url);
            return send(res, 405, { error: 'method not allowed' });
        }

        // ── Indicadores derivados (ELO y futuros) ───────────────────────
        if (url.pathname === '/events') {
            const { allowed, retryAfter } = rl.take('write', rl.clientIp(req), now);
            if (!allowed) return send(res, 429, { error: 'too many requests' }, { 'retry-after': String(retryAfter) });
            if (req.method === 'PUT') return await handlePutEvent(req, res, now);
            return send(res, 405, { error: 'method not allowed' });
        }
        if (url.pathname === '/derived') {
            const { allowed, retryAfter } = rl.take('read', rl.clientIp(req), now);
            if (!allowed) return send(res, 429, { error: 'too many requests' }, { 'retry-after': String(retryAfter) });
            if (req.method === 'GET') return await handleGetDerived(req, res, url);
            return send(res, 405, { error: 'method not allowed' });
        }
        return send(res, 404, { error: 'not found' });
    } catch (err) {
        const msg = err && err.message ? err.message : 'error';
        const status = (msg === 'body too large' || msg === 'invalid json') ? 400 : 500;
        return send(res, status, { error: msg });
    }
});

async function main() {
    // Sin destinatario declarado no se arranca: un registro que acepta cualquier `aud` no
    // comprueba nada, y entrarían atestaciones firmadas para otro servicio.
    if (!AUDIENCES.length) {
        console.error('[reputation] REP_AUDIENCE is required: the public URL(s) this service is called by, comma separated (e.g. https://rep.dotrino.com)');
        process.exit(1);
    }
    await db.init(DATABASE_URL);
    setInterval(() => rl.prune(Date.now()), 60 * 1000).unref();
    server.listen(PORT, () => console.log(`[reputation] reputation.dotrino.com listening on :${PORT}`));
    startUpdateWatch();
}

// §15: lo que se queda atrás en un servicio desplegado desde git son sus pilares.
function startUpdateWatch() {
    import('@dotrino/update/deps')
        .then(({ watchDependencies }) => watchDependencies({ dir: __dirname, name: 'reputation' }))
        .catch((e) => console.error('[update] could not start the watch:', e.code || e.message));
}

main().catch(err => { console.error('[reputation] fatal', err); process.exit(1); });
