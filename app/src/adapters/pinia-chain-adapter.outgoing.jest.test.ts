/**
 * Background reconciliation of outgoing messages whose payment is pending (#270): backoff, no new
 * payment, flips to sent on delivery. Plain `node` env, see `../stores/chats.jest.test.ts`.
 */
import { createPinia, setActivePinia } from 'pinia'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(global as any).document = { hasFocus: () => true }

import {
  MAX_OUTGOING_RECONCILE_INTERVAL_MS,
  OUTGOING_RECONCILE_INTERVAL_MS,
  startOutgoingReconciliation,
} from './pinia-chain-adapter'
import { useChatStore } from '../stores/chats'
import { activeChain } from '@frank/wallet/chain'
import type { WalletHandle } from '@frank/wallet/chain'
import { MonadStampPendingAttemptError } from '@frank/wallet/monad-stamp-client'

jest.mock('../utils/notifications', () => ({ desktopNotify: jest.fn() }))
jest.mock('./level-message-store', () => ({
  store: Promise.resolve({
    saveMessage: jest.fn(async () => undefined),
    deleteMessage: jest.fn(async () => undefined),
    mostRecentMessageTime: jest.fn(async () => 0),
    getIterator: async function* () {
      /* none */
    },
  }),
}))

const ME = '0x1a1A1A1A1a1A1A1a1A1a1a1a1a1a1a1A1A1a1a1a'
const PEER = '0x2b2B2B2b2B2b2B2b2B2b2b2b2B2B2b2b2B2b2B2B'
const HASH = 'ab'.repeat(32)
const wallet = {
  identity: { address: { raw: ME }, displayAddress: ME },
} as unknown as WalletHandle

describe('startOutgoingReconciliation (#270)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    jest.restoreAllMocks()
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => jest.useRealTimers())

  async function pendingMessage() {
    const send = jest
      .spyOn(activeChain.directMessages, 'send')
      .mockImplementation(async params => {
        await params.onAttemptCreated?.(HASH)
        throw new MonadStampPendingAttemptError([HASH])
      })
    const chats = useChatStore()
    await chats.sendMessage({
      wallet,
      address: PEER,
      items: [{ type: 'text', text: 'held two' }],
    })
    expect(chats.chats[PEER]?.messages[0].status).toBe('payment-pending')
    return { chats, send }
  }

  it('re-sends the same payment on a doubling backoff and flips to Sent when it delivers, without ever building another payment', async () => {
    const { chats, send } = await pendingMessage()
    const reconcile = jest
      .spyOn(activeChain.directMessages, 'reconcileAttempts')
      .mockResolvedValue({ [HASH]: 'live' })

    const polling = startOutgoingReconciliation({ wallet })
    await jest.advanceTimersByTimeAsync(0)
    expect(reconcile).toHaveBeenCalledTimes(1)

    // Still pending: pauses of 30 s, 60 s, then capped at 120 s.
    await jest.advanceTimersByTimeAsync(2 * OUTGOING_RECONCILE_INTERVAL_MS - 1)
    expect(reconcile).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(1)
    expect(reconcile).toHaveBeenCalledTimes(2)
    await jest.advanceTimersByTimeAsync(4 * OUTGOING_RECONCILE_INTERVAL_MS)
    expect(reconcile).toHaveBeenCalledTimes(3)
    await jest.advanceTimersByTimeAsync(MAX_OUTGOING_RECONCILE_INTERVAL_MS)
    expect(reconcile).toHaveBeenCalledTimes(4)
    expect(chats.chats[PEER]?.messages[0].status).toBe('payment-pending')

    // The receipt lands; the very same bytes are accepted.
    reconcile.mockResolvedValue({ [HASH]: 'delivered' })
    await jest.advanceTimersByTimeAsync(MAX_OUTGOING_RECONCILE_INTERVAL_MS)
    expect(chats.chats[PEER]?.messages).toEqual([
      expect.objectContaining({ payloadDigest: HASH, status: 'confirmed' }),
    ])
    expect(send).toHaveBeenCalledTimes(1)
    polling.stop()
  })

  it('stop() ends the loop', async () => {
    await pendingMessage()
    const reconcile = jest
      .spyOn(activeChain.directMessages, 'reconcileAttempts')
      .mockResolvedValue({ [HASH]: 'live' })
    const polling = startOutgoingReconciliation({ wallet })
    await jest.advanceTimersByTimeAsync(0)
    polling.stop()
    await jest.advanceTimersByTimeAsync(10 * MAX_OUTGOING_RECONCILE_INTERVAL_MS)
    expect(reconcile).toHaveBeenCalledTimes(1)
  })
})
