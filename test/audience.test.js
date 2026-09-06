// PARA QUIÉN es una atestación. Sin destinatario, la misma firma valía en este registro y
// en cualquier otro servicio del ecosistema que verificara igual — nadie tenía con qué
// notar que no le hablaban a él.
//
// Y el otro invariante que se fija aquí: lo que se manda es el PAQUETE (firma + quién
// firmó + su cadena). Aplanarlo a la firma sola dejaba al registro sin poder comprobar que
// este aparato habla por esta identidad.

import { test } from 'node:test'
import assert from 'node:assert'
import { createReputationClient } from '../src/index.js'

const REP = 'https://rep.dotrino.com'
const pk = (name) => JSON.stringify({ kty: 'EC', crv: 'P-256', x: name, y: 'Y' })

function cliente ({ baseUrl = REP, signData } = {}) {
  const enviado = []
  const client = createReputationClient({
    baseUrl,
    getPublicKeyJwk: async () => pk('yo'),
    signData: signData || (async () => ({ signature: 'firma', publickey: pk('este-aparato'), chain: [{ seq: 1 }] })),
    fetch: async (url, opts) => {
      enviado.push({ url, method: opts?.method, body: JSON.parse(opts.body) })
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
  })
  return { client, enviado }
}

test('toda escritura dice para quién es, y va con su cadena', async () => {
  const { client, enviado } = cliente()
  await client.rate({ subject: pk('otro'), channel: 'confianza', value: 4 })
  await client.removeChannel({ subject: pk('otro'), channel: 'confianza' })
  await client.publishRating({ subject: pk('otro'), rating: 5 })
  await client.removeRating({ subject: pk('otro') })
  await client.postQuestion({ subject: pk('otro'), text: '¿cumple?' })
  await client.postAnswer({ questionId: 'q1', text: 'sí' })
  await client.removeQuestion({ questionId: 'q1' })
  await client.removeAnswer({ questionId: 'q1' })

  assert.equal(enviado.length, 8, 'las ocho escrituras')
  for (const e of enviado) {
    assert.equal(e.body.data.aud, REP, `${e.body.data.op} sin destinatario`)
    assert.equal(e.body.data.issuer, pk('yo'), `${e.body.data.op}: a nombre de la identidad`)
    assert.equal(typeof e.body.signature, 'string', `${e.body.data.op}: la firma va como texto`)
    assert.equal(e.body.signer, pk('este-aparato'), `${e.body.data.op}: y quién firmó`)
    assert.deepEqual(e.body.chain, [{ seq: 1 }], `${e.body.data.op}: y su cadena`)
  }
})

test('autohospedar cambia el destinatario', async () => {
  const { client, enviado } = cliente({ baseUrl: 'https://rep.miempresa.com/' })
  await client.rate({ subject: pk('otro'), channel: 'confianza', value: 3 })
  assert.equal(enviado[0].body.data.aud, 'https://rep.miempresa.com')
})

test('un vault que solo devuelve la firma se para y se dice, no se manda a medias', async () => {
  const { client } = cliente({ signData: async () => 'solo-la-firma' })
  await assert.rejects(
    () => client.rate({ subject: pk('otro'), channel: 'confianza', value: 4 }),
    /chain/,
    'antes se mandaba sin cadena y el 401 del registro no decía nada de esto'
  )
})

test('un baseUrl que no es una URL revienta al crear el cliente', () => {
  assert.throws(() => cliente({ baseUrl: 'no-es-una-url' }))
})
