# @dotrino/reputation

> **Parte del ecosistema [Dotrino](https://dotrino.com).** Dotrino es un ecosistema de aplicaciones centradas en la privacidad de los datos: tu información es tuya, y las decisiones sobre ella también — qué compartes, con quién, cuándo y por qué. Sin anuncios, sin cookies, sin rastreo de datos, sin vender tu identidad a nadie.

**Registro de reputación** del ecosistema Dotrino (backend **`rep.dotrino.com`**;
la app pública vive en `reputation.dotrino.com`).
**Quinto pilar**, complementario a identidad, transporte (proxy), almacenamiento
(store) y descubrimiento (geo).

| Pilar | Paquete | Rol |
|-------|---------|-----|
| Identidad | `dotrino-identity` | clave del vault, firma, **web-of-trust local** |
| Transporte | `dotrino-proxy-client` | mensajería, canales, WebRTC (efímero) |
| Almacenamiento | `dotrino-store` | datos del usuario en su navegador |
| Descubrimiento geo | `dotrino-geo` | encontrar identidades cercanas (efímero) |
| **Reputación** | **`dotrino-reputation`** | **atestaciones firmadas compartidas (persistente)** |

## El registro es un tablón de atestaciones firmadas, no un juez

A diferencia de geo/proxy (efímeros), este registro es **persistente** — pero lo
que guarda es **opinión pública firmada**, no datos privados de peers. Cada fila
es `{ subject, issuer, rating 0–5, notes?, ts, receipt? }` **firmada por el
emisor**: el server no puede falsificarla y, si desaparece, las atestaciones
siguen donde cada peer las cacheó.

**El server NO calcula un score** (eso sería trivial de atacar con sybils). Sólo
almacena y sirve las atestaciones crudas. **El significado se computa en el
cliente.**

## Anti-sybil: la confianza está anclada en vos

`aggregateTrust(subject, { trustOf, ... })` pondera cada atestación por **cuánto
confiás VOS en quien la emite** (web-of-trust transitivo con decaimiento por
distancia). Consecuencias:

- Un **flood de bots desconocidos vale ~0**: no podés rastrearlos a nadie en
  quien confiás → no mueven la aguja. No hay número global que mover.
- Defiende **las dos direcciones**: auto-inflado (sybils que se suben el rating)
  y review-bombing (sybils que hunden a un objetivo).
- **Cold-start honesto**: un vendedor nuevo legítimo también arranca sin score
  para vos (mismo mecanismo). Mostrá el conteo crudo etiquetado aparte como
  señal débil.

La confianza personal (`trustOf`) sale del **web-of-trust local del vault**
(`getRatingsForSubject`/agregación). Local = mi opinión; registro = atestaciones
compartidas y consultables.

## Instalación

```bash
npm i @dotrino/reputation
```

## Uso

```js
import { createReputationClient } from '@dotrino/reputation'
import identity from '@dotrino/identity' // el vault

const rep = createReputationClient({
  signData: identity.signData,
  getPublicKeyJwk: identity.getPublicKeyJwk
})

// Calificar a un peer tras un trato (opcionalmente con recibo co-firmado)
await rep.publishRating({ subject: sellerPubkey, rating: 5, notes: 'todo ok' })

// Ver la reputación del peer, ponderada por MI web-of-trust
const r = await rep.aggregateTrust(sellerPubkey, {
  trustOf: async pk => myVaultTrustOf(pk),   // 0..1, o null si no tengo opinión
  myPubkey: await identity.getPublicKeyJwk()
})
// r = { score: 0.92|null, confidence, trustedCount, rawCount, txBoundCount, samples }
// score null + rawCount alto  => "muchas reseñas, ninguna de tu red" (señal débil)
```

### Multiindicador (v0.3.0)

Cada atestación lleva un **mapa de indicadores** independientes (entero 0..5):

```js
await rep.rate(peerPubkey, { confianza: 5, afinidad: 3 })   // o rep.rate(pk, 5) → confianza
const r = await rep.reputationOf(peerPubkey)
// r.indicators.confianza.score, r.indicators.afinidad.score  (cada eje independiente)
// r.score === r.indicators.confianza.score  (compat)
```

- **`confianza` es el eje especial**: es el **ancla anti-sybil** con la que se
  ponderan TODOS los indicadores (la credibilidad transitiva se calcula sobre
  confianza). Los demás ejes (afinidad = me interesa/sigo/conozco, o los que la
  app defina) se atestan y agregan **igual**, pero no gatean credibilidad.
- **Compat**: `rating` (número) ↔ `indicators.confianza`; el top-level `score`
  del resultado sigue siendo confianza. Apps 0.2.x siguen funcionando.

### Integración de 1 línea con el vault (recomendado para apps)

Las apps del ecosistema ya usan el web-of-trust local del vault. `createVaultReputation`
cablea solo el `trustOf` desde ahí y mantiene local + nube en sync:

```js
import { createVaultReputation } from '@dotrino/reputation'
const rep = createVaultReputation(identity)   // identity = vault conectado

await rep.rate(peerPubkey, 5, { notes: 'buen trato' })  // guarda local + atesta firmado
const r = await rep.reputationOf(peerPubkey)             // ponderado por MI web-of-trust → badge
const mine = await rep.myIndicatorsFor(peerPubkey)       // { confianza: 5, afinidad: 4 } → repoblar MIS controles
```

`identity` debe exponer `me.publickey`, `signData` y `getRatingsForSubject`
(la instancia de `@dotrino/identity`). El paquete no depende de
identity: se la inyectás.

#### Releer lo que YO califiqué: `myIndicatorsFor` (v0.7.0)

Cada eje es una **atestación independiente** (un registro firmado por canal), así
que las atestaciones que devuelve `getRatings` traen un `indicators` de **una sola
clave**. Releer lo tuyo con `find` te da **un solo eje** y los demás aparecen en 0:

```js
// ❌ MAL: `mine.indicators` es { confianza: 5 } — afinidad y conoce se pierden
const mine = attestations.find(a => a.issuer === myPubkey)

// ✅ BIEN: fusiona todas mis atestaciones (y compara con samePubkey)
const ind = await rep.myIndicatorsFor(subject)          // { confianza: 5, afinidad: 5, conoce: 5 }
// o, si ya tenés las atestaciones a mano:
import { myIndicators } from '@dotrino/reputation'
const ind2 = myIndicators(attestations, myPubkey)
```

Ojo: los ejes de un mismo `rate()` se emiten en paralelo y **comparten `ts`**, y el
servidor ordena por `ts DESC` — el empate hace que `find` devuelva un eje
**arbitrario**. `myIndicators(attestations, issuer)` también sirve para agrupar las
atestaciones de **otro** emisor (una fila por persona, no una por eje).

### Recibo de transacción (opcional, sube credibilidad)

Una atestación puede llevar un **recibo co-firmado** `{ a, b, ts, sigA, sigB }`
(ambas partes firman `{op:'receipt',a,b,ts}`). Prueba que hubo una interacción
real entre emisor y sujeto; marca la atestación `txBound`. No reemplaza al
anclaje de confianza (una granja de sybils puede co-firmarse recibos), pero da un
conteo de interacciones reales y sube el costo del fraude.

### Sujetos: cualquier cosa única, no solo perfiles (v0.6.0)

El `subject` no tiene que ser un perfil (pubkey): puede ser un **dominio**, un
**handle** de red o un **correo**. `subjectRef` lo normaliza a una cadena canónica
estable — misma cosa ⇒ mismo `subject_id` — para que todos apunten a la misma fila.

```js
import { subjectRef, detectSubjectType } from '@dotrino/reputation'
await subjectRef('domain', 'https://www.Example.com/') // → 'domain:example.com'
await subjectRef('x', '@dotrino')                       // → 'x:dotrino'
await subjectRef('email', 'Foo@Example.com')            // → 'email:<sha256>' (nunca en claro)
// el perfil va como su JWK tal cual (compat con las calificaciones existentes)
detectSubjectType('github.com/imdotrino')               // → 'github'
detectSubjectType('@dotrino')                           // → null: ¿de qué red? (v0.8.0)
```

`detectSubjectType` sólo resuelve lo **inequívoco** (un JWK, un correo, una URL del
servicio, un dominio). Un **handle pelado** (`@juan`) devuelve **`null`** a
propósito: puede ser de X, de LinkedIn o de GitHub — sujetos distintos, y casi
seguro personas distintas. Hasta la 0.7 se asumía X en silencio, así que quien
escribía `@juan` pensando en LinkedIn terminaba calificando a otro. Si te da
`null`, **pregunta de qué red es** (un selector de tipo) y llama a
`subjectRef(tipo, valor)`, que acepta el handle con o sin `@`, o la URL.

Sólo el **emisor** debe ser una pubkey (firma). El peso anti-sybil se ancla en tu
confianza en los EMISORES, así que `aggregateTrust`/`reputationOf` funcionan igual
sea el sujeto un perfil, un dominio o un handle.

### Preguntas y respuestas ordenadas por reputación (v0.6.0)

Cualquiera adjunta **preguntas** a un sujeto y cualquier perfil las **responde**
(una respuesta por perfil). `rankQuestions` ordena por la **credibilidad sumada de
quienes responden**: una respuesta de reputación real en tu web-of-trust pesa más
que millones de desconocidos (reusa el mismo motor `credibility` que las calificaciones).

```js
const rep = createVaultReputation(identity)
const subject = await subjectRef('domain', 'tienda.com')
const { questionId } = await rep.postQuestion(subject, '¿Es confiable?')
await rep.answer(questionId, 'Sí, compré y llegó')
const ranked = await rep.rankQuestions(subject)
// ranked[i] = { question, weight, weightedAnswerers, rawAnswerCount, answers[] }
```

## API del servicio (HTTP/JSON, backend `rep.dotrino.com`)

| Método | Ruta | Auth | Descripción |
|--------|------|------|-------------|
| `PUT` | `/ratings` | sobre firmado por el emisor | publica/reemplaza una atestación (`op:'rate'` por canal) |
| `DELETE` | `/ratings` | sobre firmado | retira la atestación (con `channel` = un solo eje) |
| `GET` | `/ratings?subject=<ref>` | pública | atestaciones crudas sobre un sujeto |
| `PUT` | `/questions` | sobre firmado | publica una pregunta → `{ questionId }` |
| `DELETE` | `/questions` | sobre firmado | retira la propia pregunta |
| `GET` | `/questions?subject=<ref>` | pública | preguntas crudas de un sujeto |
| `PUT` | `/answers` | sobre firmado | publica/reemplaza la propia respuesta |
| `DELETE` | `/answers` | sobre firmado | retira la propia respuesta |
| `GET` | `/answers?question=<id>` | pública | respuestas crudas a una pregunta |
| `GET` | `/health` | — | liveness |

Ver [`server/`](./server) y [`DEPLOY.md`](./DEPLOY.md). **Independiente de geo**:
base Postgres propia, puerto propio, despliegue propio (escalable a otro server).

## Licencia

MIT
