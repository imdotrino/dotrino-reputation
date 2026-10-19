// Nombre de un indicador (canal): slug corto [a-z][a-z0-9_]{0,23}. La misma regla vive en
// server/server.js (`isSlug`): el servidor se construye aparte (contexto ./server) y no
// puede importar de aquí.
const SLUG = /^[a-z][a-z0-9_]{0,23}$/

/** ¿Es `s` un nombre de indicador válido? */
export const isSlug = (s) => typeof s === 'string' && SLUG.test(s)
