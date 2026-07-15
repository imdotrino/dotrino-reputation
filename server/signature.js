'use strict';

// Verificación de sobres firmados del ecosistema Dotrino (ECDSA P-256 JWK,
// firma "raw" r||s de WebCrypto verificada con ieee-p1363). Mismo enfoque que
// geo, pero acá la clave firmante de una atestación es `data.issuer`.

const crypto = require('node:crypto');

function canonicalStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') + '}';
}

// Verifica que `signatureB64` es una firma válida de `data` hecha por `signerJwkString`.
function verifySignature(data, signatureB64, signerJwkString) {
    try {
        if (!data || typeof data !== 'object') return false;
        if (typeof signerJwkString !== 'string') return false;
        if (typeof signatureB64 !== 'string' || signatureB64.length < 10) return false;
        const jwk = JSON.parse(signerJwkString);
        if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) return false;
        const keyObject = crypto.createPublicKey({
            key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk'
        });
        return crypto.verify(
            'sha256',
            Buffer.from(canonicalStringify(data), 'utf8'),
            { key: keyObject, dsaEncoding: 'ieee-p1363' },
            Buffer.from(signatureB64, 'base64')
        );
    } catch (_) { return false; }
}

function pubkeyId(jwkString) {
    try {
        const j = JSON.parse(jwkString);
        const canon = canonicalStringify({ crv: j.crv, kty: j.kty, x: j.x, y: j.y });
        return crypto.createHash('sha256').update(canon).digest('hex');
    } catch (_) {
        return crypto.createHash('sha256').update(String(jwkString)).digest('hex');
    }
}

function samePubkey(a, b) {
    try { const ja = JSON.parse(a), jb = JSON.parse(b); return ja.x === jb.x && ja.y === jb.y && ja.crv === jb.crv; }
    catch (_) { return a === b; }
}

// sha256 hex de una cadena (id determinista de pregunta/respuesta, etc.).
function sha256hex(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

/**
 * Valida un recibo co-firmado de transacción: { a, b, ts, sigA, sigB }, donde
 * sigA firma {op:'receipt',a,b,ts} con la clave a, y sigB con la clave b.
 * Devuelve true sólo si AMBAS firmas son válidas y {a,b} == {issuer,subject}.
 */
function verifyReceipt(receipt, issuer, subject) {
    if (!receipt || typeof receipt !== 'object') return false;
    const { a, b, ts, sigA, sigB } = receipt;
    if (typeof a !== 'string' || typeof b !== 'string' || typeof ts !== 'number') return false;
    // El recibo debe ser entre el emisor y el sujeto (en cualquier orden).
    const pair = (samePubkey(a, issuer) && samePubkey(b, subject)) ||
                 (samePubkey(a, subject) && samePubkey(b, issuer));
    if (!pair) return false;
    const payload = { op: 'receipt', a, b, ts };
    return verifySignature(payload, sigA, a) && verifySignature(payload, sigB, b);
}

module.exports = { verifySignature, canonicalStringify, pubkeyId, samePubkey, verifyReceipt, sha256hex };
