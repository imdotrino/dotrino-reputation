# @dotrino/reputation

> **Parte del ecosistema [Dotrino](https://dotrino.com).** Misión: aplicaciones que resuelven problemas comunes, respetando tu privacidad — sin anuncios, sin cookies, sin rastreo de datos, sin vender tu identidad a nadie.

**Registro de reputación** del ecosistema Dotrino: `reputation.dotrino.com`.
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
```

`identity` debe exponer `me.publickey`, `signData` y `getRatingsForSubject`
(la instancia de `@dotrino/identity`). El paquete no depende de
identity: se la inyectás.

### Recibo de transacción (opcional, sube credibilidad)

Una atestación puede llevar un **recibo co-firmado** `{ a, b, ts, sigA, sigB }`
(ambas partes firman `{op:'receipt',a,b,ts}`). Prueba que hubo una interacción
real entre emisor y sujeto; marca la atestación `txBound`. No reemplaza al
anclaje de confianza (una granja de sybils puede co-firmarse recibos), pero da un
conteo de interacciones reales y sube el costo del fraude.

## API del servicio (HTTP/JSON)

| Método | Ruta | Auth | Descripción |
|--------|------|------|-------------|
| `PUT` | `/ratings` | sobre firmado por el emisor | publica/reemplaza una atestación |
| `DELETE` | `/ratings` | sobre firmado | retira la atestación del emisor |
| `GET` | `/ratings?subject=<JWK>` | pública | atestaciones crudas sobre un sujeto |
| `GET` | `/health` | — | liveness |

Ver [`server/`](./server) y [`DEPLOY.md`](./DEPLOY.md). **Independiente de geo**:
base Postgres propia, puerto propio, despliegue propio (escalable a otro server).

## Licencia

MIT
