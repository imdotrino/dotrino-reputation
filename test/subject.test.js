// Sujetos canónicos: la MISMA cosa (dominio/handle/correo) debe colapsar a UN
// ref estable sin importar cómo la escriba el usuario (esquema, www, case,
// espacios, @, URL completa). Si no, el mismo sujeto se fragmentaría en varios.

import { test } from 'node:test'
import assert from 'node:assert'
import { subjectRef, parseSubjectRef, detectSubjectType, sha256hex } from '../src/index.js'

const jwk = JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'AAA', y: 'BBB' })

test('domain: esquema/www/ruta/case colapsan al mismo ref', async () => {
  const a = await subjectRef('domain', 'https://www.Example.com/path?x=1')
  assert.strictEqual(a, 'domain:example.com')
  assert.strictEqual(a, await subjectRef('domain', 'example.com'))
  assert.strictEqual(a, await subjectRef('domain', 'HTTP://Example.COM'))
})

test('domain inválido lanza', async () => {
  await assert.rejects(() => subjectRef('domain', 'no-dot'))
  await assert.rejects(() => subjectRef('domain', ''))
})

test('x/github: @, case y URL colapsan al mismo handle', async () => {
  const a = await subjectRef('x', '@Dotrino')
  assert.strictEqual(a, 'x:dotrino')
  assert.strictEqual(a, await subjectRef('x', 'https://x.com/dotrino'))
  assert.strictEqual(a, await subjectRef('x', 'twitter.com/DOTRINO'))
  assert.strictEqual(await subjectRef('github', 'https://github.com/ImDotrino'), 'github:imdotrino')
})

test('email: mismo correo (case/espacios) → mismo hash; nunca en claro', async () => {
  const a = await subjectRef('email', '  Foo@Example.com ')
  assert.strictEqual(a, await subjectRef('email', 'foo@example.com'))
  assert.ok(a.startsWith('email:'))
  assert.ok(!a.includes('foo@'))
  assert.strictEqual(a, 'email:' + await sha256hex('foo@example.com'))
})

test('profile: el JWK va tal cual (compat con calificaciones existentes)', async () => {
  assert.strictEqual(await subjectRef('profile', jwk), jwk)
  await assert.rejects(() => subjectRef('profile', 'no-jwk'))
})

test('parseSubjectRef: tipos y opacidad del email', () => {
  assert.deepStrictEqual(parseSubjectRef('domain:example.com'), { type: 'domain', value: 'example.com' })
  assert.deepStrictEqual(parseSubjectRef('email:abc'), { type: 'email', value: 'abc', opaque: true })
  assert.strictEqual(parseSubjectRef(jwk).type, 'profile')
  assert.strictEqual(parseSubjectRef('weird').type, 'unknown')
})

test('detectSubjectType: deduce el tipo cuando el texto es inequívoco', () => {
  assert.strictEqual(detectSubjectType('foo@bar.com'), 'email')
  assert.strictEqual(detectSubjectType('https://x.com/dotrino'), 'x')
  assert.strictEqual(detectSubjectType('github.com/imdotrino'), 'github')
  assert.strictEqual(detectSubjectType('linkedin.com/company/dotrino'), 'linkedin')
  assert.strictEqual(detectSubjectType('example.com'), 'domain')
  assert.strictEqual(detectSubjectType('https://example.com/x'), 'domain')
  assert.strictEqual(detectSubjectType(jwk), 'profile')
  assert.strictEqual(detectSubjectType('   '), null)
})

test('detectSubjectType: un handle pelado es AMBIGUO → null, no se asume X', () => {
  // '@juan' puede ser de X, LinkedIn o GitHub: sujetos distintos, seguramente
  // personas distintas. Antes devolvía 'x' y calificabas a quien no era.
  assert.strictEqual(detectSubjectType('@dotrino'), null)
  assert.strictEqual(detectSubjectType('dotrino'), null)
  // El dominio del servicio SÍ es un sitio, no una cuenta (no lleva barra).
  assert.strictEqual(detectSubjectType('linkedin.com'), 'domain')
  // Con la URL no hay duda: ahí sí resuelve la red.
  assert.strictEqual(detectSubjectType('linkedin.com/in/dotrino'), 'linkedin')
})
