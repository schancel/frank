import { CanonicalMessagingPendingError } from '@frank/wallet/chain'
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

it.each([
  new CanonicalMessagingPendingError(),
  Object.assign(new Error('publication pending'), {
    name: 'CanonicalMessagingPendingError',
  }),
  Object.assign(new Error('plugins pending'), {
    name: 'CanonicalMessageItemsNotInstalledError',
  }),
])(
  'prioritizes messaging readiness over transport inspection for %s',
  error => {
    const info = jest.fn(() => {
      throw new Error('must not inspect transport info')
    })
    Object.defineProperty(error, 'info', { get: info })
    Object.assign(error, { status: 429 })
    expect(decideOutgoingRetry(error, context({ sendAttempt: 2 }))).toEqual({
      kind: 'retry-messaging',
      readyTimeoutMs: 5_000,
      delayMs: 1_000,
    })
    expect(info).not.toHaveBeenCalled()
  },
)

it.each([
  { code: 'SERVER_ERROR' },
  { code: 'TIMEOUT' },
  { code: 'NETWORK_ERROR' },
  { code: 429 },
  { status: 429 },
  { statusCode: 429 },
  { name: 'OpenDirectoryError', code: 'unreachable' },
  new Error('relay answered 502'),
  new Error('relay answered 503'),
  new Error('relay answered 504'),
  new Error('invalid_rpc_upstream_response'),
  new Error('rpc_upstream_unavailable'),
  new Error('network response lost'),
  new Error('failed to fetch'),
  new Error('Failed to fetch'),
])(
  'retries an eligible transient rejection without asserting it had no effects: %s',
  error => {
    expect(decideOutgoingRetry(error, context())).toEqual({
      kind: 'retry-transport',
      delayMs: 500,
    })
    expect(decideOutgoingRetry(error, context({ sendAttempt: 2 }))).toEqual({
      kind: 'retry-transport',
      delayMs: 1_000,
    })
  },
)

it.each([new Error('unrecognized failure'), { status: 401 }, null])(
  'does not grant retry or queue authority to an unrelated rejection: %s',
  error => {
    expect(
      decideOutgoingRetry(error, context({ allCallsUnattempted: true })),
    ).toEqual({ kind: 'fail' })
  },
)

it('separates foreground retry eligibility from original-attempt and no-effect evidence', () => {
  const error = { status: 429 }
  expect(
    decideOutgoingRetry(error, context({ ownDigest: 'original-digest' })),
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
  // A digest's absence and a transient error alone are not permission to enter recovery as unused.
  expect(decideOutgoingRetry(error, context({ sendAttempt: 4 }))).toEqual({
    kind: 'fail',
  })
})

it('does not authorize stale work even when every call was explicitly unattempted', () => {
  const isCurrent = jest.fn(() => false)
  expect(
    decideOutgoingRetry(
      { status: 429 },
      context({ isCurrent, allCallsUnattempted: true }),
    ),
  ).toEqual({ kind: 'fail' })
  expect(isCurrent).toHaveBeenCalledTimes(2)
})

it('preserves separate short-circuit current checks for startup, transport and final queuing', () => {
  const isCurrent = jest
    .fn()
    .mockReturnValueOnce(false)
    .mockReturnValueOnce(false)
    .mockReturnValueOnce(true)
  const error = Object.assign(new CanonicalMessagingPendingError(), {
    status: 429,
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
  { ownDigest: 'already-recorded' },
  { sendAttempt: 3 },
  { isCurrent: () => false },
])(
  'retains transport-formatting exceptions when startup retry is ineligible: %s',
  overrides => {
    const failure = new Error('info getter failed')
    const error = Object.assign(new CanonicalMessagingPendingError(), {
      code: 429,
    })
    Object.defineProperty(error, 'info', {
      get: () => {
        throw failure
      },
    })
    expect(() => decideOutgoingRetry(error, context(overrides))).toThrow(
      failure,
    )
  },
)

it('does not bypass info serialization for a known transport status', () => {
  const info: { self?: unknown } = {}
  info.self = info
  expect(() => decideOutgoingRetry({ status: 429, info }, context())).toThrow(
    TypeError,
  )
})
