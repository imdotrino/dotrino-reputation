/**
 * Serialización JSON canónica (claves ordenadas recursivamente).
 * Necesaria para que las firmas coincidan entre cliente y servidor.
 * Idéntica a la del proxy-client / proxy-server del ecosistema.
 */
export function canonicalStringify (value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalStringify).join(',') + ']'
  }
  const keys = Object.keys(value).sort()
  const parts = keys.map(k => JSON.stringify(k) + ':' + canonicalStringify(value[k]))
  return '{' + parts.join(',') + '}'
}
