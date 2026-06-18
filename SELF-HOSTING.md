# Correr tu propio nodo de reputación

`reputation.dotrino.com` no tiene por qué ser el único. Cualquiera puede levantar
un registro de reputación: guarda **atestaciones firmadas** públicas. Como cada
fila va firmada por su emisor, el nodo no puede falsificarla — es infraestructura
*trust-minimized*. El significado (anti-sybil) se computa en el cliente.

## 1. Requisitos

- Docker + Docker Compose.
- Un dominio (`reputation.tudominio.com`) apuntando **A/AAAA a este host**, con
  **80/443 abiertos** (Caddy saca el cert). DNS directo, **sin la nube naranja de
  Cloudflare** (no debe ver el grafo de confianza).

## 2. Levantarlo (turnkey)

```bash
git clone https://github.com/imdotrino/dotrino-reputation
cd dotrino-reputation
cp .env.docker.example .env
# editá .env: REP_DOMAIN y REP_DB_PASSWORD (openssl rand -hex 24)
docker compose up -d
```

Levanta **Postgres** + el **servidor de reputación** + **Caddy** (TLS). En un
minuto tenés `https://reputation.tudominio.com/health` → `{"ok":true}`.

### Probar sin dominio/TLS

En `docker-compose.yml` comentá `caddy` y descomentá `ports: ["8091:8091"]` del
servicio `reputation`. Después `docker compose up -d db reputation`.

## 3. Usar tu nodo desde una app

```js
import { createReputationClient } from '@dotrino/reputation'
const rep = createReputationClient({ signData, getPublicKeyJwk, baseUrl: 'https://reputation.tudominio.com' })
```

## 4. Operación

- **PERSISTENTE**: a diferencia de geo/proxy (efímeros), las atestaciones son el
  activo. **Hacé backups del volumen `reputation-db`** (`pg_dump`).
- **Actualizar**: `git pull && docker compose up -d --build`. El esquema se aplica
  solo (migraciones aditivas idempotentes).
- **Logs**: `docker compose logs -f reputation`.

## 5. Multi-nodo (futuro)

Como las atestaciones son datos firmados públicos, varios registros pueden
**replicarse/espejarse** y el cliente **unir** resultados de varios sin confiar en
ninguno (las firmas verifican). Esa federación de lectura aún no está
implementada server-side; por ahora cada nodo es independiente y el cliente apunta
a uno (o, a futuro, a varios vía el directorio de nodos).
