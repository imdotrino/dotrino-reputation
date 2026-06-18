# Deploy — reputation.dotrino.com

Servicio Node + Postgres **persistente**. Independiente de geo (base, puerto,
unit y vhost propios), aunque hoy corre en el mismo VPS — pensado para poder
moverse a otro server sin tocar geo.

## 1. Postgres (base propia)

```sql
CREATE ROLE reputation LOGIN PASSWORD '<fuerte>';
CREATE DATABASE reputation OWNER reputation;
```

No requiere PostGIS (a diferencia de geo). El esquema (`schema.sql`) se aplica
solo al arrancar.

## 2. Servicio

```bash
cd server
cp .env.example .env     # DATABASE_URL a la base 'reputation', PORT=8091
npm install
npm start                # node server.js → :8091
```

## 3. systemd (independiente de geo)

`/etc/systemd/system/dotrino-reputation.service` con `User=seyacat`,
`EnvironmentFile=.../server/.env`, `ExecStart=<node> server.js`, `Restart=always`.

## 4. nginx + TLS

Vhost `reputation.dotrino.com` → `127.0.0.1:8091`, cert Let's Encrypt por
certbot. Requiere que `reputation.dotrino.com` apunte (A/AAAA) al VPS,
**grey-cloud (DNS only)** en Cloudflare — un registro de reputación no debe pasar
por un tercero.

## Operación

- **Backups: SÍ** (a diferencia de geo). Este registro es durable; las
  atestaciones son el activo. Respaldar la base `reputation`.
- **Sin purga**: las atestaciones persisten hasta que el emisor las retira.
- **Escala**: la query caliente es por `subject_id` (índice). Si crece el grafo,
  considerar réplicas de lectura.

## Variables

| Var | Default | Descripción |
|-----|---------|-------------|
| `PORT` | `8091` | puerto HTTP (geo usa 8090) |
| `DATABASE_URL` | — | base `reputation` propia |
| `REP_CLOCK_SKEW_MS` | `300000` | anti-replay del sobre (5 min) |
| `REP_RL_READ_PER_MIN` | `600` | rate limit lectura por IP |
| `REP_RL_WRITE_PER_MIN` | `120` | rate limit escritura por IP |
