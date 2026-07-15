export interface ReputationClientOptions {
  signData: (data: object) => Promise<string>
  getPublicKeyJwk: () => Promise<string>
  baseUrl?: string
  fetch?: typeof fetch
}

export interface Receipt {
  a: string
  b: string
  ts: number
  sigA: string
  sigB: string
}

export interface Attestation {
  subject: string
  issuer: string
  /** Mapa de indicadores { confianza, afinidad, ... }. */
  indicators: Record<string, number>
  /** Compat: = indicators.confianza si existe. */
  rating?: number
  notes?: string
  ts: number
  txBound: boolean
}

/** Mapa de indicadores: nombre (slug) → entero 0..5. `confianza` es el ancla anti-sybil. */
export type Indicators = Record<string, number>

export interface PublishRatingInput {
  subject: string
  /** Multiindicador: { confianza: 5, afinidad: 3, ... } */
  indicators?: Indicators
  /** Compat: equivale a indicators.confianza */
  rating?: number
  notes?: string
  receipt?: Receipt
  now?: number
}

export interface IndicatorScore {
  /** 0..1, o null si no hay fuentes confiables para este eje. */
  score: number | null
  confidence: number
  trustedCount: number
}

export interface AggregateConfig {
  /** Mi confianza en pk: 0..1, o null si no tengo opinión (1 para mí mismo). */
  trustOf: (pk: string) => Promise<number | null>
  fetchRatings?: (pk: string) => Promise<Attestation[]>
  myPubkey?: string
  maxDepth?: number
  decay?: number
  minCredibility?: number
}

export interface AggregateResult {
  /** Atajo = indicators.confianza.score (compat). */
  score: number | null
  confidence: number
  trustedCount: number
  rawCount: number
  txBoundCount: number
  /** Resultado POR INDICADOR (cada eje independiente, ponderado por confianza). */
  indicators: Record<string, IndicatorScore>
  samples: Array<{ issuer: string; indicators: Indicators; credibility: number; txBound: boolean; notes?: string }>
}

/** Una pregunta atada a un sujeto (firmada por su autor). */
export interface Question {
  questionId: string
  subject: string
  issuer: string
  text: string
  ts: number
  /** Conteo crudo de respuestas (señal débil; el orden real lo da rankQuestions). */
  answerCount: number
}

/** Una respuesta a una pregunta (firmada por su emisor). */
export interface Answer {
  issuer: string
  text: string
  ts: number
}

/** Pregunta con su peso anti-sybil (suma de credibilidad de quienes responden). */
export interface RankedQuestion {
  question: Question
  /** Suma de la credibilidad (anclada en tu red) de los respondedores. Clave de orden. */
  weight: number
  /** Nº de respondedores con credibilidad ≥ minCredibility (de tu red). */
  weightedAnswerers: number
  /** Nº de respondedores distintos (señal débil, incluye desconocidos). */
  rawAnswerCount: number
  /** Respuestas deduplicadas por emisor, ordenadas por credibilidad desc. */
  answers: Array<Answer & { credibility: number }>
}

export interface ReputationClient {
  publishRating (input: PublishRatingInput): Promise<{ ok: true; txBound: boolean }>
  removeRating (input: { subject: string; now?: number }): Promise<{ ok: true }>
  /** Retira MI atestación de UN canal (des-calificar un eje). */
  removeChannel (input: { subject: string; channel: string; now?: number }): Promise<{ ok: true }>
  getRatings (subject: string): Promise<{ attestations: Attestation[] }>
  aggregateTrust (subject: string, cfg: AggregateConfig): Promise<AggregateResult>
  /** Credibilidad de la opinión de `pk` para MÍ en [0,1] (peso anti-sybil standalone). */
  credibilityOf (pk: string, cfg: AggregateConfig): Promise<number>
  /** Publica MI pregunta sobre un sujeto (firmada). */
  postQuestion (input: { subject: string; text: string; now?: number }): Promise<{ ok: true; questionId: string }>
  /** Publica/reemplaza MI respuesta a una pregunta (una por perfil). */
  postAnswer (input: { questionId: string; text: string; now?: number }): Promise<{ ok: true }>
  /** Preguntas crudas sobre un sujeto (memoizada). */
  getQuestions (subject: string): Promise<{ questions: Question[] }>
  /** Respuestas crudas a una pregunta (memoizada). */
  getAnswers (questionId: string): Promise<{ answers: Answer[] }>
  /** Retira MI pregunta (tombstone firmado; sólo el autor). */
  removeQuestion (input: { questionId: string; subject?: string; now?: number }): Promise<{ ok: true }>
  /** Retira MI respuesta a una pregunta. */
  removeAnswer (input: { questionId: string; now?: number }): Promise<{ ok: true }>
  /** Ordena las preguntas de un sujeto por credibilidad sumada de sus respondedores (anti-sybil). */
  rankQuestions (subject: string, cfg: AggregateConfig): Promise<RankedQuestion[]>
  /** Atestación de UN canal independiente (tipo "atestación"): {op:'rate', subject, issuer, channel, value 0..5, ts}. */
  rate (input: { subject: string; channel: string; value: number; notes?: string; receipt?: Receipt; now?: number }): Promise<{ ok: true; channel: string; txBound: boolean }>
  /** Evento co-firmado de un indicador DERIVADO (elo, …): {data:{op:'event',indicator,scope,a,b,outcome,ts}, sigA, sigB}. */
  reportEvent (input: { data: any; sigA: string; sigB: string }): Promise<{ ok: true; applied: boolean; indicator: string; scope: string; a: DerivedEntry; b: DerivedEntry }>
  /** Valor derivado actual de un jugador (o null). */
  getDerived (player: string, indicator: string, scope?: string): Promise<DerivedEntry | null>
}

export interface DerivedEntry { value: number; count: number }
export interface EloEntry { elo: number; games: number }

export interface VaultReputation {
  client: ReputationClient
  /** Mi confianza directa en pk desde el web-of-trust local: 0..1, o null. */
  trustOf (pk: string): Promise<number | null>
  /** Califica a un peer: guarda confianza local + atesta el mapa firmado en el registro.
   *  `valueOrIndicators`: número (=confianza) o mapa { confianza, afinidad, ... }. */
  rate (subject: string, valueOrIndicators: number | Indicators, opts?: { notes?: string; receipt?: Receipt }): Promise<{ ok: true; txBound: boolean }>
  /** Reputación ponderada por MI web-of-trust (anti-sybil). Para el badge. */
  reputationOf (subject: string, opts?: Partial<AggregateConfig>): Promise<AggregateResult>
  getRatings (subject: string): Promise<{ attestations: Attestation[] }>
  removeRating (input: { subject: string; now?: number }): Promise<{ ok: true }>
  /** Califica un canal independiente (atestación), p.ej. 'fairplay'. */
  rateChannel (subject: string, channel: string, value: number, opts?: { notes?: string; receipt?: Receipt }): Promise<{ ok: true; channel: string; txBound: boolean }>
  /** Des-calificar un eje (retira mi atestación de ese canal). */
  removeChannel (subject: string, channel: string): Promise<{ ok: true }>
  /** Credibilidad de `pk` para MÍ en [0,1], pre-cableada con mi web-of-trust. */
  credibilityOf (pk: string, opts?: Partial<AggregateConfig>): Promise<number>
  /** Publica mi pregunta sobre un sujeto. */
  postQuestion (subject: string, text: string): Promise<{ ok: true; questionId: string }>
  /** Responde una pregunta (una respuesta por perfil). */
  answer (questionId: string, text: string): Promise<{ ok: true }>
  getQuestions (subject: string): Promise<{ questions: Question[] }>
  getAnswers (questionId: string): Promise<{ answers: Answer[] }>
  /** Preguntas del sujeto ordenadas por credibilidad sumada de respondedores (anti-sybil). */
  rankQuestions (subject: string, opts?: Partial<AggregateConfig>): Promise<RankedQuestion[]>
  removeQuestion (questionId: string, subject?: string): Promise<{ ok: true }>
  removeAnswer (questionId: string): Promise<{ ok: true }>
  /** ELO del jugador en un scope (default 'chess') → {elo, games} | null. */
  eloOf (player: string, scope?: string): Promise<EloEntry | null>
  /** Valor de cualquier indicador derivado. */
  derivedOf (player: string, indicator: string, scope?: string): Promise<DerivedEntry | null>
  /** Publica un evento de indicador derivado co-firmado. */
  reportResult (coSigned: { data: any; sigA: string; sigB: string }): Promise<{ ok: true; applied: boolean; indicator: string; scope: string; a: DerivedEntry; b: DerivedEntry }>
}

/** Instancia conectada de @dotrino/identity (duck-typed). */
export interface VaultIdentity {
  me?: { publickey?: string }
  signData (data: object): Promise<{ signature: string; publickey: string } | string>
  getRatingsForSubject (pk: string): Promise<{ mine?: { rating?: number } | null; endorsements?: unknown[] }>
  setRating? (pk: string, rating: number, notes?: string): Promise<unknown>
}

export function createReputationClient (opts: ReputationClientOptions): ReputationClient
export function createVaultReputation (identity: VaultIdentity, opts?: { baseUrl?: string; fetch?: typeof fetch }): VaultReputation
export function samePubkey (a: string, b: string): boolean
export function pubkeyId (jwkString: string): string
export function canonicalStringify (value: unknown): string

// ── Sujetos canónicos ──────────────────────────────────────────────
/** Tipos de sujeto único que se pueden calificar/preguntar. */
export type SubjectType = 'profile' | 'domain' | 'x' | 'github' | 'linkedin' | 'email'
export const SUBJECT_TYPES: SubjectType[]
/** Codifica un sujeto a su referencia canónica estable (async por el hash de email). */
export function subjectRef (type: SubjectType, value: string): Promise<string>
/** Descompone una referencia canónica para render (email es `opaque`: es un hash). */
export function parseSubjectRef (ref: string): { type: SubjectType | 'unknown'; value: string; opaque?: boolean }
/** Adivina el tipo de sujeto desde texto pegado por el usuario (o null). */
export function detectSubjectType (input: string): SubjectType | null
/** sha256 hex con WebCrypto. */
export function sha256hex (str: string): Promise<string>
/** ¿Parece un JWK P-256? (un perfil como sujeto es su JWK tal cual). */
export function isJwk (s: string): boolean
