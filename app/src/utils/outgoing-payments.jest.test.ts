import { activeChain, type WalletHandle } from '@frank/wallet/chain'
import {
  PAYMENT_SUMMARY_WINDOW_MS,
  outgoingPaymentSummaries,
  refreshOutgoingPaymentSummaries,
} from './outgoing-payments'

const wallet = {} as WalletHandle
const NOW = 10 * PAYMENT_SUMMARY_WINDOW_MS
const sent = (digest: string, over: Record<string, unknown> = {}) => ({
  outbound: true,
  status: 'confirmed',
  payloadDigest: digest,
  serverTime: NOW - 1000,
  stampValueWei: 1n,
  ...over,
})

describe('what the bubbles show of sent payments', () => {
  let says: Record<string, string | undefined>
  let asked: string[]
  beforeEach(() => {
    outgoingPaymentSummaries.clear()
    says = {}
    asked = []
    jest
      .spyOn(activeChain.directMessages, 'paymentSummaryOf')
      .mockImplementation(({ payloadDigest }) => {
        asked.push(payloadDigest)
        return says[payloadDigest] as never
      })
  })
  afterEach(() => jest.restoreAllMocks())

  it('reads the wallet for each paid message sent in the last hour, counts the ones not final, and stops asking about a final one', () => {
    says = { aa: 'mempool', bb: 'paid', cc: 'reverted' }
    const messages = [
      sent('aa'),
      sent('bb'),
      sent('cc'),
      // Free, received, older than the window, still under its local key: never asked about.
      sent('dd', { stampValueWei: 0n }),
      sent('ee', { outbound: false }),
      sent('ff', { serverTime: NOW - PAYMENT_SUMMARY_WINDOW_MS - 1 }),
      sent('pending:1:1:x'),
    ]
    expect(refreshOutgoingPaymentSummaries(wallet, messages, NOW)).toBe(2)
    expect(asked).toEqual(['aa', 'bb', 'cc'])
    expect(Object.fromEntries(outgoingPaymentSummaries)).toEqual({
      aa: 'mempool',
      bb: 'paid',
      cc: 'reverted',
    })
    // The chain moves on: the open ones are read again, the final one is not.
    says = { aa: 'paid', bb: 'paid', cc: 'repaid' }
    asked = []
    expect(refreshOutgoingPaymentSummaries(wallet, messages, NOW)).toBe(0)
    expect(asked).toEqual(['aa', 'cc'])
    expect(outgoingPaymentSummaries.get('cc')).toBe('repaid')
  })

  it('a message already tracked and not final is still read after the hour; the attempt digest names it while it is under its local key', () => {
    says = { aa: 'pending' }
    const message = sent('pending:9:9:y', { delivery: { attemptDigest: 'aa' } })
    expect(refreshOutgoingPaymentSummaries(wallet, [message], NOW)).toBe(1)
    says = { aa: 'paid' }
    expect(
      refreshOutgoingPaymentSummaries(
        wallet,
        [message],
        NOW + 2 * PAYMENT_SUMMARY_WINDOW_MS,
      ),
    ).toBe(0)
    expect(outgoingPaymentSummaries.get('aa')).toBe('paid')
  })

  it('a wallet that cannot answer changes nothing and is not counted', () => {
    jest
      .spyOn(activeChain.directMessages, 'paymentSummaryOf')
      .mockImplementation(() => {
        throw new Error('wallet closed')
      })
    expect(refreshOutgoingPaymentSummaries(wallet, [sent('aa')], NOW)).toBe(0)
    expect(outgoingPaymentSummaries.size).toBe(0)
  })
})
