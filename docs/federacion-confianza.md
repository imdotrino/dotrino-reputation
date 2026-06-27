# Federación y confianza en Dotrino

> Estado: **diseño**. La sección de **verificación** es construible y es el plan inmediato.
> La sección de **federación de infraestructura** (proxy, geo, …) es **teórica / fuera de
> alcance por ahora** — queda documentada como norte, no como trabajo planificado.

Este documento describe cómo Dotrino extiende su web-of-trust a dos cosas:

1. **Verificación de identidad** (correo, redes sociales): cómo un perfil obtiene un badge
   "✓ verificado" sin sacrificar privacidad, y cómo eso lo rankea mejor.
2. **Federación de servicios** (transporte, geo, etc.): cómo, en teoría, cualquier servicio
   con estado podría correrlo cualquiera, prefiriéndose por reputación y antigüedad.

Ambas comparten el mismo ADN: **toda parte que da fe es una identidad que firma, y la
confianza en lo que firma sale del web-of-trust que ya existe** (`@dotrino/reputation` +
`aggregateTrust`). Dotrino corre instancias canónicas, pero **sin privilegio de protocolo**.

---

## 0. Principios

- **Alta privacidad, no alto anonimato.** Verificar reduce el anonimato **por elección del
  usuario**, nunca por defecto. Un usuario puede quedarse seudónimo (cero verificaciones) o
  construir un perfil muy verificado — *tu información, tus reglas*.
- **Verificado ≠ revelado.** Son dos cosas independientes (ver §1.1). Por defecto: el badge
  sí, el dato no.
- **Nadie es autoridad central.** Verificadores y servicios son identidades cualquiera; su
  peso es su reputación (y antigüedad). Dotrino es solo una identidad bien reputada.
- **Reusar, no reimplementar.** Mismo `canonicalStringify` + ECDSA P-256 + atestaciones
  firmadas + `aggregateTrust` que el resto del ecosistema.

---

## 1. Verificación (construible)

### 1.1. Verificado ≠ revelado

Dos ejes ortogonales que el usuario controla por separado:

| Eje | Qué es | Default |
|-----|--------|---------|
| **Verificado** (badge) | "esta identidad controla un correo / una cuenta real" — señal de confianza y anti-sybil | **sí** (si el usuario lo pide) |
| **Revelado** (disclosure) | mostrar el dato concreto (la dirección, el handle) | **no** |

La confianza del badge **no viene de ver el dato, viene de la firma del verificador** que
confirmó que el usuario lo controla. Nadie necesita ver tu correo para confiar en
"✓ correo verificado".

Tres niveles, elegidos por el usuario:

1. **Seudónimo** — sin verificaciones.
2. **Verificado (privado)** — badges "✓ correo · ✓ red", **sin** exponer ningún dato. Sube
   ranking + anti-sybil, con máxima privacidad.
3. **Verificado y revelado** — además muestra el correo/handle. Opt-in, máxima transparencia
   (y máxima comprobabilidad por terceros).

### 1.2. El verificador es un tercero que firma — y federado

- Un **verificador es una identidad** (vault/pubkey) que corre **la app de verificación**.
  No hay lista oficial: **cualquiera puede ser verificador**.
- El **badge es una atestación firmada por el verificador** (no por el usuario; un
  autobadge no vale nada). El usuario la **recibe y la adjunta** a su perfil — decide cuáles
  mostrar.
- Dotrino corre **un bot verificador**: una instancia más de la misma app, **sin privilegio
  de protocolo**.
- **La confianza del badge = la confianza en ESE verificador**, vía el **mismo** web-of-trust
  que rankea personas. No hay primitiva nueva (ver §1.5). Un verificador en quien la red
  confía hace badges que pesan; un sybil que corre su propio verificador y se auto-firma
  badges produce badges de un nodo sin confianza → **peso ≈ 0**. El sybil de verificadores se
  cae solo.

### 1.3. Esquema de la atestación de verificación

Encaja en `@dotrino/reputation` como un nuevo discriminador `op:'verify'` (emisor = el
**verificador**, sujeto = el **usuario verificado**). Reusa la firma/almacén/consulta
existentes.

```jsonc
{
  "op": "verify",
  "iss": "<JWK del VERIFICADOR>",   // issuer = quien da fe (no el usuario)
  "sub": "<JWK del usuario verificado>",
  "ch":  "email" | "x" | "github" | "linkedin" | "web" | "...",
  "claim": "controls",
  "ts":  1719500000000,
  "exp": 1727449200000,             // opcional: caducidad → re-verificación periódica
  "reveal": {                       // OPCIONAL y opt-in. Por defecto AUSENTE.
    "value":   "@handle",           //   redes: el handle público
    "domain":  "empresa.com",       //   correo: solo el dominio
    "proofUrl":"https://x.com/.../status/..."  // prueba pública re-verificable
  },
  "sig": "<base64 ECDSA P-256 (r||s) del verificador sobre canonicalStringify(sin sig)>"
}
```

- **Sin `reveal`** = badge a secas (privado). El verificador da fe; el dato no aparece.
- **Con `reveal.proofUrl`** = además, cualquiera re-verifica solo (zero-trust), sin confiar
  en el verificador.

> Nota de implementación: el server (`dotrino-reputation/server/`) despacha por `op`
> (`handlePut` → `handleRate`/`handlePutLegacy`); agregar `op:'verify'` es un handler nuevo
> + verificar la firma del `iss` (ya hay `verifySignature`). Alternativa más liviana sin
> tocar el server: una atestación `channel:'verify'` por el path `rate()` existente. La
> decisión (handler propio vs canal) se toma al construir.

### 1.4. Dos mecanismos según quién puede dar fe

**A. Redes / web — auto-verificable (estilo Keybase).**
- El vault firma `{ identity: pubkey, servicio, handle, ts }` (prueba de control).
- El usuario publica esa prueba (o un enlace) en su cuenta **pública** (X, GitHub, web…).
- **Bidireccional:** el post referencia la pubkey y el perfil referencia el post.
- El verificador (app) baja la **página pública** (el navegador no puede por CORS → lo hace
  un Worker, mismo patrón que `dotrino-feedback`/`shortener`) y, si la prueba valida, **firma**
  la atestación `op:'verify', ch:'x'`.
- Privacidad: la red ya es pública; con `reveal.proofUrl` queda re-verificable; sin él, el
  badge va con el handle oculto (se confía en el verificador).
- **Barato de correr** (solo fetch público) → es lo que más gente podrá levantar. **Primer
  entregable.**

**B. Correo — challenge-response.**
- El verificador (Worker + Resend, como `feedback`) envía un código de un solo uso.
- El usuario lo ingresa; el vault firma; el verificador (que confirmó la entrega) **firma**
  `op:'verify', ch:'email'`.
- Por defecto **no expone nada** (ni hash ni dominio). Para el anti-reuso (un mismo correo
  verificando mil identidades = sybil), el verificador guarda `H(correo) → pubkey`
  **internamente** y rechaza reusos; eso no es público.
- **Más barrera** (necesita enviar correo) → probablemente lo cubra el bot de Dotrino.

### 1.5. Ranking: peso por reputación (gratis) + antigüedad (TODO)

`aggregateTrust` (`@dotrino/reputation/src/index.js`) ya pondera cada atestación por la
**credibilidad transitiva del `iss`** (web-of-trust desde el observador, con decay por salto
y caps anti-sybil). Por lo tanto:

- Una verificación firmada por un verificador **pesa proporcional a la reputación de ese
  verificador** — *sin código nuevo en la agregación*. El badge de un verificador en quien
  confías (o ampliamente reconocido) cuenta; el de uno desconocido, casi nada.
- La verificación es una **señal aparte** del eje de endosos (`confianza`): se muestra como
  badge y alimenta el orden, **con tope** — nunca debe "comprar" el grafo. Un sybil verificado
  sigue siendo **un** nodo.

**Antigüedad (parcialmente construible, ver §2):** sumar al peso del verificador (y de
cualquier identidad) cuánto hace que opera. Es anti-sybil (la longevidad no se falsifica
barato). Gameable por un sybil **paciente** → **siempre reputación + edad**, nunca edad sola.

### 1.6. Badges en el perfil

`<dotrino-profile>` (`@dotrino/profile`) lee las atestaciones del sujeto (ya lo hace vía
`provider.getCloudReputation`/`getEndorsements`) y pinta un badge por cada `op:'verify'`
**cuya firma valida**, con el peso dado por `aggregateTrust(iss)`. Si trae `reveal.proofUrl`,
el badge enlaza la prueba. Sin `reveal`, muestra solo "✓ \<canal\> verificado".

### 1.7. Privacidad del verificador

El verificador **sí aprende** el vínculo correo/handle ↔ pubkey (tiene que enviar el código /
mirar el post). No lo expone, pero lo ve. Para que sea aceptable en "alta privacidad":

- **Mínimo y que no retiene:** verifica → firma → olvida. Para anti-reuso, a lo sumo
  `H(correo)`.
- **Open-source, auditable y self-hosteable:** si no confías en el de Dotrino, corres el tuyo;
  la federación lo acepta (es solo otra identidad firmante).

---

## 2. Antigüedad (parcialmente construible)

Objetivo: que el peso de una identidad (persona o verificador o servicio) suba con el tiempo
que lleva operando, como señal anti-sybil y de fiabilidad.

- **Proxy barato (ya disponible):** usar el `ts` de la **atestación más antigua** de esa
  identidad como cota inferior de su edad. No prueba el génesis, pero es gratis y monótono.
- **Prueba fuerte (con el TSA `dotrino-signer`):** sellar un "génesis" — `POST /seal { hash }`
  devuelve `{ op:'seal', hash, ts, signature, pubkey }` firmado por la TSA. La identidad sella
  `H(su estado inicial)` al nacer → prueba "existe desde T" verificable offline. La TSA es a su
  vez un servicio federable (idealmente varias TSAs / anclaje a una cadena pública para
  inforjabilidad total; fuera de alcance ahora).
- **Integración en `aggregateTrust`:** factor adicional sobre la credibilidad del `iss`
  (multiplicador acotado por edad), o un indicador derivado. **Pendiente de diseño fino.**

---

## 3. Federación de infraestructura (TEÓRICO — fuera de alcance por ahora)

> Esta sección es el **norte**, no trabajo planificado. Se documenta para no perder la idea y
> para que cualquier decisión de hoy no la cierre.

Las **apps** (clientes) ya están "en manos de cualquiera": son PWAs estáticas, MIT,
self-hosteables. La frontera real son los **servicios con estado**. El ideal: cada servicio es
**una instancia que corre una identidad y firma lo que entrega**; el cliente elige instancia
por **reputación + antigüedad** del operador; Dotrino corre la canónica sin privilegio →
*credible exit* (si la instancia de Dotrino falla/censura/desaparece, hay otras y el cliente
reenruta). El modelo vivo más cercano es **Nostr** (eventos firmados, relays de cualquiera, el
cliente elige relays) — y el proxy ya es, en esencia, un relay.

La factibilidad **depende del estado** de cada servicio:

| Servicio | Tipo de estado | Dificultad | Cómo |
|----------|----------------|------------|------|
| reputación, verificador, signer | atestaciones firmadas, portables | **fácil** | cualquiera lo corre; el cliente consulta varios y mergea sin confiar |
| proxy (transporte) | ruteo de mensajes | **medio** | federación server-to-server (email/XMPP/Matrix/Nostr) **o** multi-homing del cliente |
| geo (índice espacial) | base consultable "cerca de mí" | **difícil** | pins firmados repartidos → consultar varios y mergear, o réplica/gossip |

**Dos dimensiones de preferencia** (las mismas que la verificación): toda instancia firma, y
el cliente la ordena por `f(reputación = aggregateTrust(iss), antigüedad(iss))`.

**Descubrimiento:** un directorio federado de instancias — anuncios firmados *"corro el
servicio S en `wss://…`, identidad P, desde T"* — rankeado por rep+edad. (El directorio también
es federable.)

**Lo honesto:** el ruteo entre proxies y la réplica de geo son los problemas **de verdad** y
por eso quedan teóricos. Lo barato (firmar respuestas, directorio, métrica rep+edad) sería el
primer paso si algún día se aborda.

---

## 4. Plan

**Inmediato (construible):**
1. **Verificador de redes** (auto-verificable + firma): la app/Worker que baja la prueba
   pública y firma `op:'verify', ch:'x'|'github'|'web'`. Es lo que más gente podrá correr.
2. **Badges en `<dotrino-profile>`**: pintar `op:'verify'` validados, con peso por
   `aggregateTrust(iss)`; enlace de prueba si hay `reveal`.
3. **`op:'verify'` en `@dotrino/reputation`** (cliente + server): handler/canal, firma del
   verificador, consulta por sujeto.
4. **Bot verificador de Dotrino**: una instancia de la app (redes; correo cuando se sume el
   Worker + Resend).

**Futuro:**
- Antigüedad en `aggregateTrust` (génesis sellado por TSA).
- Verificación de **correo** (Worker + Resend, anti-reuso por `H(correo)`).

**Teórico (norte, sin planificar):**
- Federación de proxy, geo y demás servicios con estado (§3).

---

## Referencias de código

- Firma/atestación: `@dotrino/reputation/src/index.js` (publishRating ~L56), `server/signature.js`.
- Agregación/credibilidad: `@dotrino/reputation/src/index.js` `aggregateTrust` (~L149–231).
- Server (despacho por `op`): `dotrino-reputation/server/server.js` (`handlePut`), `server/schema.sql`.
- TSA: `dotrino-signer/server.js` (`handleSeal`).
- Perfil/badges: `dotrino-profile/src/index.js` (`createVaultProfileProvider`, render).
