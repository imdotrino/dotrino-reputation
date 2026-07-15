# Reputation — calificar y preguntar sobre cualquier sujeto único (diseño)

> Estado 2026-07-15: **Fase 1 (paquete 0.6.0) y Fase 2 (servidor) HECHAS y
> desplegadas**; el **frontend (Fase 3) sigue pendiente**. La app se llama
> **`reputation`** (`reputation.dotrino.com`); por eso el backend se renombró a
> **`rep.dotrino.com`**. Fuente única de esta feature. Complementa
> [`federacion-confianza.md`](./federacion-confianza.md) (prueba de control, **Fase 4**).

## Objetivo

Un frontend donde un perfil puede:

1. **Calificar cualquier sujeto único**: otro perfil (pubkey), un **dominio**, o un
   **correo / handle de red** (X, GitHub, LinkedIn). *No* URLs de páginas concretas
   en v1.
2. Calificar **ejes independientes**: `confianza` (ancla anti-sybil), `afinidad`,
   `conoce`.
3. **Adjuntar preguntas** a un sujeto y responderlas (el autor responde la suya;
   cualquier perfil puede responder, una respuesta por perfil).
4. Las preguntas se **ordenan por respuestas ponderadas por reputación**, ancladas
   en *tu* red: **un perfil de reputación mínima real en tu web-of-trust pesa más
   que millones de reputación 0**.

## Lo que YA existe (se reusa, no se reimplementa)

- **Sujeto = cadena opaca firmada.** El servidor de reputación solo exige que el
  **emisor** sea una pubkey P-256 válida; el `subject` es una cadena arbitraria
  sobre la que el emisor firma. `subject_id = pubkeyId(subject)`, que ante un
  no-JWK cae a `sha256(String(subject))`. → Un dominio/handle **ya se almacena y
  se lee hoy** sin tocar el server.
- **Ejes = canales.** `client.rate({subject, channel, value:0..5})`. `afinidad`
  existe; `conoce` es un slug nuevo, **cero cambios de backend**. `confianza` es el
  ancla anti-sybil.
- **Ranking anti-sybil = `aggregateTrust`.** Su `credibility(emisor)` interno pondera
  por *tu* confianza, transitiva (maxDepth 2, decay 0.5) y **por debajo de
  `minCredibility=0.05` cuenta 0**. Un desconocido aporta exactamente 0. Esto **es**
  la regla "1 rep-1 de mi red > 5M rep-0"; solo hay que **repaquetarla** para ordenar
  preguntas por la credibilidad sumada de quienes las responden.

## Modelo de sujetos (`subjectRef`)

Codificador compartido, aplicado **idéntico al escribir y al leer** (si no, el mismo
sujeto se fragmenta en varios `subject_id`):

| Tipo | `subjectRef` | Normalización |
|------|--------------|---------------|
| Perfil | **el JWK string tal cual** (como hoy) | ninguna — mantiene la continuidad con las calificaciones de perfiles existentes |
| Dominio | `domain:<host>` | minúsculas, quita esquema/ruta/query, quita `www.` (reusa `SERVICES.web.norm` de `@dotrino/verifier`) |
| Email | `email:<sha256hex>` | minúsculas+trim → **hash** (nunca se guarda el correo en claro; anti-reuso `H(email)` del doc de federación) |
| X | `x:<handle>` | `normHandle('x', handle)` (sin `@`, minúsculas) |
| GitHub | `github:<handle>` | `normHandle('github', …)` |
| LinkedIn | `linkedin:<slug>` | `normHandle('linkedin', …)` |

Un JWK string empieza por `{` y nunca colisiona con un prefijo `tipo:valor`.
El email va **hasheado**: dos personas que escriben el mismo correo caen en el mismo
`subject_id`, pero el registro nunca ve el correo (privacidad por diseño).

**Nuevo en `@dotrino/reputation`:** `subjectRef(type, value) -> string` +
`parseSubjectRef(ref) -> {type, value}` (para render). Aflojar los textos de error
"subject requerido (pubkey JWK)" que hoy asumen pubkey.

## Ejes de calificación

- `confianza` 0..5 — **ancla anti-sybil** (pondera todo lo demás; no se quita).
- `afinidad` 0..5 — me interesa / sigo.
- `conoce` — booleano codificado como **0 / 5** (la UI es un toggle "¿lo conoces?");
  se atesta y agrega igual que cualquier canal, pero no gatea credibilidad.

Para un dominio, `confianza` = "confío en este sitio". El anti-sybil sigue anclado en
la confianza en el **emisor**, no en el sujeto, así que funciona igual sea cual sea el
tipo de sujeto.

## Preguntas y respuestas (nuevo)

Registros públicos firmados, en el **registro compartido** (`reputation.dotrino.com`).
**No** en `@dotrino/store` (privado por usuario) ni en el proxy (efímero).

### Esquema (migración idempotente, patrón de `schema.sql`)

```sql
CREATE TABLE IF NOT EXISTS questions (
  question_id TEXT PRIMARY KEY,          -- sha256(canonical {op:'question',subject,issuer,text,ts})
  subject_id  TEXT NOT NULL,             -- pubkeyId(subjectRef)
  subject     TEXT NOT NULL,             -- subjectRef
  issuer_id   TEXT NOT NULL,
  issuer      TEXT NOT NULL,             -- JWK del autor
  text        TEXT NOT NULL,             -- <= 280
  ts          BIGINT NOT NULL,
  signature   TEXT NOT NULL,
  updated_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_questions_subject ON questions (subject_id);

CREATE TABLE IF NOT EXISTS answers (
  answer_id   TEXT PRIMARY KEY,          -- sha256(canonical {op:'answer',question_id,issuer,text,ts})
  question_id TEXT NOT NULL,
  issuer_id   TEXT NOT NULL,
  issuer      TEXT NOT NULL,
  text        TEXT NOT NULL,             -- <= 280
  ts          BIGINT NOT NULL,
  signature   TEXT NOT NULL,
  updated_at  BIGINT NOT NULL,
  UNIQUE (question_id, issuer_id)        -- una respuesta por perfil (upsert = editar)
);
CREATE INDEX IF NOT EXISTS idx_answers_question ON answers (question_id);
```

### Ops / endpoints (mismo sobre firmado `{data, signature}` que `rate`)

| Método | Ruta | Auth | Descripción |
|--------|------|------|-------------|
| `PUT` | `/questions` | sobre firmado (`op:'question'`) | crea/reemplaza una pregunta del autor |
| `PUT` | `/answers` | sobre firmado (`op:'answer'`) | crea/reemplaza mi respuesta a una pregunta |
| `GET` | `/questions?subject=<ref>` | pública | preguntas crudas de un sujeto |
| `GET` | `/answers?question=<id>` | pública | respuestas crudas (con JWK del emisor) |
| `DELETE` | `/questions`, `/answers` | sobre firmado (tombstone) | retirar la propia |

El autor **puede** responder su propia pregunta: `answer` es una op distinta de
`rate`, así que la guarda anti-autocalificación (`samePubkey(issuer, subject)`) no
aplica. Verificación de firma y ventana de frescura (±5 min) como en `rate`.

## Ranking ponderado por reputación (nuevo, cliente)

`aggregateTrust` hoy pondera **valores** 0..5; aquí hace falta ponderar **conteo de
respuestas**. Se reusa el mismo motor:

1. **Exportar** `credibilityOf(pk, {trustOf, myPubkey, maxDepth, decay, minCredibility})`
   — el `credibility()` que hoy es privado dentro de `aggregateTrust` (refactor a
   función compartida).
2. `rankQuestions(subjectRef, {trustOf, myPubkey})`:
   - `getQuestions(subjectRef)` → lista.
   - por pregunta: `getAnswers(question_id)` → emisores.
   - `peso(q) = Σ credibilityOf(emisor)` sobre respondedores distintos
     (desconocidos → 0). Desempate: nº de respuestas / recencia.
   - devuelve `{ question, peso, respondedoresPonderados, respuestasCrudas,
     answers[] }` con `answers` ordenadas por credibilidad del respondedor.

**Semántica elegida:** el peso es la **suma de credibilidad** de los respondedores
(`totalW`), no el simple conteo — así "1 de rep-1 en tu red > 5M de rep-0" cae solo.
Etiquetar aparte el **conteo crudo** como señal débil (como ya hace el pilar con
`rawCount`).

**Coste:** `rankQuestions` hace fan-out (`getAnswers` por pregunta + camino de
credibilidad por respondedor, cada uno dispara `getRatings`). Mitiga el memo de 30 s +
dedup in-flight que ya existe. Para sujetos calientes, un conteo server-side es
**deuda futura**; en v1 basta el fan-out cliente.

## Anti-sybil: por qué ya está resuelto

El peso de una respuesta = credibilidad del **respondedor** en *tu* web-of-trust
(transitiva, con decaimiento, con piso a 0). Es independiente del tipo de sujeto: solo
importan los emisores. Un sujeto nuevo sin respondedores en tu red da ranking
vacío/baja confianza — inherente, no un bug; la UI maneja el caso `null`/débil.

## Frontend (app nueva)

App Vite standalone (**`reputation`** → `reputation.dotrino.com`, backend `rep.dotrino.com`) que:

- Reusa las singletons de servicio de `dotrino-eco` (`identity`/`reputation`/`store`) y
  el `<dotrino-topbar profile>` de `dotrino-terminal`. Pinea versiones **actuales**
  (identity 0.20, reputation con lo nuevo, profile 0.12.1, topbar 0.2.2, support @0.7).
- **Buscar/añadir sujeto**: input que detecta tipo (URL/dominio → `domain:`, `@handle`
  → `x:`/`github:`, correo → `email:`; o elegir un contacto → perfil) y normaliza a
  `subjectRef`.
- **Ficha del sujeto**: si es perfil → `<dotrino-profile>`; si no → *SubjectCard* nueva
  (cabecera tipo+valor + identicon del `subjectRef`, los 3 ejes para calificar, y
  `reputationOf(subjectRef)` agregada).
- **Preguntas**: lista ordenada por `rankQuestions`; cada una con autor, respuestas
  (ordenadas por credibilidad), botón "responder" (una por perfil) y "añadir pregunta"
  (el autor la crea y responde).
- **Explorar** ("recién calificados"): el server no lista sujetos → v1 acumula *mis*
  sujetos vistos en `@dotrino/store` (privado) + compartir por `#fragment`. Marcar el
  límite.

Cumple CONVENCIONES: `base:'./'`, PWA + `<meta commit>` + `registerSW`, bilingüe es/en
**tuteo**, GoatCounter, `<dotrino-support @0.7>`, botón perfil (§6.1), alta en el
catálogo (`dotrino-home/src/data/apps.ts`).

## Privacidad / SEO (no romper la filosofía)

- El correo va **hasheado**; el registro nunca lo ve en claro.
- Calificaciones/preguntas/respuestas son **opinión pública firmada** (igual que el
  pilar) — no contenido privado. Las fichas de sujeto viven tras **`#fragment`**
  (`#s=domain:example.com`), **no** rutas crawleables. Se indexa solo la cáscara.
- Sin trackers de terceros; solo GoatCounter.

## Deudas conocidas que se tocan de paso

- **DELETE de attestations por canal**: `db.deleteAttestation` existe pero **no** tiene
  ruta; `DELETE /ratings` solo borra la tabla legacy. Cablearla para que la UI pueda
  "des-calificar" el modelo primario.
- **Anti-rollback**: los upsert sobrescriben dentro de la ventana de ±5 min sin exigir
  `ts` monótono; relevante si preguntas/respuestas son editables. Añadir guarda de
  `ts` monótono en `questions`/`answers`.

## Fases

1. ✅ **HECHA — Paquete `@dotrino/reputation` 0.6.0** (publicado): `subjectRef`/
   `parseSubjectRef`/`detectSubjectType`, `credibilityOf` exportado,
   `postQuestion/postAnswer/getQuestions/getAnswers/rankQuestions`, `removeChannel`,
   `DEFAULT_BASE=rep.dotrino.com`. 27 tests.
2. ✅ **HECHA — Servidor** (en vivo en `rep.dotrino.com`): tablas `questions`/`answers`
   + ops firmadas + GET, DELETE de attestations por canal, guarda `ts` monótono en
   answers. Migración idempotente (corre al arrancar). Producción = node+pm2+nginx en
   el VPS 74.208.11.221 (no el docker-compose del repo); vhost `rep` + cert añadidos.
3. ⏳ **Pendiente — App `reputation`**: repo nuevo, Vite, SubjectCard + `<dotrino-profile>`,
   lista de preguntas ordenada, store. Deploy Pages (reputation.dotrino.com) + catálogo.
   Antes o en paralelo: **bumpear los consumidores** de `@dotrino/reputation` a 0.6.0.
4. ⏳ **Diferido — prueba de control** (`op:'verify'` + Worker verificador) para
   "reclamar" dominios/handles y responder con autoridad. Base en
   `federacion-confianza.md` y `@dotrino/verifier`.
