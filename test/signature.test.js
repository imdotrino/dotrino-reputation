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

/**
 * Una CUENTA de verdad: perfil con su acta, para poder pedirle la cadena. Un recibo ya no
 * se comprueba contra la llave del jugador, sino contra la cadena que dice que el aparato
 * que firmó habla por él — así que aquí hace falta el pilar entero, no un par de claves.
 */
async function cuenta () {
  const { Identity } = await import('@dotrino/identity/node')
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rep-sig-'))
  const id = await Identity.connect({ dir })
  const pub = (await id.profileActa())?.acta?.profileId || id.me.publickey
  const chain = await id.sealerChain()
  /** Mi mitad de un co-firmado: firma, quién firmó y la cadena. */
  const mitad = async (data) => {
    const r = await id.signData(data)
    return { sig: r.signature, signer: r.publickey, chain: r.chain || chain }
  }
  return { pub, mitad, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

/** Arma el recibo con las dos mitades enteras, que es como viaja ahora. */
async function recibo (a, b, ts) {
  const payload = { op: 'receipt', a: a.pub, b: b.pub, ts }
  const ma = await a.mitad(payload), mb = await b.mitad(payload)
  return { a: a.pub, b: b.pub, ts, sigA: ma.sig, signerA: ma.signer, chainA: ma.chain, sigB: mb.sig, signerB: mb.signer, chainB: mb.chain }
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
  const a = await cuenta(), b = await cuenta()
  const receipt = await recibo(a, b, 1700000000000)
  // emisor = a, sujeto = b
  assert.strictEqual(await verifyReceipt(receipt, a.pub, b.pub), true)
  // también vale en el orden inverso (emisor = b)
  assert.strictEqual(await verifyReceipt(receipt, b.pub, a.pub), true)
  a.dispose(); b.dispose()
})

test('un recibo sin la cadena de un firmante NO vale', async () => {
  const a = await cuenta(), b = await cuenta()
  const receipt = await recibo(a, b, 1700000000000)
  assert.strictEqual(await verifyReceipt({ ...receipt, chainB: undefined }, a.pub, b.pub), false,
    'sin cadena no se puede comprobar que ese aparato habla por ese jugador')
  a.dispose(); b.dispose()
})

test('recibo con una sola firma NO vale', async () => {
  const a = await cuenta(), b = await cuenta()
  const receipt = await recibo(a, b, 1)
  assert.strictEqual(await verifyReceipt({ ...receipt, sigB: 'AAAA' }, a.pub, b.pub), false)
  a.dispose(); b.dispose()
})

test('recibo entre partes que no son issuer/subject NO vale', async () => {
  const a = await cuenta(), b = await cuenta(), c = await cuenta()
  const receipt = await recibo(a, b, 1)
  assert.strictEqual(await verifyReceipt(receipt, a.pub, c.pub), false) // c no firmó
  a.dispose(); b.dispose(); c.dispose()
})
