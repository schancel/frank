// @frank/crypto-box public surface. Browser-safe: no Node built-ins.
// Suites land later. This entry refuses the reserved proof-vector identifier.

/** Reserved for proof vectors. Never emitted as a produced suite. */
export const RESERVED_PROOF_SUITE_ID = 65535

/** Suite identifiers this package emits. Empty until a suite is implemented. */
export const producedSuiteIds: readonly number[] = []

export class ReservedSuiteError extends Error {
  readonly code = 'reserved-suite' as const
  readonly suiteId: number

  constructor(suiteId: number) {
    super('suite 65535 is reserved for proof vectors and is never produced')
    this.name = 'ReservedSuiteError'
    this.suiteId = suiteId
  }
}

export function isProducedSuite(suiteId: number): boolean {
  if (suiteId === RESERVED_PROOF_SUITE_ID) return false
  return producedSuiteIds.includes(suiteId)
}

/** Throws when a caller asks the library to emit the reserved proof suite. */
export function refuseReservedSuite(suiteId: number): void {
  if (suiteId === RESERVED_PROOF_SUITE_ID) {
    throw new ReservedSuiteError(suiteId)
  }
}
