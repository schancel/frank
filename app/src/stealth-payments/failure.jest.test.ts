import { makeError } from 'ethers'
import { recordEvmRpcFailure } from '@frank/wallet/evm-rpc-failure'
import { recordWalletFailure } from '@frank/wallet/wallet-failure'
import { StealthPaymentMemberLimitError } from '@frank/wallet/stealth-payment'
import {
  notSentFailureKey,
  sendFailureKey,
  StealthPaymentNotSentError,
} from './failure'

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
