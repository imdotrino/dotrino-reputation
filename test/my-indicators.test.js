// Regresión del bug "califiqué 5,5,5 y sólo un indicador muestra el valor":
// el registro guarda UNA atestación por eje, así que releer lo mío con
// `attestations.find(...)` devuelve un mapa de una sola clave y pierde el resto.
// `myIndicators` fusiona TODAS mis atestaciones (y compara con samePubkey).

import { test } from 'node:test'
import assert from 'node:assert'
import { myIndicators } from '../src/index.js'

// pubkeys "JWK" falsas pero parseables (x único por identidad).
const pk = (name, extra = {}) => JSON.stringify({ kty: 'EC', crv: 'P-256', x: name, y: 'Y', ...extra })
const me = pk('me')
// Como las emite el servidor: una atestación por canal, `indicators` de UNA clave.
const att = (issuer, channel, value, extra = {}) =>
  ({ issuer, subject: 'domain:dotrino.com', indicators: { [channel]: value }, ts: 1, ...extra })

test('fusiona mis tres ejes (el caso 5,5,5 del registro real)', () => {
  const atts = [att(me, 'confianza', 5), att(me, 'afinidad', 5), att(me, 'conoce', 5)]
  assert.deepEqual(myIndicators(atts, me), { confianza: 5, afinidad: 5, conoce: 5 })
  // find() —el bug— sólo habría devuelto { confianza: 5 }.
  assert.notDeepEqual(atts.find(a => a.issuer === me).indicators, myIndicators(atts, me))
})

test('el orden no importa (los 3 registros comparten ts: el ORDER BY empata)', () => {
  const base = [att(me, 'confianza', 5), att(me, 'afinidad', 4), att(me, 'conoce', 3)]
  const expected = { confianza: 5, afinidad: 4, conoce: 3 }
  for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0], [2, 0, 1]]) {
    assert.deepEqual(myIndicators(order.map(i => base[i]), me), expected)
  }
})

test('ignora las atestaciones de otros', () => {
  const atts = [
    att(pk('otro'), 'confianza', 1), att(me, 'confianza', 5),
    att(pk('otro'), 'afinidad', 0), att(me, 'afinidad', 4),
  ]
  assert.deepEqual(myIndicators(atts, me), { confianza: 5, afinidad: 4 })
})

test('reconoce mi emisor aunque el JWK venga serializado distinto', () => {
  // Un JWK serializado no es canónico: orden de claves y miembros extra varían,
  // y una respuesta puede mezclar la tabla nueva con la legacy. Por eso samePubkey.
  const mine = JSON.stringify({ crv: 'P-256', ext: true, key_ops: ['verify'], kty: 'EC', x: 'me', y: 'Y' })
  assert.notEqual(mine, me) // === habría fallado
  assert.deepEqual(myIndicators([att(mine, 'afinidad', 3)], me), { afinidad: 3 })
})

test('compat: una atestación vieja con `rating` cuenta como confianza', () => {
  const legacy = { issuer: me, subject: 'domain:dotrino.com', rating: 4, ts: 1 }
  assert.deepEqual(myIndicators([legacy, att(me, 'afinidad', 2)], me), { confianza: 4, afinidad: 2 })
})

test('cero es un valor, no una ausencia', () => {
  assert.deepEqual(myIndicators([att(me, 'confianza', 0)], me), { confianza: 0 })
})

test('sin nada mío (o sin pubkey/lista) devuelve {}', () => {
  assert.deepEqual(myIndicators([att(pk('otro'), 'confianza', 5)], me), {})
  assert.deepEqual(myIndicators([], me), {})
  assert.deepEqual(myIndicators(null, me), {})
  assert.deepEqual(myIndicators([att(me, 'confianza', 5)], null), {})
})

test('descarta basura sin romper', () => {
  const atts = [null, { subject: 'x' }, { issuer: 42 }, att(me, 'confianza', 5), { issuer: me }]
  assert.deepEqual(myIndicators(atts, me), { confianza: 5 })
})
