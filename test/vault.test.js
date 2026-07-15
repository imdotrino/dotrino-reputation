// Puente createVaultReputation: cablea trustOf desde el web-of-trust local del
// vault y publica al registro al calificar. Identity y fetch son mocks.

import { test } from 'node:test'
import assert from 'node:assert'
import { createVaultReputation } from '../src/index.js'

const pk = name => JSON.stringify({ kty: 'EC', crv: 'P-256', x: name, y: 'Y' })

// Identity mock: ratings locales en un mapa { subjectName: rating0..5 }.
function fakeIdentity (mePk, localRatings, sink) {
  return {
    me: { publickey: mePk },
    async signData (data) { return { signature: 'sig:' + JSON.stringify(data).length, publickey: mePk } },
    async getRatingsForSubject (subjectJwk) {
      const name = JSON.parse(subjectJwk).x
      const r = localRatings[name]
      return { mine: r == null ? null : { rating: r }, endorsements: [] }
    },
    async setRating (subjectJwk, rating, notes) { sink.push({ subjectJwk, rating, notes }) }
  }
}

// fetch mock: captura PUT /ratings y responde GET con atestaciones fijas.
function fakeFetch (attestationsBySubject, puts) {
  return async (url, opts) => {
    if (opts && opts.method === 'PUT') {
      puts.push(JSON.parse(opts.body))
      return { ok: true, json: async () => ({ ok: true, txBound: false }) }
    }
    const u = new URL(url)
    const subject = u.searchParams.get('subject')
    const name = JSON.parse(subject).x
    return { ok: true, json: async () => ({ attestations: attestationsBySubject[name] || [] }) }
  }
}

test('trustOf sale del web-of-trust local (mine.rating / 5)', async () => {
  const sink = []
  const id = fakeIdentity(pk('me'), { friend: 4, foe: 1 }, sink)
  const rep = createVaultReputation(id, { fetch: fakeFetch({}, []) })
  assert.strictEqual(await rep.trustOf(pk('friend')), 0.8)
  assert.strictEqual(await rep.trustOf(pk('foe')), 0.2)
  assert.strictEqual(await rep.trustOf(pk('desconocido')), null) // sin opinión propia
})

test('rate() guarda local Y publica atestación firmada al registro', async () => {
  const sink = [], puts = []
  const id = fakeIdentity(pk('me'), {}, sink)
  const rep = createVaultReputation(id, { fetch: fakeFetch({}, puts) })
  const res = await rep.rate(pk('seller'), 5, { notes: 'ok' })
  assert.strictEqual(res.ok, true)
  assert.strictEqual(sink.length, 1)            // setRating local
  assert.strictEqual(sink[0].rating, 5)
  assert.strictEqual(puts.length, 1)            // PUT al registro (un canal: confianza)
  assert.strictEqual(puts[0].data.op, 'rate')   // modelo por-canal (no el legacy 'rating')
  assert.strictEqual(puts[0].data.channel, 'confianza')
  assert.strictEqual(puts[0].data.value, 5)
  assert.ok(puts[0].signature)                  // firmado por el vault
})

test('reputationOf pondera por confianza local: amigo cuenta, bot no', async () => {
  const atts = {
    seller: [
      { issuer: pk('friend'), subject: pk('seller'), rating: 5, txBound: false },
      { issuer: pk('bot1'), subject: pk('seller'), rating: 5, txBound: false },
      { issuer: pk('bot2'), subject: pk('seller'), rating: 5, txBound: false }
    ]
  }
  const id = fakeIdentity(pk('me'), { friend: 5 }, [])
  const rep = createVaultReputation(id, { fetch: fakeFetch(atts, []) })
  const r = await rep.reputationOf(pk('seller'))
  assert.ok(r.score > 0.9, `score=${r.score}`)   // domina el amigo
  assert.strictEqual(r.trustedCount, 1)          // los bots no cuentan
  assert.strictEqual(r.rawCount, 3)
})
