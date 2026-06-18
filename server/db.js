'use strict';

// Capa Postgres del registro de reputación. Independiente de geo: base propia.

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

let pool = null;

async function init(connectionString) {
    pool = new Pool(connectionString ? { connectionString } : undefined);
    await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    return pool;
}

// Upsert de la atestación de un emisor sobre un sujeto (pisa la anterior).
async function upsertRating(r) {
    await pool.query(
        `INSERT INTO ratings
            (issuer_id, subject_id, issuer, subject, rating, indicators, notes, ts, receipt, tx_bound, signature, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10,$11,$12)
         ON CONFLICT (issuer_id, subject_id) DO UPDATE SET
            rating = EXCLUDED.rating, indicators = EXCLUDED.indicators, notes = EXCLUDED.notes, ts = EXCLUDED.ts,
            receipt = EXCLUDED.receipt, tx_bound = EXCLUDED.tx_bound,
            signature = EXCLUDED.signature, updated_at = EXCLUDED.updated_at`,
        [r.issuerId, r.subjectId, r.issuer, r.subject, r.rating ?? null, JSON.stringify(r.indicators || {}),
         r.notes ?? null, r.ts, r.receipt ? JSON.stringify(r.receipt) : null, r.txBound, r.signature, r.updatedAt]
    );
}

// Todas las atestaciones sobre un sujeto (crudas; el cliente pondera).
// Devuelve `indicators` (multiindicador) y `rating` (= confianza, compat 0.2.x).
async function ratingsForSubject(subjectId, limit) {
    const { rows } = await pool.query(
        `SELECT issuer, subject, rating, indicators, notes, ts, tx_bound
         FROM ratings WHERE subject_id = $1 ORDER BY ts DESC LIMIT $2`,
        [subjectId, limit]
    );
    return rows.map(row => {
        const indicators = (row.indicators && typeof row.indicators === 'object') ? row.indicators : {};
        if (Object.keys(indicators).length === 0 && row.rating != null) indicators.confianza = row.rating;
        const rating = row.rating != null ? row.rating
            : (typeof indicators.confianza === 'number' ? indicators.confianza : undefined);
        return {
            issuer: row.issuer, subject: row.subject,
            indicators, rating,
            notes: row.notes ?? undefined, ts: Number(row.ts), txBound: row.tx_bound
        };
    });
}

async function deleteRating(issuerId, subjectId) {
    await pool.query('DELETE FROM ratings WHERE issuer_id = $1 AND subject_id = $2', [issuerId, subjectId]);
}

// ── Atestaciones por canal independiente (modelo primario) ──────────────────
async function upsertAttestation(r) {
    await pool.query(
        `INSERT INTO attestations
            (issuer_id, subject_id, channel, issuer, subject, value, notes, ts, receipt, tx_bound, signature, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)
         ON CONFLICT (issuer_id, subject_id, channel) DO UPDATE SET
            value = EXCLUDED.value, notes = EXCLUDED.notes, ts = EXCLUDED.ts,
            receipt = EXCLUDED.receipt, tx_bound = EXCLUDED.tx_bound,
            signature = EXCLUDED.signature, updated_at = EXCLUDED.updated_at`,
        [r.issuerId, r.subjectId, r.channel, r.issuer, r.subject, r.value,
         r.notes ?? null, r.ts, r.receipt ? JSON.stringify(r.receipt) : null, r.txBound, r.signature, r.updatedAt]
    );
}

async function deleteAttestation(issuerId, subjectId, channel) {
    await pool.query('DELETE FROM attestations WHERE issuer_id=$1 AND subject_id=$2 AND channel=$3', [issuerId, subjectId, channel]);
}

// Atestaciones (por canal) sobre un sujeto. Cada fila → un indicador independiente.
async function attestationsForSubject(subjectId, limit) {
    const { rows } = await pool.query(
        `SELECT issuer, subject, channel, value, notes, ts, tx_bound
         FROM attestations WHERE subject_id = $1 ORDER BY ts DESC LIMIT $2`,
        [subjectId, limit]
    );
    return rows.map(row => ({
        issuer: row.issuer, subject: row.subject,
        indicators: { [row.channel]: row.value },
        rating: row.channel === 'confianza' ? row.value : undefined,
        notes: row.notes ?? undefined, ts: Number(row.ts), txBound: row.tx_bound
    }));
}

// ── Indicadores DERIVADOS (genérico; cada indicador tiene su computador) ─────
function eloExpected(my, opp) { return 1 / (1 + Math.pow(10, (opp - my) / 400)); }
// Computador del ELO. outcome: 'a' | 'b' | 'draw'. K=32.
function nextElo(eloA, eloB, outcome) {
    const ea = eloExpected(eloA, eloB);
    const sa = outcome === 'a' ? 1 : (outcome === 'draw' ? 0.5 : 0);
    return { a: Math.round(eloA + 32 * (sa - ea)), b: Math.round(eloB + 32 * ((1 - sa) - (1 - ea))) };
}

// Registro de indicadores derivados. Cada uno: { base, step(valA,valB,outcome)→{a,b} }.
// Agregar un indicador derivado nuevo = una entrada acá (+ que el productor firme
// eventos con ese `indicator`). No requiere cambios de esquema.
const COMPUTERS = {
    elo: { base: 1200, step: nextElo }
};
function isDerivedIndicator(indicator) { return Object.prototype.hasOwnProperty.call(COMPUTERS, indicator); }

async function getDerived(playerId, indicator, scope) {
    const base = COMPUTERS[indicator] ? COMPUTERS[indicator].base : 0;
    const { rows } = await pool.query('SELECT value, count FROM derived WHERE player_id=$1 AND indicator=$2 AND scope=$3', [playerId, indicator, scope]);
    return rows.length ? { value: rows[0].value, count: rows[0].count } : { value: base, count: 0 };
}

// Inserta un evento co-firmado (idempotente por event_id) y aplica el indicador
// derivado a ambas partes en una transacción. Si ya existía, NO re-aplica.
async function insertEventAndApply({ eventId, indicator, scope, a, b, outcome, ts, sigA, sigB, aId, bId, now }) {
    const comp = COMPUTERS[indicator];
    if (!comp) throw new Error('indicador derivado desconocido: ' + indicator);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const ins = await client.query(
            `INSERT INTO events (event_id, indicator, scope, a, b, outcome, ts, sig_a, sig_b, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (event_id) DO NOTHING`,
            [eventId, indicator, scope, a, b, outcome, ts, sigA, sigB, now]
        );
        const cur = async (pid) => {
            const { rows } = await client.query('SELECT value, count FROM derived WHERE player_id=$1 AND indicator=$2 AND scope=$3 FOR UPDATE', [pid, indicator, scope]);
            return rows.length ? { value: rows[0].value, count: rows[0].count } : { value: comp.base, count: 0 };
        };
        const ca = await cur(aId), cb = await cur(bId);
        if (ins.rowCount === 0) { await client.query('COMMIT'); return { a: ca, b: cb, applied: false }; }
        const nx = comp.step(ca.value, cb.value, outcome);
        const up = async (pid, pjwk, value, count) => client.query(
            `INSERT INTO derived (player_id, indicator, scope, player, value, count, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (player_id, indicator, scope) DO UPDATE SET value=EXCLUDED.value, count=EXCLUDED.count, updated_at=EXCLUDED.updated_at`,
            [pid, indicator, scope, pjwk, value, count, now]
        );
        await up(aId, a, nx.a, ca.count + 1);
        await up(bId, b, nx.b, cb.count + 1);
        await client.query('COMMIT');
        return { a: { value: nx.a, count: ca.count + 1 }, b: { value: nx.b, count: cb.count + 1 }, applied: true };
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw e;
    } finally {
        client.release();
    }
}

async function close() { if (pool) await pool.end(); pool = null; }

module.exports = {
    init, upsertRating, ratingsForSubject, deleteRating,
    upsertAttestation, deleteAttestation, attestationsForSubject,
    getDerived, insertEventAndApply, isDerivedIndicator, nextElo, close
};
