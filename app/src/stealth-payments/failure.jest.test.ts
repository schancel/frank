import { makeError } from 'ethers'
import { recordEvmRpcFailure } from '@frank/wallet/evm-rpc-failure'
import { recordWalletFailure } from '@frank/wallet/wallet-failure'
import { StealthPaymentMemberLimitError } from '@frank/wallet/stealth-payment'
import { ContactPaymentBelowFloorError } from '@frank/wallet/chain/chain-wallet'
import enUS from '../i18n/en-us'
import {
  notSentFailureKey,
  notSentFailureMessage,
  sendFailureKey,
  StealthPaymentNotSentError,
} from './failure'

/** The English text of `key`, with `{name}` parameters filled in. */
function english(key: string, params: Record<string, unknown> = {}): string {
  const value = key
    .split('.')
    .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], enUS)
  if (typeof value !== 'string') return key
  return Object.entries(params).reduce(
    (text, [name, v]) => text.replaceAll(`{${name}}`, String(v)),
    value,
  )
}

/** What ethers throws for the relay's `rpc_upstream_rate_limited` (the owner's report). */
function throttled() {
  return recordEvmRpcFailure(
    makeError('server response 429 ', 'SERVER_ERROR', {
      request: {} as never,
      response: { statusCode: 429 } as never,
      info: {
        requestUrl: 'https://relay.example/chain-rpc/monad-testnet/rpc',
        responseBody: '{"error":"rpc_upstream_rate_limited"}',
        responseStatus: '429 ',
      },
    }),
  )
}

describe('stealth payment failure messages', () => {
  it('says the network is busy for a throttled read, never the provider dump', () => {
    expect(notSentFailureKey(throttled())).toBe('sendStealthDialog.networkBusy')
  })

  it('names insufficient funds only where the wallet diagnosed it', () => {
    expect(
      notSentFailureKey(
        recordWalletFailure(
          new RangeError('Insufficient unreserved payment funds'),
          { diagnosis: 'insufficient-funds' },
        ),
      ),
    ).toBe('sendStealthDialog.insufficientFunds')
  })

  it('tells the user what to do when the payment needs too many coins', () => {
    expect(notSentFailureKey(new StealthPaymentMemberLimitError(16))).toBe(
      'sendStealthDialog.tooManyCoins',
    )
    expect(
      sendFailureKey(
        new StealthPaymentNotSentError(new StealthPaymentMemberLimitError(16)),
      ),
    ).toBe('sendStealthDialog.tooManyCoins')
  })

  it('names the minimum when the payment is below the payment floor, as Send to Contact does', () => {
    const floor = 21_000_000_000_000_000n // 0.021 MON
    const refused = new ContactPaymentBelowFloorError(10n ** 16n, floor)
    const mon = () => ({ nativeUnit: 'MON', nativeDecimals: 18 })
    const expected = english('sendContactDialog.belowMinimum', {
      amount: '0.021 MON',
    })
    expect(notSentFailureMessage(refused, mon, english)).toBe(expected)
    expect(expected).toContain('0.021 MON')
    // Refused at review or released before messaging adopted it: either way the same message.
    expect(
      notSentFailureMessage(new StealthPaymentNotSentError(refused), mon, english),
    ).toBe(expected)
    // Without the asset to name the minimum in, the generic message; never a raw `{amount}`.
    expect(notSentFailureMessage(refused, () => undefined, english)).toBe(
      english('sendStealthDialog.notSent'),
    )
    // Any other failure keeps its own message.
    expect(notSentFailureMessage(new Error('quote mismatch'), mon, english)).toBe(
      english('sendStealthDialog.notSent'),
    )
  })

  it('gives anything else the generic message, even a RangeError', () => {
    expect(notSentFailureKey(new RangeError('Invalid BigInt'))).toBe(
      'sendStealthDialog.notSent',
    )
    expect(notSentFailureKey(new Error('quote mismatch'))).toBe(
      'sendStealthDialog.notSent',
    )
  })

  it('says nothing was sent only for a payment its owner released unexposed', () => {
    expect(sendFailureKey(new StealthPaymentNotSentError(throttled()))).toBe(
      'sendStealthDialog.networkBusy',
    )
    expect(
      sendFailureKey(new StealthPaymentNotSentError(new Error('signing'))),
    ).toBe('sendStealthDialog.notSent')
    // After adoption (or an unproven release) a signed transaction may have been exposed; a 429
    // or a timeout then is no proof it did not land.
    expect(sendFailureKey(throttled())).toBe('sendStealthDialog.messageEnded')
    expect(sendFailureKey(new Error('relay timeout'))).toBe(
      'sendStealthDialog.messageEnded',
    )
  })
})
