/** Diagnostic facts only: never evidence that a payment was unattempted or may be replaced. */
export type WalletFailureDiagnosis = 'insufficient-funds' | 'admission-conflict'
export type WalletRetryVeto =
  | 'identity' | 'authorization' | 'provenance' | 'admission'
  | 'cancelled' | 'programmer-error' | 'nontransient-transport'
export interface WalletFailureFacts {
  readonly diagnosis?: WalletFailureDiagnosis
  readonly observationUnavailable?: true
  readonly transientTransport?: true
  readonly retryVeto?: WalletRetryVeto
}
export interface WalletFailureDescription {
  readonly kind: WalletFailureDiagnosis | 'unknown'
  readonly diagnoses: readonly WalletFailureDiagnosis[]
  readonly observationUnavailable: boolean
  readonly retry: 'transient' | 'forbidden' | 'unknown'
  readonly retryVetoes: readonly WalletRetryVeto[]
  readonly conflictingDiagnoses: boolean
  readonly error: unknown
  readonly cause: unknown
}
interface RecordedFailure {
  readonly diagnoses: readonly WalletFailureDiagnosis[]
  readonly vetoes: readonly WalletRetryVeto[]
  readonly observation: boolean
  readonly transient: boolean
  readonly diagnostic?: { readonly cause: unknown }
}
const failures = new WeakMap<object, RecordedFailure>()
const isObject = (value: unknown): value is object =>
  value !== null && (typeof value === 'object' || typeof value === 'function')

/** Authoritative adapters supply plain local facts. The rejection itself is never inspected
 * or changed, including frozen errors and proxies. Facts accumulate; retry vetoes cannot clear. */
export function recordWalletFailure<T>(
  error: T,
  facts: WalletFailureFacts,
  diagnostic?: { readonly cause: unknown },
): T {
  if (!isObject(error)) return error
  const previous = failures.get(error)
  const diagnoses = new Set(previous?.diagnoses)
  const vetoes = new Set(previous?.vetoes)
  if (facts.diagnosis) diagnoses.add(facts.diagnosis)
  if (facts.retryVeto) vetoes.add(facts.retryVeto)
  if (facts.diagnosis === 'admission-conflict') vetoes.add('admission')
  failures.set(error, Object.freeze({
    diagnoses: Object.freeze([...diagnoses].sort()),
    vetoes: Object.freeze([...vetoes].sort()),
    observation: previous?.observation === true || facts.observationUnavailable === true,
    transient: previous?.transient === true || facts.transientTransport === true,
    diagnostic: previous?.diagnostic ?? (diagnostic && Object.freeze({ cause: diagnostic.cause })),
  }))
  return error
}

/** Identity-only lookup. No property, prototype, message, code, cause or effect-label probing. */
export function describeWalletFailure(error: unknown): WalletFailureDescription {
  const facts = isObject(error) ? failures.get(error) : undefined
  const diagnoses = facts?.diagnoses ?? Object.freeze([])
  const retryVetoes = facts?.vetoes ?? Object.freeze([])
  return Object.freeze({
    kind: diagnoses.length === 1 ? diagnoses[0]! : 'unknown',
    diagnoses,
    observationUnavailable: facts?.observation ?? false,
    retry: diagnoses.length || retryVetoes.length
      ? 'forbidden' : facts?.transient ? 'transient' : 'unknown',
    retryVetoes,
    conflictingDiagnoses: diagnoses.length > 1,
    error,
    cause: facts?.diagnostic ? facts.diagnostic.cause : error,
  })
}
