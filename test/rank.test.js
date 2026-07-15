// El corazón de la app "reputation": ordenar preguntas por la CREDIBILIDAD
// SUMADA de quienes las responden, anclada en TU red. Una respuesta de
// reputación real en tu web-of-trust debe pesar más que un flood de desconocidos.

import { test } from 'node:test'
import assert from 'node:assert'
import { createReputationClient } from '../src/index.js'

const pk = name => JSON.stringify({ kty: 'EC', crv: 'P-256', x: name, y: 'Y' })
const nameOf = jwk => { try { return JSON.parse(jwk).x } catch (_) { return jwk } }

// Cliente con fetch mockeado por un "mundo":
//  questions: { subjectRef: [ {questionId, issuer, text, ts} ] }
//  answers:   { questionId: [ {issuer, text, ts} ] }
//  ratings:   { subjectName: [ {issuer:name, rating} ] }  (para la credibilidad)
function clientOf ({ questions = {}, answers = {}, ratings = {} }) {
  const json = obj => ({ ok: true, json: async () => obj })
  const fetch = async (url) => {
    const u = new URL(url, 'https://x')
    if (u.pathname === '/questions') return json({ questions: questions[u.searchParams.get('subject')] || [] })
    if (u.pathname === '/answers') return json({ answers: answers[u.searchParams.get('question')] || [] })
    if (u.pathname === '/ratings') {
      const s = u.searchParams.get('subject')
      const list = ratings[nameOf(s)] || []
      return json({ attestations: list.map(r => ({ issuer: pk(r.issuer), subject: s, rating: r.rating })) })
    }
    return json({})
  }
  return createReputationClient({ signData: async () => 'x', getPublicKeyJwk: async () => pk('me'), fetch })
}

const truster = map => async jwk => (nameOf(jwk) in map ? map[nameOf(jwk)] : null)

test('rankQuestions: 1 respuesta de tu red > flood de 500 desconocidos', async () => {
  const subject = 'domain:example.com'
  const client = clientOf({
    questions: { [subject]: [
      { questionId: 'q1', issuer: pk('asker'), text: 'inflada por bots', ts: 1 },
      { questionId: 'q2', issuer: pk('asker'), text: 'respondida por tu amigo', ts: 2 }
    ] },
    answers: {
      q1: Array.from({ length: 500 }, (_, i) => ({ issuer: pk('bot' + i), text: 'x', ts: 1 })),
      q2: [{ issuer: pk('friend'), text: 'sí', ts: 1 }]
    }
  })
  const ranked = await client.rankQuestions(subject, { trustOf: truster({ friend: 1 }) })
  assert.strictEqual(ranked.length, 2)
  assert.strictEqual(ranked[0].question.questionId, 'q2')          // gana la del amigo
  assert.strictEqual(ranked[0].weightedAnswerers, 1)
  assert.ok(ranked[0].weight >= 0.99, `weight q2=${ranked[0].weight}`)
  assert.strictEqual(ranked[1].question.questionId, 'q1')          // los 500 bots pesan 0
  assert.strictEqual(ranked[1].weightedAnswerers, 0)
  assert.strictEqual(ranked[1].weight, 0)
  assert.strictEqual(ranked[1].rawAnswerCount, 500)
})

test('rankQuestions: dedup de respuestas por emisor (una por perfil, la más reciente)', async () => {
  const subject = 'x:someone'
  const client = clientOf({
    questions: { [subject]: [{ questionId: 'q1', issuer: pk('a'), text: 't', ts: 1 }] },
    answers: { q1: [
      { issuer: pk('friend'), text: 'v1', ts: 1 },
      { issuer: pk('friend'), text: 'v2', ts: 5 }
    ] }
  })
  const ranked = await client.rankQuestions(subject, { trustOf: truster({ friend: 1 }) })
  assert.strictEqual(ranked[0].rawAnswerCount, 1)
  assert.strictEqual(ranked[0].answers[0].text, 'v2')
})

test('credibilityOf: directo, transitivo con decaimiento, y 0 para desconocido', async () => {
  const client = clientOf({ ratings: { broker: [{ issuer: 'friend', rating: 5 }] } })
  assert.strictEqual(await client.credibilityOf(pk('friend'), { trustOf: truster({ friend: 0.9 }) }), 0.9)
  assert.strictEqual(await client.credibilityOf(pk('broker'), { trustOf: truster({ friend: 1 }) }), 0.5)
  assert.strictEqual(await client.credibilityOf(pk('nobody'), { trustOf: truster({ friend: 1 }) }), 0)
})
