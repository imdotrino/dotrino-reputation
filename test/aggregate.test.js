// Prueba el corazón anti-sybil: aggregateTrust pondera por confianza anclada en
// el observador. Un flood de emisores desconocidos debe valer 0; una fuente
// confiable debe dominar; la confianza transitiva debe propagar (con decaimiento).

import { test } from 'node:test'
import assert from 'node:assert'
import { createReputationClient } from '../src/index.js'

// pubkeys "JWK" falsas pero con forma parseable (x único por identidad).
const pk = name => JSON.stringify({ kty: 'EC', crv: 'P-256', x: name, y: 'Y' })

// Cliente sólo para usar aggregateTrust; fetch dummy (no se llega a la red porque
// inyectamos fetchRatings y trustOf).
const client = createReputationClient({
  signData: async () => 'x', getPublicKeyJwk: async () => pk('me'), fetch: async () => ({ ok: true, json: async () => ({}) })
})

function world (ratingsBySubject) {
  // ratingsBySubject: { subjectName: [ {issuer:name, rating, txBound?} ] }
  return async subjectJwk => {
    const name = JSON.parse(subjectJwk).x
    const list = ratingsBySubject[name] || []
    return list.map(r => ({ issuer: pk(r.issuer), subject: subjectJwk, rating: r.rating, txBound: !!r.txBound }))
  }
}
// trustOf desde un mapa { name: 0..1 }; null si no figura.
function truster (map) {
  return async jwk => {
    const name = JSON.parse(jwk).x
    return name in map ? map[name] : null
  }
}

test('flood de bots desconocidos → score null (sólo ruido), rawCount alto', async () => {
  const bots = Array.from({ length: 500 }, (_, i) => ({ issuer: 'bot' + i, rating: 5 }))
  const fetchRatings = world({ scammer: bots })
  const r = await client.aggregateTrust(pk('scammer'), { trustOf: truster({}), fetchRatings })
  assert.strictEqual(r.score, null)        // ninguna fuente confiable
  assert.strictEqual(r.trustedCount, 0)
  assert.strictEqual(r.rawCount, 500)      // el ruido se ve, pero no pondera
  assert.ok(r.confidence < 0.01)
})

test('una fuente confiable domina al flood', async () => {
  const atts = [
    { issuer: 'friend', rating: 5 },
    ...Array.from({ length: 500 }, (_, i) => ({ issuer: 'bot' + i, rating: 0 }))
  ]
  const fetchRatings = world({ seller: atts })
  const r = await client.aggregateTrust(pk('seller'), {
    trustOf: truster({ friend: 0.9 }), fetchRatings
  })
  assert.ok(r.score > 0.85, `score=${r.score}`)   // domina el amigo, no los 500 bots
  assert.strictEqual(r.trustedCount, 1)
  assert.ok(r.confidence > 0.5)
})

test('confianza transitiva: amigo-de-amigo cuenta, con decaimiento', async () => {
  // No conozco a "broker", pero "friend" (a quien confío) calificó bien a "broker".
  // Y "broker" calificó al "seller". Debe filtrar algo de peso, decaído.
  const fetchRatings = world({
    seller: [{ issuer: 'broker', rating: 5 }],
    broker: [{ issuer: 'friend', rating: 5 }]
  })
  const r = await client.aggregateTrust(pk('seller'), {
    trustOf: truster({ friend: 1 }), fetchRatings, maxDepth: 2, decay: 0.5
  })
  // credibility(broker) = decay * (cred(friend)=1 * 5/5) = 0.5 → score = 5/5 = 1, pero confianza moderada
  assert.ok(r.score > 0, 'debe propagar algo')
  assert.strictEqual(r.trustedCount, 1)
  assert.ok(r.confidence > 0 && r.confidence < 0.6, `confidence=${r.confidence}`)
})

test('más allá de maxDepth no propaga', async () => {
  const fetchRatings = world({
    seller: [{ issuer: 'l1', rating: 5 }],
    l1: [{ issuer: 'l2', rating: 5 }],
    l2: [{ issuer: 'friend', rating: 5 }] // friend está a 3 saltos
  })
  const r = await client.aggregateTrust(pk('seller'), {
    trustOf: truster({ friend: 1 }), fetchRatings, maxDepth: 2, decay: 0.5
  })
  assert.strictEqual(r.score, null) // friend queda fuera del alcance
  assert.strictEqual(r.trustedCount, 0)
})

test('mi propia atestación pesa máximo (credibilidad 1)', async () => {
  const fetchRatings = world({ seller: [{ issuer: 'me', rating: 4 }] })
  const r = await client.aggregateTrust(pk('seller'), {
    trustOf: truster({}), fetchRatings, myPubkey: pk('me')
  })
  assert.strictEqual(r.score, 0.8)  // 4/5, sin diluir
  assert.strictEqual(r.trustedCount, 1)
})

test('auto-calificación del sujeto se ignora', async () => {
  const fetchRatings = world({ seller: [{ issuer: 'seller', rating: 5 }] })
  const r = await client.aggregateTrust(pk('seller'), { trustOf: truster({ seller: 0 }), fetchRatings })
  assert.strictEqual(r.score, null)
  assert.strictEqual(r.rawCount, 1)
})

test('multiindicador: cada eje se agrega independiente, ponderado por confianza', async () => {
  // friend (confío 1.0) atesta confianza=5, afinidad=2 sobre seller.
  // bot (desconocido) atesta confianza=5, afinidad=5 → no debe pesar en ninguno.
  const fetchRatings = async subjectJwk => {
    if (JSON.parse(subjectJwk).x !== 'seller') return []
    return [
      { issuer: pk('friend'), subject: subjectJwk, indicators: { confianza: 5, afinidad: 2 } },
      { issuer: pk('bot'), subject: subjectJwk, indicators: { confianza: 5, afinidad: 5 } }
    ]
  }
  const r = await client.aggregateTrust(pk('seller'), { trustOf: truster({ friend: 1 }), fetchRatings })
  // confianza: domina friend (5/5 = 1.0); el bot no cuenta
  assert.strictEqual(r.indicators.confianza.score, 1)
  assert.strictEqual(r.indicators.confianza.trustedCount, 1)
  // afinidad: independiente → friend dijo 2/5 = 0.4; el bot (afinidad 5) NO la sube
  assert.strictEqual(r.indicators.afinidad.score, 0.4)
  assert.strictEqual(r.indicators.afinidad.trustedCount, 1)
  // top-level (compat) = confianza
  assert.strictEqual(r.score, 1)
})

test('multiindicador: rating viejo (sin indicators) se lee como confianza', async () => {
  const fetchRatings = world({ seller: [{ issuer: 'friend', rating: 4 }] }) // formato 0.2.x
  const r = await client.aggregateTrust(pk('seller'), { trustOf: truster({ friend: 1 }), fetchRatings })
  assert.strictEqual(r.indicators.confianza.score, 0.8)
  assert.strictEqual(r.score, 0.8)
})
