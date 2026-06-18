/**
 * @dotrino/reputation — cliente del registro de reputación
 * `reputation.dotrino.com`. Quinto pilar del ecosistema.
 *
 * MODELO (ver discusión de diseño):
 *  - El registro es un **tablón público de atestaciones FIRMADAS**, no un juez.
 *    Guarda filas { subject, issuer, rating, notes?, ts, receipt? } cada una
 *    firmada por el emisor. NO calcula un score global (eso sería trivial de
 *    atacar con sybils).
 *  - El **significado se computa en el cliente**: `aggregateTrust` pondera cada
 *    atestación por cuánto confía EL OBSERVADOR en quien la emite (web-of-trust
 *    transitivo, anclado en vos, con decaimiento por distancia). Los emisores
 *    que no rastreás a alguien en quien confiás pesan ~0 → un flood de bots vale
 *    0. No hay número global que mover.
 *  - Identidad/firma desde el vault (`id.dotrino.com`), igual patrón que geo.
 *
 * Es complementario al web-of-trust LOCAL del vault: local = mi opinión;
 * registro = atestaciones firmadas compartidas y consultables (disponibilidad).
 */

import { canonicalStringify } from './canonical.js'

export { canonicalStringify } from './canonical.js'

const DEFAULT_BASE = 'https://reputation.dotrino.com'

/**
 * @param {object} opts
 * @param {(data:object)=>Promise<string>} opts.signData   firma canónica → base64 (del vault)
 * @param {()=>Promise<string>} opts.getPublicKeyJwk        pubkey JWK string (del vault) = mi issuer
 * @param {string} [opts.baseUrl]                           default https://reputation.dotrino.com
 * @param {typeof fetch} [opts.fetch]
 */
export function createReputationClient ({ signData, getPublicKeyJwk, baseUrl = DEFAULT_BASE, fetch: f } = {}) {
  if (typeof signData !== 'function' || typeof getPublicKeyJwk !== 'function') {
    throw new Error('dotrino-reputation: signData y getPublicKeyJwk son requeridos (del vault)')
  }
  const doFetch = f || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null)
  if (!doFetch) throw new Error('dotrino-reputation: no hay fetch; inyectalo en opts.fetch')
  const base = baseUrl.replace(/\/+$/, '')

  /**
   * Publica (o reemplaza) MI atestación sobre `subject`. Firmada por el vault.
   * MULTIINDICADOR: pasás un mapa `indicators` (p.ej. { confianza: 5, afinidad: 3 }).
   * Cada indicador es un eje independiente, entero 0..5. `confianza` es el eje
   * especial: es el ancla de credibilidad anti-sybil con la que se ponderan TODOS
   * los indicadores. Compat: `rating` (número) = atajo de `{ confianza: rating }`.
   * @param {object} p
   * @param {string} p.subject
   * @param {Object<string,number>} [p.indicators]  mapa indicador→0..5
   * @param {number} [p.rating]   atajo: equivale a indicators.confianza
   * @param {string} [p.notes]
   * @param {object} [p.receipt]
   * @returns {Promise<{ok:true, txBound:boolean}>}
   */
  async function publishRating ({ subject, indicators, rating, notes, receipt, now } = {}) {
    if (typeof subject !== 'string' || !subject) throw new Error('subject requerido (pubkey JWK)')
    const map = normalizeIndicators(indicators, rating)
    if (!Object.keys(map).length) throw new Error('indicators requerido (mapa indicador→0..5)')
    const issuer = await getPublicKeyJwk()
    // Incluimos `rating` (= confianza) además de `indicators` para compat con
    // clientes/servidores 0.2.x que sólo entienden `rating`.
    const data = { op: 'rating', subject, issuer, indicators: map, ts: now ?? Date.now() }
    if (typeof map.confianza === 'number') data.rating = map.confianza
    if (notes != null) data.notes = String(notes).slice(0, 280)
    if (receipt) data.receipt = receipt
    const signature = await signData(data)
    ratingsCache.delete(subject) // mi atestación cambió → invalidá la lectura cacheada
    return handle(await doFetch(`${base}/ratings`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data, signature })
    }))
  }

  /** Retira MI atestación sobre `subject` (tombstone firmado). */
  async function removeRating ({ subject, now } = {}) {
    const issuer = await getPublicKeyJwk()
    const data = { op: 'unrate', subject, issuer, ts: now ?? Date.now() }
    const signature = await signData(data)
    ratingsCache.delete(subject) // mi atestación cambió → invalidá la lectura cacheada
    return handle(await doFetch(`${base}/ratings`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data, signature })
    }))
  }

  // Cache + dedup de lecturas. `aggregateTrust` se llama por peer en caminos
  // calientes (p.ej. el messenger valida "avalado por tu red" en CADA mensaje
  // entrante) y se abre en abanico recursivo (subject + cada issuer). Sin esto,
  // una ráfaga de mensajes dispara miles de `GET /ratings?subject=...` idénticos
  // a la vez y agota el pool de conexiones del navegador
  // (ERR_INSUFFICIENT_RESOURCES). Cache positivo corto + cache negativo (para no
  // martillar un registro caído) + dedup de peticiones en vuelo: la ráfaga
  // colapsa a UNA sola petición por sujeto.
  const RATINGS_TTL = 30_000      // ms — frescura de un resultado OK
  const RATINGS_NEG_TTL = 5_000   // ms — backoff tras un error
  const ratingsCache = new Map()    // subject -> { ts, value?|error? }
  const ratingsInflight = new Map() // subject -> Promise

  /**
   * Trae TODAS las atestaciones sobre un sujeto (crudas, sin ponderar).
   * Cada una incluye el `issuer` (JWK) para que el cliente pueda re-verificar y
   * ponderar. Lectura pública. Memoizada (TTL corto) y deduplicada en vuelo.
   * @param {string} subject  pubkey JWK string
   * @returns {Promise<{attestations:Array}>}
   */
  function getRatings (subject) {
    if (typeof subject !== 'string' || !subject) {
      return Promise.reject(new Error('subject requerido'))
    }
    const cached = ratingsCache.get(subject)
    if (cached) {
      const ttl = cached.error ? RATINGS_NEG_TTL : RATINGS_TTL
      if (Date.now() - cached.ts < ttl) {
        return cached.error ? Promise.reject(cached.error) : Promise.resolve(cached.value)
      }
    }
    const pending = ratingsInflight.get(subject)
    if (pending) return pending
    const params = new URLSearchParams({ subject })
    const p = Promise.resolve()
      .then(() => doFetch(`${base}/ratings?${params.toString()}`))
      .then(r => handle(r))
      .then(
        value => { ratingsCache.set(subject, { ts: Date.now(), value }); return value },
        error => { ratingsCache.set(subject, { ts: Date.now(), error }); throw error }
      )
      .finally(() => { ratingsInflight.delete(subject) })
    ratingsInflight.set(subject, p)
    return p
  }

  /**
   * AGREGACIÓN ANTI-SYBIL, anclada en el observador. Pondera cada atestación por
   * la credibilidad que VOS le dais a su emisor (confianza transitiva con
   * decaimiento). Devuelve un score sólo de fuentes que rastreás a tu confianza;
   * el flood de bots desconocidos no mueve la aguja.
   *
   * @param {string} subject
   * @param {object} cfg
   * @param {(pk:string)=>Promise<number|null>} cfg.trustOf  mi confianza en pk: 0..1, o null si no tengo opinión. (1 para mí.)
   * @param {(pk:string)=>Promise<Array>} [cfg.fetchRatings]  default = getRatings desempaquetado
   * @param {string} [cfg.myPubkey]   mi JWK (credibilidad 1)
   * @param {number} [cfg.maxDepth=2] saltos de confianza transitiva
   * @param {number} [cfg.decay=0.5]  factor por salto
   * @param {number} [cfg.minCredibility=0.05] umbral para contar una fuente como "de tu red"
   * @returns {Promise<{score:number|null, confidence:number, trustedCount:number, rawCount:number, txBoundCount:number, samples:Array}>}
   */
  async function aggregateTrust (subject, cfg = {}) {
    const {
      trustOf,
      fetchRatings = async pk => (await getRatings(pk)).attestations,
      myPubkey = null,
      maxDepth = 2,
      decay = 0.5,
      minCredibility = 0.05
    } = cfg
    if (typeof trustOf !== 'function') throw new Error('aggregateTrust: trustOf es requerido')

    const credCache = new Map() // issuerId -> credibility

    // Credibilidad de la OPINIÓN de `pk` para mí, en [0,1].
    async function credibility (pk, depth, visited) {
      const id = pubkeyId(pk)
      if (credCache.has(id)) return credCache.get(id)
      if (myPubkey && samePubkey(pk, myPubkey)) { credCache.set(id, 1); return 1 }
      const direct = await trustOf(pk)
      if (direct != null && direct > 0) { credCache.set(id, direct); return direct }
      if (depth >= maxDepth) { credCache.set(id, 0); return 0 }
      // Transitiva: ¿quién, de los que YO podría rastrear, avala a pk?
      let best = 0
      let atts = []
      try { atts = await fetchRatings(pk) } catch (_) { atts = [] }
      for (const a of atts) {
        if (!a || typeof a.issuer !== 'string') continue
        const iid = pubkeyId(a.issuer)
        if (iid === id || visited.has(iid)) continue
        const cIssuer = await credibility(a.issuer, depth + 1, new Set(visited).add(iid))
        if (cIssuer <= 0) continue
        // La credibilidad transitiva se ancla SIEMPRE en confianza (el ancla anti-sybil).
        const conf = attConfianza(a)
        const contribution = cIssuer * clamp01((conf ?? 0) / 5)
        if (contribution > best) best = contribution
      }
      const v = decay * best
      credCache.set(id, v)
      return v
    }

    let atts = []
    try { atts = await fetchRatings(subject) } catch (_) { atts = [] }

    // Acumuladores POR INDICADOR (la unión de los que aparezcan). Cada eje se
    // agrega igual: media ponderada por la credibilidad (anclada en confianza).
    const acc = {} // indicador -> { weightedSum, totalW, trustedCount }
    const bump = (k, cred, val) => {
      const a = acc[k] || (acc[k] = { weightedSum: 0, totalW: 0, trustedCount: 0 })
      a.weightedSum += cred * val; a.totalW += cred; a.trustedCount++
    }
    let txBoundCount = 0
    const samples = []
    for (const a of atts) {
      if (!a || typeof a.issuer !== 'string') continue
      if (samePubkey(a.issuer, subject)) continue // nadie se auto-califica con peso
      const ind = attIndicators(a)
      if (!Object.keys(ind).length) continue
      const cred = await credibility(a.issuer, 1, new Set([pubkeyId(subject)]))
      if (a.txBound) txBoundCount++
      if (cred >= minCredibility) {
        for (const [k, v] of Object.entries(ind)) if (typeof v === 'number') bump(k, cred, v)
      }
      samples.push({ issuer: a.issuer, indicators: ind, credibility: round3(cred), txBound: !!a.txBound, notes: a.notes })
    }
    samples.sort((x, y) => y.credibility - x.credibility)

    // Resultado por indicador.
    const indicators = {}
    for (const [k, a] of Object.entries(acc)) {
      indicators[k] = {
        score: a.totalW > 0 ? clamp01((a.weightedSum / a.totalW) / 5) : null,
        confidence: round3(1 - Math.exp(-a.totalW)),
        trustedCount: a.trustedCount
      }
    }
    // Top-level = confianza, por compat con código que lee `.score`/`.trustedCount`.
    const c = indicators.confianza || { score: null, confidence: 0, trustedCount: 0 }
    return {
      score: c.score, confidence: c.confidence, trustedCount: c.trustedCount,
      rawCount: atts.length, txBoundCount, samples, indicators
    }
  }

  // ── Atestación por CANAL independiente (tipo "atestación") ─────────
  /** Publica MI atestación de UN indicador (canal) sobre `subject`: un registro
   *  independiente firmado {op:'rate', subject, issuer, channel, value, ts}. */
  async function rate ({ subject, channel, value, notes, receipt, now } = {}) {
    if (typeof subject !== 'string' || !subject) throw new Error('subject requerido (pubkey JWK)')
    if (typeof channel !== 'string' || !/^[a-z][a-z0-9_]{0,23}$/.test(channel)) throw new Error('channel inválido (slug)')
    if (!Number.isInteger(value) || value < 0 || value > 5) throw new Error('value debe ser entero 0..5')
    const issuer = await getPublicKeyJwk()
    const data = { op: 'rate', subject, issuer, channel, value, ts: now ?? Date.now() }
    if (notes != null) data.notes = String(notes).slice(0, 280)
    if (receipt) data.receipt = receipt
    const signature = await signData(data)
    ratingsCache.delete(subject)
    return handle(await doFetch(`${base}/ratings`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data, signature })
    }))
  }

  // ── Indicadores DERIVADOS (tipo "derivado": elo, …) ────────────────
  /** Publica un evento CO-FIRMADO de un indicador derivado ({data,sigA,sigB}).
   *  La co-firma se arma fuera (p.ej. el lobby). Idempotente por (indicator,scope,a,b,ts). */
  async function reportEvent ({ data, sigA, sigB } = {}) {
    if (!data || typeof data !== 'object') throw new Error('data requerido')
    if (typeof sigA !== 'string' || typeof sigB !== 'string') throw new Error('sigA y sigB requeridos')
    return handle(await doFetch(`${base}/events`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data, sigA, sigB })
    }))
  }

  /** Valor derivado actual de un jugador → { value, count }. */
  async function getDerived (player, indicator, scope = '') {
    if (!player || !indicator) return null
    try {
      const res = await handle(await doFetch(`${base}/derived?player=${encodeURIComponent(player)}&indicator=${encodeURIComponent(indicator)}&scope=${encodeURIComponent(scope)}`))
      return { value: res.value, count: res.count }
    } catch (_) { return null }
  }

  return { publishRating, rate, removeRating, getRatings, aggregateTrust, reportEvent, getDerived }
}

// Normaliza la entrada de indicadores: mapa {nombre:0..5} y/o `rating` (=confianza).
// Valida nombres (slug corto) y valores (entero 0..5). Máx 12 indicadores.
function normalizeIndicators (indicators, rating) {
  const out = {}
  if (typeof rating === 'number') out.confianza = rating
  if (indicators && typeof indicators === 'object') {
    for (const [k, v] of Object.entries(indicators)) {
      if (!/^[a-z][a-z0-9_]{0,23}$/.test(k)) continue
      if (Number.isInteger(v) && v >= 0 && v <= 5) out[k] = v
    }
  }
  for (const k of Object.keys(out)) {
    if (!Number.isInteger(out[k]) || out[k] < 0 || out[k] > 5) throw new Error(`indicador ${k}: entero 0..5`)
  }
  return Object.fromEntries(Object.entries(out).slice(0, 12))
}

// Mapa de indicadores de una atestación, con compat: si sólo trae `rating`
// (cliente viejo), lo expone como { confianza: rating }.
function attIndicators (a) {
  if (a.indicators && typeof a.indicators === 'object') return a.indicators
  if (typeof a.rating === 'number') return { confianza: a.rating }
  return {}
}
function attConfianza (a) {
  const ind = attIndicators(a)
  return typeof ind.confianza === 'number' ? ind.confianza : null
}

/**
 * PUENTE vault ↔ registro. Integración de 1 línea para cualquier app del
 * ecosistema que ya use el web-of-trust local del vault. Cablea `trustOf`
 * automáticamente desde `identity.getRatingsForSubject` (mi confianza directa),
 * y publica al registro cuando calificás (manteniendo local + nube en sync).
 *
 * `identity` = instancia conectada de `@dotrino/identity`
 * (debe exponer `me.publickey`, `signData(data)->{signature,publickey}` y
 * `getRatingsForSubject(pk)->{mine,endorsements}`). El paquete NO depende de
 * identity: se la inyectás (duck-typing).
 *
 * @returns {{ client, rate, reputationOf, getRatings, removeRating, trustOf }}
 */
export function createVaultReputation (identity, { baseUrl, fetch: f } = {}) {
  if (!identity || typeof identity.signData !== 'function') {
    throw new Error('dotrino-reputation: se requiere una instancia de identity conectada')
  }
  const myPubkey = () => (identity.me && identity.me.publickey) || null

  const client = createReputationClient({
    signData: async data => {
      const res = await identity.signData(data)
      return typeof res === 'string' ? res : res.signature
    },
    getPublicKeyJwk: async () => {
      const pk = myPubkey()
      if (!pk) throw new Error('dotrino-reputation: el vault no tiene pubkey (¿conectado?)')
      return pk
    },
    baseUrl,
    fetch: f
  })

  // Mi confianza directa en pk, desde el web-of-trust LOCAL: 0..1, o null si no
  // tengo opinión propia. (Para mí mismo, aggregateTrust ya asigna 1 vía myPubkey.)
  async function trustOf (pk) {
    try {
      const r = await identity.getRatingsForSubject(pk)
      const rating = r && r.mine && typeof r.mine.rating === 'number' ? r.mine.rating : null
      return rating == null ? null : Math.max(0, Math.min(1, rating / 5))
    } catch (_) { return null }
  }

  /**
   * Califica a un peer. `valueOrIndicators` puede ser:
   *  - un número (0..5) → confianza (compat), o
   *  - un mapa { confianza: 5, afinidad: 3, ... } (multiindicador).
   * Guarda la CONFIANZA en el vault local (web-of-trust) y atesta el mapa
   * completo, firmado, en el registro.
   */
  async function rate (subject, valueOrIndicators, { notes, receipt } = {}) {
    const indicators = typeof valueOrIndicators === 'number'
      ? { confianza: valueOrIndicators }
      : (valueOrIndicators || {})
    // El vault local solo guarda confianza (es el eje del web-of-trust / trustOf).
    if (typeof indicators.confianza === 'number') {
      try { if (typeof identity.setRating === 'function') await identity.setRating(subject, indicators.confianza, notes) } catch (_) {}
    }
    // Modelo nuevo: cada indicador = un registro independiente (op 'rate' por canal).
    const channels = Object.keys(indicators)
    const results = await Promise.all(channels.map(ch =>
      client.rate({ subject, channel: ch, value: indicators[ch], notes, receipt }).catch(e => ({ error: e }))
    ))
    const ok = results.every(r => r && r.ok)
    const txBound = results.some(r => r && r.txBound)
    return { ok, txBound }
  }
  /** Califica UN canal independiente (p.ej. 'fairplay'). */
  function rateChannel (subject, channel, value, opts = {}) { return client.rate({ subject, channel, value, ...opts }) }

  /** Reputación de un peer ponderada por MI web-of-trust (anti-sybil). Para el badge. */
  async function reputationOf (subject, opts = {}) {
    return client.aggregateTrust(subject, { trustOf, myPubkey: myPubkey(), ...opts })
  }

  // ELO: consultar el de un jugador y publicar un resultado co-firmado.
  // Indicadores derivados. eloOf devuelve {elo,games} por compat con consumidores.
  async function derivedOf (player, indicator, scope) { return client.getDerived(player, indicator, scope) }
  async function eloOf (player, scope = 'chess') {
    const d = await client.getDerived(player, 'elo', scope)
    return d ? { elo: d.value, games: d.count } : null
  }
  function reportResult (coSigned) { return client.reportEvent(coSigned) }

  return {
    client, trustOf, rate, reputationOf,
    getRatings: client.getRatings,
    removeRating: client.removeRating,
    rateChannel, eloOf, derivedOf, reportResult
  }
}

// ----- util -----

async function handle (res) {
  let body = null
  try { body = await res.json() } catch (_) {}
  if (!res.ok) {
    const msg = (body && body.error) || `HTTP ${res.status}`
    throw new Error(`dotrino-reputation: ${msg}`)
  }
  return body
}

function clamp01 (n) { return Math.max(0, Math.min(1, n)) }
function round3 (n) { return Math.round(n * 1000) / 1000 }

// Compara dos pubkeys JWK string por sus componentes (x,y), ignorando orden de claves.
export function samePubkey (a, b) {
  try {
    const ja = JSON.parse(a), jb = JSON.parse(b)
    return ja.x === jb.x && ja.y === jb.y && ja.crv === jb.crv
  } catch (_) { return a === b }
}

// Identificador estable de una pubkey (para dedup/cycle-detection en el cliente).
export function pubkeyId (jwkString) {
  try {
    const j = JSON.parse(jwkString)
    return `${j.crv}:${j.x}:${j.y}`
  } catch (_) { return String(jwkString) }
}
