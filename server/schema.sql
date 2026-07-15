-- Esquema del registro de reputación `reputation.dotrino.com`.
--
-- A diferencia de geo/proxy (efímeros), este registro es PERSISTENTE: guarda
-- atestaciones públicas FIRMADAS. Cada fila es una opinión de `issuer` sobre
-- `subject`, autovalidada por su firma (el server no puede falsificarla). Una
-- atestación vigente por par (issuer, subject) — re-calificar pisa la anterior.
-- El server NO calcula score; sólo almacena y sirve las atestaciones crudas.

-- MULTIINDICADOR: cada atestación lleva un mapa `indicators` { confianza: 5,
-- afinidad: 3, ... }. `confianza` es el eje especial (ancla anti-sybil). Se
-- conserva la columna `rating` (= confianza) para compat con clientes 0.2.x.
CREATE TABLE IF NOT EXISTS ratings (
    issuer_id   TEXT NOT NULL,                 -- sha256(JWK del emisor)
    subject_id  TEXT NOT NULL,                 -- sha256(JWK del sujeto)
    issuer      TEXT NOT NULL,                 -- JWK string completo del emisor
    subject     TEXT NOT NULL,                 -- JWK string completo del sujeto
    rating      SMALLINT CHECK (rating BETWEEN 0 AND 5),  -- = indicators.confianza (compat)
    indicators  JSONB NOT NULL DEFAULT '{}'::jsonb,       -- mapa indicador→0..5
    notes       TEXT,
    ts          BIGINT NOT NULL,               -- epoch ms de la atestación
    receipt     JSONB,                         -- recibo co-firmado (opcional)
    tx_bound    BOOLEAN NOT NULL DEFAULT FALSE, -- recibo válido entre issuer y subject
    signature   TEXT NOT NULL,                 -- firma del emisor sobre la atestación
    updated_at  BIGINT NOT NULL,
    PRIMARY KEY (issuer_id, subject_id)
);

-- Migración aditiva para nodos existentes (persistentes): agregar `indicators`,
-- backfill desde `rating`, y volver `rating` nullable. Idempotente.
ALTER TABLE ratings ADD COLUMN IF NOT EXISTS indicators JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE ratings ALTER COLUMN rating DROP NOT NULL;
UPDATE ratings SET indicators = jsonb_build_object('confianza', rating)
  WHERE (indicators = '{}'::jsonb OR indicators IS NULL) AND rating IS NOT NULL;

-- La consulta caliente: todas las atestaciones sobre un sujeto.
CREATE INDEX IF NOT EXISTS idx_ratings_subject ON ratings (subject_id);
-- Para caminar el grafo (qué calificó un emisor).
CREATE INDEX IF NOT EXISTS idx_ratings_issuer ON ratings (issuer_id);

-- ── Atestaciones por CANAL independiente ──────────────────────────────────
-- Modelo de "registros independientes": cada indicador es su propio registro
-- firmado por (emisor, sujeto, canal). Cualquier app crea los canales que
-- necesite (confianza, afinidad, fairplay, puntualidad, …). Reemplaza el bundle
-- `ratings.indicators` (que se conserva como legacy y se fusiona en la lectura).
-- Cada fila va firmada sobre el canónico {op:'rate', subject, issuer, channel, value, ts}.
CREATE TABLE IF NOT EXISTS attestations (
    issuer_id  TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    channel    TEXT NOT NULL,                 -- slug del indicador
    issuer     TEXT NOT NULL,
    subject    TEXT NOT NULL,
    value      SMALLINT NOT NULL CHECK (value BETWEEN 0 AND 5),
    notes      TEXT,
    ts         BIGINT NOT NULL,
    receipt    JSONB,
    tx_bound   BOOLEAN NOT NULL DEFAULT FALSE,
    signature  TEXT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (issuer_id, subject_id, channel)   -- una atestación vigente por (emisor, sujeto, canal)
);
CREATE INDEX IF NOT EXISTS idx_attestations_subject ON attestations (subject_id);
CREATE INDEX IF NOT EXISTS idx_attestations_issuer ON attestations (issuer_id);

-- ── Indicadores DERIVADOS (tipo nuevo) ─────────────────────────────────────
-- Segundo TIPO de indicador (junto a las atestaciones subjetivas): valores
-- CALCULADOS a partir de eventos entre dos partes CO-FIRMADOS por ambas
-- (anti-trampa: nadie se auto-reporta). Genérico: el ELO es el primero, pero
-- caben otros (rachas, glicko, "honor", …) — cada indicador tiene su computador.
-- Cada indicador se namespacea por `scope` (p.ej. el gameId: 'chess').

-- Eventos append-only, firmados por AMBAS partes sobre el canónico
-- {op:'event', indicator, scope, a, b, outcome, ts}. event_id deduplica.
CREATE TABLE IF NOT EXISTS events (
    event_id   TEXT PRIMARY KEY,              -- sha256(indicator|scope|a|b|ts)
    indicator  TEXT NOT NULL,                 -- 'elo', …
    scope      TEXT NOT NULL,                 -- sub-namespace (p.ej. gameId)
    a          TEXT NOT NULL,                 -- JWK string parte A
    b          TEXT NOT NULL,                 -- JWK string parte B
    outcome    TEXT NOT NULL,                 -- 'a' | 'b' | 'draw' (resultado 2-partes)
    ts         BIGINT NOT NULL,
    sig_a      TEXT NOT NULL,
    sig_b      TEXT NOT NULL,
    created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ind_scope ON events (indicator, scope);

-- Valor derivado por (jugador, indicador, scope). Se actualiza incrementalmente
-- al llegar cada evento (cada indicador define su valor base y su fórmula).
CREATE TABLE IF NOT EXISTS derived (
    player_id  TEXT NOT NULL,                 -- sha256(JWK del jugador)
    indicator  TEXT NOT NULL,
    scope      TEXT NOT NULL,
    player     TEXT NOT NULL,                 -- JWK string completo
    value      INTEGER NOT NULL,
    count      INTEGER NOT NULL DEFAULT 0,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (player_id, indicator, scope)
);
CREATE INDEX IF NOT EXISTS idx_derived_rank ON derived (indicator, scope, value DESC);

-- ── PREGUNTAS y RESPUESTAS sobre un sujeto ──────────────────────────────────
-- Registros públicos FIRMADOS, como las atestaciones: el server sólo almacena y
-- sirve crudo. Una pregunta la crea un autor sobre un sujeto (perfil/dominio/
-- handle); cualquier perfil la responde (una respuesta vigente por perfil). El
-- ORDEN de relevancia NO lo calcula el server: el cliente ordena por la
-- credibilidad sumada de quienes responden (anti-sybil, anclado en tu red).
-- `question_id` es content-addressed: sha256(canónico {op:'question',subject,issuer,text,ts}).
CREATE TABLE IF NOT EXISTS questions (
    question_id TEXT PRIMARY KEY,
    subject_id  TEXT NOT NULL,                -- pubkeyId(subjectRef)
    subject     TEXT NOT NULL,                -- subjectRef canónico
    issuer_id   TEXT NOT NULL,                -- sha256(JWK del autor)
    issuer      TEXT NOT NULL,                -- JWK string del autor
    text        TEXT NOT NULL,                -- <= 280
    ts          BIGINT NOT NULL,
    signature   TEXT NOT NULL,                -- firma del autor sobre la pregunta
    updated_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_questions_subject ON questions (subject_id);

-- Una respuesta VIGENTE por (pregunta, emisor): re-responder pisa la anterior.
CREATE TABLE IF NOT EXISTS answers (
    question_id TEXT NOT NULL,
    issuer_id   TEXT NOT NULL,                -- sha256(JWK del que responde)
    issuer      TEXT NOT NULL,                -- JWK string
    text        TEXT NOT NULL,                -- <= 280
    ts          BIGINT NOT NULL,
    signature   TEXT NOT NULL,                -- firma del emisor sobre la respuesta
    updated_at  BIGINT NOT NULL,
    PRIMARY KEY (question_id, issuer_id)
);
CREATE INDEX IF NOT EXISTS idx_answers_question ON answers (question_id);
