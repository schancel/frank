import {
  CanonicalMessagingPendingError,
  CanonicalMessageItemsNotInstalledError,
} from '@frank/wallet/chain'
import { recordWalletFailure } from '@frank/wallet/wallet-failure'
import { recordEvmRpcFailure } from '@frank/wallet/evm-rpc-failure'
import { OpenDirectoryError } from '@frank/cashweb/relay/open-directory'
import {
  MonadMailboxRetryableError,
  MonadMailboxAuthError,
} from '@frank/cashweb/relay/mailbox-client'
import { decideOutgoingRetry } from './outgoing-retry-policy'

const context = (
  overrides: Partial<Parameters<typeof decideOutgoingRetry>[1]> = {},
): Parameters<typeof decideOutgoingRetry>[1] => ({
  ownDigest: undefined,
  sendAttempt: 1,
  maxSendAttempts: 3,
  allCallsUnattempted: false,
  isCurrent: () => true,
  ...overrides,
})
const transient = () =>
  recordEvmRpcFailure(
    Object.assign(new Error('wording is irrelevant'), { status: 429 }),
  )

it.each([
  new CanonicalMessagingPendingError(),
  new CanonicalMessageItemsNotInstalledError(),
])(
  'retries actual messaging setup classes without inspecting arbitrary details',
  error => {
    const info = jest.fn(() => {
      throw new Error('not readable')
    })
    Object.defineProperty(error, 'info', { get: info })
    expect(decideOutgoingRetry(error, context({ sendAttempt: 2 }))).toEqual({
      kind: 'retry-messaging',
      readyTimeoutMs: 5000,
      delayMs: 1000,
    })
    expect(info).not.toHaveBeenCalled()
  },
)

it.each([transient(), new OpenDirectoryError('unreachable')])(
  'retries normalized transport or actual directory unavailability with unchanged timing',
  error => {
    expect(decideOutgoingRetry(error, context())).toEqual({
      kind: 'retry-transport',
      delayMs: 500,
    })
    expect(decideOutgoingRetry(error, context({ sendAttempt: 2 }))).toEqual({
      kind: 'retry-transport',
      delayMs: 1000,
    })
  },
)

it.each([
  { code: 'SERVER_ERROR' },
  { code: 'TIMEOUT' },
  { code: 'NETWORK_ERROR' },
  { status: 429 },
  { name: 'OpenDirectoryError', code: 'unreachable' },
  Object.assign(new Error('pending'), {
    name: 'CanonicalMessagingPendingError',
  }),
  Object.assign(new Error('pending'), {
    name: 'CanonicalMessageItemsNotInstalledError',
  }),
  new Error('network failed to fetch 429 502 503 504 SERVER_ERROR TIMEOUT'),
  new MonadMailboxRetryableError('no normalized wallet transport fact'),
  new MonadMailboxAuthError('unauthorized', 'request'),
  new OpenDirectoryError('not-published'),
  null,
])(
  'never grants retry from unknown shapes, wording or unrelated producer classes: %s',
  error => {
    expect(
      decideOutgoingRetry(error, context({ allCallsUnattempted: true })),
    ).toEqual({ kind: 'fail' })
  },
)

it('preserves attempt bounds, original digest and no-effect evidence checks', () => {
  const error = transient()
  expect(
    decideOutgoingRetry(error, context({ ownDigest: 'original' })),
  ).toEqual({ kind: 'fail' })
  expect(decideOutgoingRetry(error, context({ sendAttempt: 3 }))).toEqual({
    kind: 'fail',
  })
  expect(
    decideOutgoingRetry(
      error,
      context({ sendAttempt: 3, allCallsUnattempted: true }),
    ),
  ).toEqual({ kind: 'queue-unattempted' })
  expect(decideOutgoingRetry(error, context({ sendAttempt: 4 }))).toEqual({
    kind: 'fail',
  })
})

it('retains separate stale checks', () => {
  const isCurrent = jest.fn(() => false)
  expect(
    decideOutgoingRetry(
      transient(),
      context({ isCurrent, allCallsUnattempted: true }),
    ),
  ).toEqual({ kind: 'fail' })
  expect(isCurrent).toHaveBeenCalledTimes(2)
})

it('preserves startup, transport, queue evaluation order', () => {
  const isCurrent = jest
    .fn()
    .mockReturnValueOnce(false)
    .mockReturnValueOnce(false)
    .mockReturnValueOnce(true)
  const error = recordWalletFailure(new CanonicalMessagingPendingError(), {
    transientTransport: true,
  })
  expect(
    decideOutgoingRetry(
      error,
      context({ isCurrent, allCallsUnattempted: true }),
    ),
  ).toEqual({ kind: 'queue-unattempted' })
  expect(isCurrent).toHaveBeenCalledTimes(3)
})

it.each([
  'identity',
  'authorization',
  'provenance',
  'admission',
  'cancelled',
  'programmer-error',
  'nontransient-transport',
] as const)(
  'wallet veto %s defeats observation, transient and actual messaging fallback',
  retryVeto => {
    for (const error of [
      transient(),
      new OpenDirectoryError('unreachable'),
      new CanonicalMessagingPendingError(),
    ]) {
      recordWalletFailure(error, {
        retryVeto,
        observationUnavailable: true,
        transientTransport: true,
      })
      expect(
        decideOutgoingRetry(error, context({ allCallsUnattempted: true })),
      ).toEqual({ kind: 'fail' })
    }
  },
)

it.each(['insufficient-funds', 'admission-conflict'] as const)(
  'a wallet diagnosis %s cannot become a transport retry',
  diagnosis => {
    expect(
      decideOutgoingRetry(
        recordWalletFailure(transient(), { diagnosis }),
        context({ allCallsUnattempted: true }),
      ),
    ).toEqual({ kind: 'fail' })
  },
)

it('does not inspect unknown getters, strings, info cycles, causes or proxy prototypes unsafely', () => {
  const trap = jest.fn(() => {
    throw new Error('hostile')
  })
  const error = {
    get info() {
      return trap()
    },
    get status() {
      return trap()
    },
    toString: trap,
  }
  const cycle: { info?: unknown } = {}
  cycle.info = cycle
  for (const value of [
    error,
    cycle,
    new Proxy({}, { getPrototypeOf: trap }),
    { cause: transient() },
  ]) {
    expect(decideOutgoingRetry(value, context())).toEqual({ kind: 'fail' })
  }
  expect(trap).toHaveBeenCalledTimes(1) // Only guarded owning-class recognition touches the Proxy.
})
