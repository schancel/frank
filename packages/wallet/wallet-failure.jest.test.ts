import { ChainUnreachableError, ChainWaitCancelledError } from './evm-block-watcher'
import { describeWalletFailure, recordWalletFailure, type WalletFailureFacts, type WalletRetryVeto } from './wallet-failure'
import { EvmTransactionSetInsufficientFundsError } from './evm-transaction-set-types'
import { InsufficientStampFundsError } from './evm-account-pool'
import { EvmInputAdmissionError } from './evm-input-admission'

const vetoes: WalletRetryVeto[] = ['identity', 'authorization', 'provenance', 'admission',
  'cancelled', 'programmer-error', 'nontransient-transport']

it.each(vetoes)('observation and transport cannot remove %s in any order or repetition', retryVeto => {
  const facts: WalletFailureFacts[] = [{ observationUnavailable: true }, { transientTransport: true }, { retryVeto }]
  for (const order of [[0,1,2], [0,2,1], [1,0,2], [1,2,0], [2,0,1], [2,1,0]]) {
    const error = Object.freeze(new Error('original'))
    for (const i of [...order, ...order]) expect(recordWalletFailure(error, facts[i]!)).toBe(error)
    const result = describeWalletFailure(error)
    expect(result).toMatchObject({ kind: 'unknown', observationUnavailable: true,
      retry: 'forbidden', retryVetoes: [retryVeto], conflictingDiagnoses: false })
    expect(result.error).toBe(error)
    expect(result.cause).toBe(error)
  }
})

it('unknown annotations preserve specific diagnoses and conflicting diagnoses fail closed', () => {
  for (const diagnoses of [ ['insufficient-funds', 'admission-conflict'],
    ['admission-conflict', 'insufficient-funds'] ] as const) {
    const error = new Error()
    for (const diagnosis of [...diagnoses, ...diagnoses]) {
      recordWalletFailure(error, { diagnosis })
      recordWalletFailure(error, {})
    }
    expect(describeWalletFailure(error)).toMatchObject({ kind: 'unknown',
      diagnoses: ['admission-conflict', 'insufficient-funds'], retry: 'forbidden', conflictingDiagnoses: true })
  }
})

it('observation alone is not retry authority; transport can add only transient facts', () => {
  const error = new Error()
  recordWalletFailure(error, { observationUnavailable: true })
  expect(describeWalletFailure(error).retry).toBe('unknown')
  recordWalletFailure(error, { transientTransport: true })
  expect(describeWalletFailure(error).retry).toBe('transient')
  recordWalletFailure(error, { diagnosis: 'insufficient-funds' })
  expect(describeWalletFailure(error)).toMatchObject({ kind: 'insufficient-funds', retry: 'forbidden' })
})

it.each([undefined, new Error('first')])('retains the first explicit cause, including undefined', cause => {
  const error = new Error()
  recordWalletFailure(error, {})
  recordWalletFailure(error, {}, { cause })
  recordWalletFailure(error, { observationUnavailable: true })
  recordWalletFailure(error, {}, { cause: new Error('later') })
  expect(describeWalletFailure(error).cause).toBe(cause)
})

it('never probes an error, its prototype or inherited facts', () => {
  const trap = jest.fn(() => { throw new Error('must not probe') })
  const error = new Proxy({}, { get: trap, getPrototypeOf: trap })
  expect(describeWalletFailure(error).kind).toBe('unknown')
  recordWalletFailure(error, { observationUnavailable: true })
  expect(describeWalletFailure(error).observationUnavailable).toBe(true)
  expect(trap).not.toHaveBeenCalled()
  const original = recordWalletFailure(new Error(), { diagnosis: 'insufficient-funds' })
  for (const other of [Object.create(original), { kind: 'insufficient-funds' },
    new Error('insufficient funds'), { cause: original }, 'insufficient funds', null, undefined]) {
    expect(recordWalletFailure(other, {})).toBe(other)
    expect(describeWalletFailure(other).kind).toBe('unknown')
  }
})

it('keeps actual funding/admission classes and diagnostic originals', () => {
  const original = new EvmTransactionSetInsufficientFundsError()
  original.message = 'different diagnostic wording'
  const reported = new InsufficientStampFundsError('stamp', { cause: original })
  expect(describeWalletFailure(original).kind).toBe('insufficient-funds')
  expect(describeWalletFailure(reported).cause).toBe(original)
  expect(describeWalletFailure(new EvmInputAdmissionError('conflicting-authorization')).kind).toBe('admission-conflict')
  expect(describeWalletFailure(new EvmInputAdmissionError('invalid-provenance'))).toMatchObject({ kind: 'unknown', retry: 'forbidden' })
})

it('carries already classified diagnostics across the existing chain-read wrapper without effect labels', () => {
  const cause = recordWalletFailure(new Error('provider'), { transientTransport: true })
  const wrapped = new ChainUnreachableError(cause)
  expect(describeWalletFailure(wrapped)).toMatchObject({ observationUnavailable: true, retry: 'transient' })
  expect(describeWalletFailure(wrapped).cause).toBe(cause)
  recordWalletFailure(cause, { retryVeto: 'identity' })
  const refused = new ChainUnreachableError(cause)
  expect(describeWalletFailure(refused).retry).toBe('forbidden')
  expect(describeWalletFailure(refused).retryVetoes).toContain('identity')
  expect(describeWalletFailure(new ChainWaitCancelledError()).retryVetoes).toEqual(['cancelled'])
})
