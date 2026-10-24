import {
  CanonicalRecipientNotPublishedError,
  DirectMessageStampBelowFeeError,
} from '@frank/wallet/chain'
import { SolanaStealthSendRefusedError } from '@frank/wallet/solana-stealth'
import { EvmTransactionSetInsufficientFundsError } from '@frank/wallet/evm-transaction-set-types'
import { ChainUnreachableError } from '@frank/wallet/evm-block-watcher'
import { InsufficientStampFundsError } from '@frank/wallet/evm-account-pool'
import { EvmInputAdmissionError } from '@frank/wallet/evm-input-admission'
import { recordWalletFailure } from '@frank/wallet/wallet-failure'
import {
  MonadStampAbandonedError,
  MonadStampRecoveredAttemptError,
  MonadStampRejectedError,
  MonadStampTerminalError,
  StampBlockedError,
} from '@frank/wallet/evm-stamp-client'
import {
  MonadMailboxRetryableError,
  MonadMailboxUnavailableError,
  MonadMailboxAuthError,
} from '@frank/cashweb/relay/mailbox-client'
import { OpenDirectoryError } from '@frank/cashweb/relay/open-directory'
import {
  classifySendFailure,
  isInsufficientFundsError,
  isNoResponseError,
} from './chats-self-notes'

const own = 'ab'.repeat(32)
const other = 'cd'.repeat(32)
const examples = [
  [new MonadStampRecoveredAttemptError([other]), 'recovered'],
  [new StampBlockedError(other, 'insufficient_total'), 'blocked'],
  [new MonadStampAbandonedError('abandoned', other), 'unverified'],
  [new MonadStampRejectedError('rejected', 422, undefined), 'rejected'],
  [
    new MonadStampTerminalError(
      'terminal',
      422,
      'mailbox_terminal',
      true,
      undefined,
    ),
    'rejected',
  ],
  [new MonadMailboxUnavailableError('unavailable', 404), 'unavailable'],
  [
    new CanonicalRecipientNotPublishedError('recipient'),
    'recipient-unregistered',
  ],
  [new OpenDirectoryError('not-published'), 'recipient-unregistered'],
  [new InsufficientStampFundsError('changed wording'), 'insufficient-funds'],
  [new EvmTransactionSetInsufficientFundsError(), 'insufficient-funds'],
  [new ChainUnreachableError(new Error('observation failed')), 'unreachable'],
  [new SolanaStealthSendRefusedError(), 'error'],
  [new DirectMessageStampBelowFeeError(1n, 2n), 'stamp-below-fee'],
  [
    new OpenDirectoryError('unreachable', undefined, undefined, 'transient'),
    'unreachable',
  ],
  [new MonadMailboxRetryableError('unavailable'), 'unreachable'],
  [
    recordWalletFailure(new Error('changed observation wording'), {
      observationUnavailable: true,
    }),
    'unreachable',
  ],
  [new Error('unknown'), 'error'],
] as const

it.each(examples)(
  'retains the original digest for actual producer %s',
  (error, reason) => {
    expect(classifySendFailure(error, own)).toEqual({ reason, keepDigest: own })
    expect(classifySendFailure(error, undefined)).toEqual({
      reason,
      ...(error instanceof MonadStampAbandonedError
        ? { keepDigest: other }
        : {}),
    })
  },
)

it.each(examples)(
  'does not grant same-name/text lookalikes producer authority: %s',
  error => {
    const fake = Object.assign(new Error(error.message), { name: error.name })
    expect(classifySendFailure(fake, own)).toEqual({
      reason: 'error',
      keepDigest: own,
    })
  },
)

it.each([
  { kind: 'insufficient-funds' },
  { name: 'OpenDirectoryError', code: 'unreachable' },
  { isAxiosError: true },
  new Error('insufficient funds'),
  new MonadMailboxAuthError('401', 'request'),
  new EvmInputAdmissionError('conflicting-authorization'),
])('never invents funding or missing-response diagnoses: %s', error => {
  expect(isInsufficientFundsError(error)).toBe(false)
  expect(isNoResponseError(error)).toBe(false)
  expect(classifySendFailure(error, own)).toEqual({
    reason: 'error',
    keepDigest: own,
  })
})

it('contains hostile getters/prototype traps and retains original digest', () => {
  const trap = jest.fn(() => {
    throw new Error('hostile')
  })
  for (const error of [
    {
      get name() {
        return trap()
      },
      get kind() {
        return trap()
      },
      toString: trap,
    },
    new Proxy({}, { getPrototypeOf: trap }),
  ]) {
    expect(classifySendFailure(error, own)).toEqual({
      reason: 'error',
      keepDigest: own,
    })
    expect(isInsufficientFundsError(error)).toBe(false)
    expect(isNoResponseError(error)).toBe(false)
  }
})
