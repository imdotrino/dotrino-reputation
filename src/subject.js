/**
 * @dotrino/reputation — SUJETOS canónicos.
 *
 * Un "sujeto" es cualquier cosa única sobre la que se puede opinar: un perfil
 * (pubkey), un dominio, un handle de red o un correo. Para que TODOS apunten a
 * la MISMA fila del registro, el sujeto se normaliza a una cadena canónica
 * estable — mismo string ⇒ mismo `subject_id`. La normalización se aplica IGUAL
 * al escribir y al leer (si no, `x.com`, `https://x.com/` y `X.com` se
 * fragmentarían en sujetos distintos).
 *
 * Formas canónicas:
 *   perfil   → el JWK string TAL CUAL (compat con las calificaciones de perfiles
 *              ya existentes; un JWK empieza por '{' y nunca colisiona con 'tipo:valor')
 *   dominio  → 'domain:<host>'      (minúsculas, sin esquema/ruta/www/puerto)
 *   x        → 'x:<handle>'
 *   github   → 'github:<handle>'
 *   linkedin → 'linkedin:<slug>'
 *   correo   → 'email:<sha256hex>'  (HASH; el correo NUNCA se guarda en claro)
 *
 * `subjectRef` es async por el hash del correo (WebCrypto).
 */

export const SUBJECT_TYPES = ['profile', 'domain', 'x', 'github', 'linkedin', 'email']

/** sha256 hex con WebCrypto (navegador + Node 18+). */
export async function sha256hex (str) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle
  if (!subtle) throw new Error('reputation: WebCrypto no disponible (sha256)')
  const buf = await subtle.digest('SHA-256', new TextEncoder().encode(String(str)))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** ¿Parece un JWK P-256? (un perfil como sujeto es su JWK tal cual). */
export function isJwk (s) {
  try {
    const j = JSON.parse(s)
    return !!j && j.kty === 'EC' && j.crv === 'P-256' && !!j.x && !!j.y
  } catch (_) { return false }
}

function stripScheme (s) { return String(s).trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '') }

function normDomain (v) {
  let s = stripScheme(v)
  s = s.replace(/^www\./, '')
  s = s.split(/[/?#]/)[0]   // ruta/query/hash
  s = s.split('@').pop()     // por si pegaron user@host
  s = s.split(':')[0]        // puerto
  return s
}

function isDomain (host) {
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)
}

// Extrae el handle de un valor que puede ser '@h', 'h' o una URL del servicio.
function extractHandle (v, hosts) {
  let s = stripScheme(v).replace(/^www\./, '')
  for (const h of hosts) {
    if (s.startsWith(h + '/')) { s = s.slice(h.length + 1); break }
  }
  s = s.split(/[/?#]/)[0]
  return s.replace(/^@+/, '')
}

function normLinkedin (v) {
  const s = stripScheme(v).replace(/^www\./, '')
  const m = s.match(/linkedin\.com\/(?:in|company)\/([^/?#]+)/)
  if (m) return m[1]
  return s.replace(/^@+/, '').split(/[/?#]/)[0]
}

/**
 * Codifica un sujeto a su referencia canónica. `type` ∈ SUBJECT_TYPES.
 * @returns {Promise<string>}
 */
export async function subjectRef (type, value) {
  switch (type) {
    case 'profile': {
      if (!isJwk(value)) throw new Error('subjectRef profile: se requiere un JWK P-256')
      return value // tal cual: mantiene continuidad con las calificaciones de perfiles
    }
    case 'domain': {
      const host = normDomain(value)
      if (!isDomain(host)) throw new Error('subjectRef domain: dominio inválido')
      return `domain:${host}`
    }
    case 'x': {
      const h = extractHandle(value, ['x.com', 'twitter.com'])
      if (!/^[a-z0-9_]{1,15}$/.test(h)) throw new Error('subjectRef x: handle inválido')
      return `x:${h}`
    }
    case 'github': {
      const h = extractHandle(value, ['github.com'])
      if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(h)) throw new Error('subjectRef github: handle inválido')
      return `github:${h}`
    }
    case 'linkedin': {
      const h = normLinkedin(value)
      if (!/^[a-z0-9-]{3,100}$/.test(h)) throw new Error('subjectRef linkedin: slug inválido')
      return `linkedin:${h}`
    }
    case 'email': {
      const e = String(value).trim().toLowerCase()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error('subjectRef email: correo inválido')
      return `email:${await sha256hex(e)}`
    }
    default:
      throw new Error(`subjectRef: tipo desconocido "${type}"`)
  }
}

/**
 * Descompone una referencia canónica para renderizar. El correo es `opaque`
 * (es un hash, no se puede revertir al correo original).
 * @returns {{type:string, value:string, opaque?:boolean}}
 */
export function parseSubjectRef (ref) {
  if (typeof ref !== 'string' || !ref) return { type: 'unknown', value: String(ref ?? '') }
  if (isJwk(ref)) return { type: 'profile', value: ref }
  const i = ref.indexOf(':')
  if (i > 0) {
    const type = ref.slice(0, i)
    const value = ref.slice(i + 1)
    if (SUBJECT_TYPES.includes(type)) {
      return type === 'email' ? { type, value, opaque: true } : { type, value }
    }
  }
  return { type: 'unknown', value: ref }
}

/**
 * Adivina el tipo de sujeto desde un texto pegado por el usuario (para el input
 * de "añadir sujeto"). Devuelve un tipo de SUBJECT_TYPES o null si no reconoce.
 */
export function detectSubjectType (input) {
  const s = String(input || '').trim()
  if (!s) return null
  if (isJwk(s)) return 'profile'
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'email'
  if (/linkedin\.com\//i.test(s)) return 'linkedin'
  if (/(?:\/\/|^)(?:www\.)?github\.com\//i.test(s)) return 'github'
  if (/(?:\/\/|^)(?:www\.)?(?:x|twitter)\.com\//i.test(s)) return 'x'
  if (/^@[a-z0-9_]{1,15}$/i.test(s)) return 'x'
  if (isDomain(normDomain(s))) return 'domain'
  return null
}
