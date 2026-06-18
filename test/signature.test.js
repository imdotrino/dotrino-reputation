// Interoperabilidad cripto vault(WebCrypto raw) ↔ server(Node ieee-p1363), y
// verificación de recibos co-firmados.

import { test } from 'node:test'
import assert from 'node:assert'
import { webcrypto } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { verifySignature, canonicalStringify, verifyReceipt, samePubkey } = require('../server/signature.js')
const subtle = webcrypto.subtle
const b64 = b => Buffer.from(b).toString('base64')

async function vault () {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const pub = JSON.stringify(await subtle.exportKey('jwk', pair.publicKey))
  const sign = async data => b64(new Uint8Array(await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(canonicalStringify(data)))))
  return { pub, sign }
}

test('atestación firmada por el emisor verifica', async () => {
  const a = await vault(), b = await vault()
  const data = { op: 'rating', subject: b.pub, issuer: a.pub, rating: 5, ts: 1700000000000 }
  const sig = await a.sign(data)
  assert.strictEqual(verifySignature(data, sig, data.issuer), true)
})

test('atestación NO verifica con la firma de otro', async () => {
  const a = await vault(), b = await vault()
  const data = { op: 'rating', subject: b.pub, issuer: a.pub, rating: 5, ts: 1 }
  const sigByB = await b.sign(data) // b intenta firmar como si fuera a
  assert.strictEqual(verifySignature(data, sigByB, data.issuer), false)
})

test('rating alterado tras firmar no verifica', async () => {
  const a = await vault(), b = await vault()
  const data = { op: 'rating', subject: b.pub, issuer: a.pub, rating: 1, ts: 1 }
  const sig = await a.sign(data)
  assert.strictEqual(verifySignature({ ...data, rating: 5 }, sig, data.issuer), false)
})

test('recibo co-firmado válido (issuer + subject)', async () => {
  const a = await vault(), b = await vault()
  const payload = { op: 'receipt', a: a.pub, b: b.pub, ts: 1700000000000 }
  const receipt = { a: a.pub, b: b.pub, ts: 1700000000000, sigA: await a.sign(payload), sigB: await b.sign(payload) }
  // emisor = a, sujeto = b
  assert.strictEqual(verifyReceipt(receipt, a.pub, b.pub), true)
  // también vale en el orden inverso (emisor = b)
  assert.strictEqual(verifyReceipt(receipt, b.pub, a.pub), true)
})

test('recibo con una sola firma NO vale', async () => {
  const a = await vault(), b = await vault()
  const payload = { op: 'receipt', a: a.pub, b: b.pub, ts: 1 }
  const receipt = { a: a.pub, b: b.pub, ts: 1, sigA: await a.sign(payload), sigB: 'AAAA' }
  assert.strictEqual(verifyReceipt(receipt, a.pub, b.pub), false)
})

test('recibo entre partes que no son issuer/subject NO vale', async () => {
  const a = await vault(), b = await vault(), c = await vault()
  const payload = { op: 'receipt', a: a.pub, b: b.pub, ts: 1 }
  const receipt = { a: a.pub, b: b.pub, ts: 1, sigA: await a.sign(payload), sigB: await b.sign(payload) }
  assert.strictEqual(verifyReceipt(receipt, a.pub, c.pub), false) // c no firmó
})
