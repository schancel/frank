/* eslint-disable @typescript-eslint/no-var-requires */
jest.mock('../utils/outgoing-application-authorization', () => ({
  captureOutgoingApplicationAuthorization: jest.fn(async () => undefined),
}))
import { captureOutgoingFinancialOperations } from '../stealth-payments/outgoing'
jest.mock('../stealth-payments/outgoing', () => ({
  captureOutgoingFinancialOperations: jest.fn(),
}))
/**
 * Outgoing direct-message delivery states (tickets #269, #270): a failed or payment-pending send
 * stays in the conversation, survives a reload, can be retried by hand, and never pays twice.
 *
 * `activeChain.directMessages` is mocked at its own boundary (no chain, relay or funds). The local
 * message store is an in-memory fake that behaves like the durable Level store, so "reload" here
 * means: a fresh Pinia and `rehydateChat` over what was actually written.
 *
 * Plain `node` environment; see `chats.jest.test.ts`'s header for why.
 */
import { createPinia, setActivePinia } from 'pinia'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(global as any).document = { hasFocus: () => true }

import { outgoingMessageId, rehydateChat, useChatStore } from './chats'
import { activeChain } from '@frank/wallet/chain'
import { DirectMessageAlreadyAttemptedError } from '@frank/wallet/chain'
import { directMessageNotAttempted } from '@frank/wallet/chain/active-chain'
import type {
  DirectMessageAttemptStatus,
  DirectMessageSendResult,
  WalletHandle,
} from '@frank/wallet/chain'
import {
  MonadStampAbandonedError,
  MonadStampPendingAttemptError,
  MonadStampRecoveredAttemptError,
  MonadStampTerminalError,
} from '@frank/wallet/evm-stamp-client'
import { MonadRpcError } from '@frank/wallet/evm-http'
import { MonadMailboxUnavailableError } from '@frank/cashweb/relay/mailbox-client'
import type { MessageWrapper } from '@frank/cashweb/types/messages'
import {
  deserializeMessageWrapper,
  serializeMessageWrapper,
} from '@frank/cashweb/relay/storage/level-storage'
import { store as messageStorePromise } from '../adapters/level-message-store'
import {
  resumeHandMessages,
  undeliveredHandMessages,
  type HandResumeStore,
} from '../utils/blackjack-hand'
import { FakeLockManager } from '../utils/__fakes__/web-locks'
import { outgoingLockName } from '../utils/outgoing-lock'
import * as identitySession from '../utils/identity-session'
import { setConversationIdSalt as installTestConversationIdSalt } from './chats'
import { conversationIdSalt as testConversationIdSalt } from '@frank/cashweb/relay/conversation-id'

// An account that can open a chat always has its conversation-ID salt installed.
beforeEach(() =>
  installTestConversationIdSalt(
    testConversationIdSalt(new Uint8Array(32).fill(0x7e)),
  ),
)

jest.mock('../utils/notifications', () => ({ desktopNotify: jest.fn() }))

// The durable store: keyed exactly like LevelMessageStore (by `index`).
jest.mock('../adapters/level-message-store', () => {
  // Same (de)serialization as the real Level store, so exact wei values round trip.
  const { serializeMessageWrapper, deserializeMessageWrapper } =
    jest.requireActual('@frank/cashweb/relay/storage/level-storage')
  const serialized = new Map<string, string>()
  return {
    store: Promise.resolve({
      saveMessage: jest.fn(async (wrapper: MessageWrapper) => {
        serialized.set(wrapper.index, serializeMessageWrapper(wrapper))
      }),
      deleteMessage: jest.fn(async (index: string) => {
        serialized.delete(index)
      }),
      getMessage: jest.fn(async (index: string) => {
        const value = serialized.get(index)
        return value === undefined
          ? undefined
          : deserializeMessageWrapper(value)
      }),
      mostRecentMessageTime: jest.fn(async () => 0),
      relayCursor: jest.fn(async () => 0),
      quarantineRelayReceipts: jest.fn(async () => undefined),
      suppressAndDelete: jest.fn(
        async (_address: string, digests: string[]) => {
          digests.forEach(digest => serialized.delete(digest))
        },
      ),
      suppressedRelayReceipts: jest.fn(async () => new Set<string>()),
      getIterator: jest.fn(async () =>
        (async function* () {
          for (const value of serialized.values()) {
            yield deserializeMessageWrapper(value)
          }
        })(),
      ),
      // Test-only window onto the durable state.
      __serialized: serialized,
    }),
  }
})

async function durable(): Promise<Map<string, string>> {
  return (
    (await messageStorePromise) as unknown as {
      __serialized: Map<string, string>
    }
  ).__serialized
}

const ME = '0x1a1A1A1A1a1A1A1a1A1a1a1a1a1a1a1A1A1a1a1a'
const PEER = '0x2b2B2B2b2B2b2B2b2B2b2b2b2B2B2b2b2B2b2B2B'
const wallet = {
  identity: { address: { raw: ME }, displayAddress: ME },
} as unknown as WalletHandle

const TEXT = [{ type: 'text' as const, text: 'held two' }]
const HASH = 'ab'.repeat(32)
const STORED_CONVERSATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const okResult = (payloadDigest: string): DirectMessageSendResult => ({
  payloadDigest,
  stampValueWei: 1_000_000_000_000n,
  stampPayments: [],
  preparationTxHashes: [],
})

type SendParams = Parameters<typeof activeChain.directMessages.send>[0]

/** A send that journals its exact payment set (as the wallet does, before any byte goes to the
 * relay) and then fails the way the relay's pending-receipt window does. */
function sendJournalsThenPending(digest = HASH) {
  return jest
    .spyOn(activeChain.directMessages, 'send')
    .mockImplementation(async (params: SendParams) => {
      await params.onAttemptCreated?.(digest)
      throw new MonadStampPendingAttemptError([digest])
    })
}

function reconcileReturns(
  ...answers: Array<Record<string, DirectMessageAttemptStatus>>
) {
  const spy = jest.spyOn(activeChain.directMessages, 'reconcileAttempts')
  for (const answer of answers) spy.mockResolvedValueOnce(answer)
  return spy
}

/** What the wallet says it stored for a cut-off message (`attemptOf`): nothing, unless a test
 * says otherwise. */
let walletHolds: { payloadDigest: string; paid: boolean } | undefined
beforeEach(() => {
  walletHolds = undefined
})

/** The first step of the first reconciliation after a reload: each message found "sending" with
 * no recorded attempt is asked about in the wallet. */
async function askWalletAboutCutOffSends(
  chats: ReturnType<typeof useChatStore>,
) {
  jest
    .spyOn(activeChain.directMessages, 'attemptOf')
    .mockImplementation(async () => walletHolds)
  for (const conversation of Object.values(chats.conversations))
    for (const message of [...conversation.messages])
      if (
        message.outbound &&
        message.status === 'pending' &&
        message.delivery?.attemptDigest === undefined
      )
        await chats.resumeCutOffOutgoing({
          wallet,
          address: PEER,
          id: message.payloadDigest,
        })
}

async function reload({ askWallet = true }: { askWallet?: boolean } = {}) {
  const metadata = useChatStore().$state
  setActivePinia(createPinia())
  const chats = useChatStore()
  chats.$patch(
    await rehydateChat({
      ...metadata,
    }),
  )
  if (askWallet) await askWalletAboutCutOffSends(chats)
  return chats
}

/** What the durable store holds after the app stopped mid-send with no attempt digest recorded
 * (the digest write having failed): a pending outgoing record without `delivery.attemptDigest`. */
async function seedInterrupted() {
  const db = await durable()
  db.set(
    'pending:1:1:seed',
    serializeMessageWrapper({
      index: 'pending:1:1:seed',
      outbound: true,
      senderAddress: ME,
      copartyAddress: PEER,
      message: {
        conversationId: STORED_CONVERSATION_ID,
        outbound: true,
        status: 'pending',
        receivedTime: 1,
        serverTime: 1,
        items: TEXT,
        outpoints: [],
        senderAddress: ME,
        delivery: {},
      },
    }),
  )
}

const only = (chats: ReturnType<typeof useChatStore>) =>
  Object.values(chats.conversations)
    .filter(c => c.address === PEER)
    .flatMap(c => c.messages)

describe('outgoing direct messages (#269, #270)', () => {
  beforeEach(async () => {
    ;(await durable()).clear()
    setActivePinia(createPinia())
    jest.restoreAllMocks()
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  describe('#1237: outgoing conversation ownership', () => {
    const FIRST = '11111111-1111-4111-8111-111111111111'
    const SECOND = '22222222-2222-4222-8222-222222222222'

    it.each(['conversation', 'recipient'] as const)(
      'stops background recovery when durable %s ownership differs despite an equal attempt digest',
      async field => {
        const send = sendJournalsThenPending()
        const chats = useChatStore()
        await chats.sendMessage({
          wallet,
          address: PEER,
          conversationId: FIRST,
          items: TEXT,
        })
        const message = only(chats)[0]
        const db = await durable()
        const row = deserializeMessageWrapper(db.get(message.payloadDigest)!)
        if (field === 'conversation') row.message.conversationId = SECOND
        else row.copartyAddress = ME
        const foreignRow = serializeMessageWrapper(row)
        db.set(message.payloadDigest, foreignRow)
        const reconcile = reconcileReturns({ [HASH]: 'delivered' })
        await chats.reconcileOutgoing({ wallet })
        expect(db.get(message.payloadDigest)).toBe(foreignRow)
        expect(chats.messages[message.payloadDigest]).toBe(message)
        expect(chats.messages[HASH]).toBeUndefined()
        expect(message.status).toBe('payment-pending')
        expect(send).toHaveBeenCalledTimes(1)
        expect(reconcile).not.toHaveBeenCalled()
      },
    )

    it('carries the selected conversation into authenticated send and the confirmed durable row', async () => {
      const chats = useChatStore()
      chats.createConversation({
        participants: [ME, PEER],
        address: PEER,
        conversationId: FIRST,
      })
      const send = jest
        .spyOn(activeChain.directMessages, 'send')
        .mockResolvedValue(okResult(HASH))
      await chats.sendMessage({
        wallet,
        address: PEER,
        conversationId: FIRST,
        items: TEXT,
      })
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: FIRST }),
      )
      const persisted = deserializeMessageWrapper((await durable()).get(HASH)!)
      expect(persisted.message?.conversationId).toBe(FIRST)
      expect(persisted.message?.logicalMessageId).toBe(
        chats.messages[HASH]?.logicalMessageId,
      )
      expect(persisted.message?.logicalMessageId).toMatch(/^pending:/)
    })

    it.each(['send completion', 'mailbox echo'] as const)(
      'keeps interleaved %s, logical IDs and attempt links on their original same-peer threads across reload',
      async mode => {
        const chats = useChatStore()
        const entries = [
          {
            conversationId: FIRST,
            localId: 'pending:first-owner',
            digest: HASH,
          },
          {
            conversationId: SECOND,
            localId: 'pending:second-owner',
            digest: 'cd'.repeat(32),
          },
        ]
        for (const entry of entries) {
          chats.createConversation({
            participants: [ME, PEER],
            address: PEER,
            conversationId: entry.conversationId,
            name: 'Equal subject',
          })
          chats.sendMessageLocal({
            address: PEER,
            senderAddress: ME,
            conversationId: entry.conversationId,
            index: entry.localId,
            sealedMessageId: outgoingMessageId(entry.localId),
            financialOperations: [
              { chainIdentifier: 'xec-testnet', operationId: entry.localId },
            ],
            items: TEXT,
            outpoints: [],
            status: 'payment-pending',
            delivery: { attemptDigest: entry.digest },
            previousHash: null,
            timestamp: 100,
          })
          await chats.saveOutgoing(PEER, entry.localId, { strict: true })
        }
        for (const entry of [...entries].reverse()) {
          if (mode === 'send completion') {
            await chats.confirmOutgoing({
              address: PEER,
              id: entry.localId,
              payloadDigest: entry.digest,
            })
          } else {
            await chats.receiveMessages(
              [
                {
                  outbound: true,
                  senderAddress: ME,
                  copartyAddress: PEER,
                  copartyPubKey: { toBuffer: () => new Uint8Array(33) },
                  index: entry.digest,
                  stampValue: 0,
                  conversationId: entry.conversationId,
                  message: {
                    outbound: true,
                    status: 'confirmed',
                    senderAddress: ME,
                    destinationAddress: PEER,
                    conversationId: entry.conversationId,
                    items: TEXT,
                    outpoints: [],
                    serverTime: 200,
                    receivedTime: 200,
                  },
                },
              ],
              ME,
            )
          }
        }
        for (const entry of entries) {
          expect(chats.conversations[entry.conversationId].messages).toEqual([
            expect.objectContaining({
              payloadDigest: entry.digest,
              conversationId: entry.conversationId,
              logicalMessageId: entry.localId,
              sealedMessageId: outgoingMessageId(entry.localId),
              financialOperations: [
                { chainIdentifier: 'xec-testnet', operationId: entry.localId },
              ],
              delivery: expect.objectContaining({
                attemptDigest: entry.digest,
              }),
            }),
          ])
          expect(chats.logicalMessages[entry.localId]?.conversationId).toBe(
            entry.conversationId,
          )
          expect((await durable()).has(entry.localId)).toBe(false)
        }
        const restored = await rehydateChat(chats.$state)
        for (const entry of entries) {
          expect(
            restored.conversations[entry.conversationId].messages,
          ).toHaveLength(1)
          expect(
            restored.conversations[entry.conversationId].messages[0],
          ).toMatchObject({
            payloadDigest: entry.digest,
            conversationId: entry.conversationId,
            logicalMessageId: entry.localId,
          })
          expect(restored.logicalMessages[entry.localId]?.conversationId).toBe(
            entry.conversationId,
          )
        }
      },
    )
  })

  describe('background attempt ownership', () => {
    it.each([
      ['dead', false],
      ['unknown', false],
      ['live', false],
      ['delivered', false],
      ['live', true],
      ['delivered', true],
    ] as const)(
      'preserves live and durable owners on %s (conflict during lookup: %s)',
      async (status, conflictDuringLookup) => {
        const send = sendJournalsThenPending()
        const chats = useChatStore()
        await chats.sendMessage({ wallet, address: PEER, items: TEXT })
        const message = only(chats)[0]
        const id = message.payloadDigest
        await chats.setOutgoingState(PEER, id, 'error', {
          attemptDigest: HASH,
        })
        const db = await durable()
        const row = deserializeMessageWrapper(db.get(id)!)
        row.message.delivery = { attemptDigest: 'cd'.repeat(32) }
        const conflictingRow = serializeMessageWrapper(row)
        if (!conflictDuringLookup) db.set(id, conflictingRow)
        const reconcile = jest
          .spyOn(activeChain.directMessages, 'reconcileAttempts')
          .mockImplementation(async () => {
            if (conflictDuringLookup) db.set(id, conflictingRow)
            return { [HASH]: status }
          })

        await chats.reconcileOutgoing({ wallet })

        expect(db.get(id)).toBe(conflictingRow)
        expect(chats.messages[id]).toBe(message)
        expect(message.status).toBe('error')
        expect(message.delivery).toEqual({ attemptDigest: HASH })
        expect(db.has(HASH)).toBe(false)
        expect(chats.messages[HASH]).toBeUndefined()
        expect(only(chats)).toEqual([message])
        expect(reconcile).toHaveBeenCalledTimes(conflictDuringLookup ? 1 : 0)
        expect(send).toHaveBeenCalledTimes(1)
      },
    )
  })

  describe('recorded attempt ownership survives rejection', () => {
    it('keeps a dead-reported attempt across reload and later confirms the original message without paying again', async () => {
      const send = sendJournalsThenPending()
      const chats = useChatStore()
      await chats.sendMessage({ wallet, address: PEER, items: TEXT })
      const original = only(chats)[0]
      const originalId = original.payloadDigest
      const originalConversationId = original.conversationId
      const originalLogicalId = original.logicalMessageId
      reconcileReturns({ [HASH]: 'dead' })
      await chats.reconcileOutgoing({ wallet })
      expect(original.delivery).toMatchObject({
        attemptDigest: HASH,
        failureReason: 'rejected',
      })
      expect(original.conversationId).toBe(originalConversationId)
      expect(original.logicalMessageId).toBe(originalLogicalId)
      const restored = await reload()
      expect(restored.messages[originalId]?.delivery?.attemptDigest).toBe(HASH)
      reconcileReturns({ [HASH]: 'delivered' })
      await restored.reconcileOutgoing({ wallet })
      expect(only(restored)).toEqual([
        expect.objectContaining({
          payloadDigest: HASH,
          status: 'confirmed',
          items: TEXT,
        }),
      ])
      expect(restored.messages[originalId]).toBeUndefined()
      expect((await durable()).has(originalId)).toBe(false)
      expect(send).toHaveBeenCalledTimes(1)
    })

    it.each([
      ['dead', false],
      ['dead', true],
      ['unknown', false],
      ['unknown', true],
    ] as const)(
      'does not replace a recorded %s attempt on Retry (confirmed=%s)',
      async (status, confirmed) => {
        const send = sendJournalsThenPending()
        const chats = useChatStore()
        await chats.sendMessage({ wallet, address: PEER, items: TEXT })
        const message = only(chats)[0]
        await chats.setOutgoingState(PEER, message.payloadDigest, 'error', {
          attemptDigest: HASH,
        })
        reconcileReturns({ [HASH]: status })
        const result = await chats.retryOutgoing({
          wallet,
          address: PEER,
          payloadDigest: message.payloadDigest,
          confirmed,
        })
        expect(result).toEqual({
          state: 'failed',
          reason: status === 'dead' ? 'rejected' : 'unverified',
        })
        expect(message.delivery?.attemptDigest).toBe(HASH)
        expect(send).toHaveBeenCalledTimes(1)
      },
    )

    it('retains the recorded digest on presentation updates and rejects a replacement before mutation', async () => {
      sendJournalsThenPending()
      const chats = useChatStore()
      await chats.sendMessage({ wallet, address: PEER, items: TEXT })
      const message = only(chats)[0]
      const id = message.payloadDigest
      await chats.setOutgoingState(PEER, id, 'error', {
        failureReason: 'rejected',
      })
      expect(message.delivery).toEqual({
        attemptDigest: HASH,
        failureReason: 'rejected',
      })
      const persisted = (await durable()).get(id)
      await expect(
        chats.setOutgoingState(PEER, id, 'pending', {
          attemptDigest: 'cd'.repeat(32),
        }),
      ).rejects.toThrow(/attempt/i)
      expect(message.status).toBe('error')
      expect(message.delivery).toEqual({
        attemptDigest: HASH,
        failureReason: 'rejected',
      })
      expect((await durable()).get(id)).toBe(persisted)
    })

    it('stops fresh send retries after a transient failure following attempt attribution', async () => {
      const send = jest
        .spyOn(activeChain.directMessages, 'send')
        .mockImplementation(async params => {
          await params.onAttemptCreated?.(HASH)
          throw new Error('network unavailable after payment attribution')
        })
      const chats = useChatStore()
      await chats.sendMessage({ wallet, address: PEER, items: TEXT })
      expect(send).toHaveBeenCalledTimes(1)
      expect(only(chats)[0].delivery?.attemptDigest).toBe(HASH)
    }, 5000)

    it.each(['error', 'confirmed'])(
      'safe-stops retry when the durable %s row conflicts with live attempt ownership',
      async status => {
        const send = sendJournalsThenPending()
        const chats = useChatStore()
        await chats.sendMessage({ wallet, address: PEER, items: TEXT })
        const message = only(chats)[0]
        await chats.setOutgoingState(PEER, message.payloadDigest, 'error', {
          attemptDigest: HASH,
        })
        const db = await durable()
        const row = deserializeMessageWrapper(db.get(message.payloadDigest)!)
        row.message.status = status
        row.message.delivery = { attemptDigest: 'cd'.repeat(32) }
        db.set(message.payloadDigest, serializeMessageWrapper(row))
        const reconcile = jest
          .spyOn(activeChain.directMessages, 'reconcileAttempts')
          .mockResolvedValue({})
        expect(
          await chats.retryOutgoing({
            wallet,
            address: PEER,
            payloadDigest: message.payloadDigest,
          }),
        ).toEqual({ state: 'busy' })
        expect(chats.messages[message.payloadDigest]).toBe(message)
        expect(message.delivery?.attemptDigest).toBe(HASH)
        expect(reconcile).not.toHaveBeenCalled()
        expect(send).toHaveBeenCalledTimes(1)
      },
    )
  })

  it('ordinary chat manual retry still raises a stamp below the current fee', async () => {
    const { DirectMessageStampBelowFeeError } = require('@frank/wallet/chain')
    const send = jest
      .spyOn(activeChain.directMessages, 'send')
      .mockRejectedValueOnce(new DirectMessageStampBelowFeeError(1000n, 5000n))
      .mockResolvedValue(okResult(HASH))
    const minimum = jest
      .spyOn(activeChain.directMessages, 'minimumStamp')
      .mockResolvedValue(5000n)
    const chats = useChatStore()
    await chats.sendMessage({
      wallet,
      address: PEER,
      items: TEXT,
      stampValue: 1000n,
    })
    const row = only(chats)[0]
    expect(row.delivery?.failureReason).toBe('stamp-below-fee')
    expect(
      (
        await chats.retryOutgoing({
          wallet,
          address: PEER,
          payloadDigest: row.payloadDigest,
        })
      ).state,
    ).toBe('sent')
    expect(minimum).toHaveBeenCalled()
    expect(send.mock.calls[1][0].stampValue).toBe(5000n)
  })

  it('queues a throttled retained intent and recovers the same message after restart', async () => {
    const unavailable = Object.assign(new Error('relay RPC transport failed'), {
      code: 'SERVER_ERROR',
      status: 429,
    })
    const send = jest
      .spyOn(activeChain.directMessages, 'send')
      .mockRejectedValueOnce(unavailable)
      .mockImplementationOnce(async params => {
        throw new DirectMessageAlreadyAttemptedError(
          params.messageId!,
          HASH,
          'aa'.repeat(33),
        )
      })
    const chats = useChatStore()
    expect(
      await chats.sendMessage({
        wallet,
        address: PEER,
        items: TEXT,
        stampValue: 5n,
      }),
    ).toEqual({ state: 'payment-pending' })
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][0].messageId).toEqual(
      send.mock.calls[0][0].messageId,
    )
    expect(only(chats)[0].delivery?.attemptDigest).toBe(HASH)
    const restored = await reload()
    expect(only(restored)[0].status).toBe('payment-pending')
    const reconcile = reconcileReturns({ [HASH]: 'delivered' })
    await restored.reconcileOutgoing({ wallet })
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ payloadDigests: [HASH] }),
    )
    expect(only(restored)[0].status).toBe('confirmed')
    expect(send).toHaveBeenCalledTimes(2)
    expect(only(restored)).toHaveLength(1)
  })

  describe('reconnecting an explicitly unattempted send', () => {
    const offline = () =>
      Object.assign(new Error('network unavailable'), {
        [directMessageNotAttempted]: true,
      })

    it('keeps the original request queued across restart and recovers once online', async () => {
      const send = jest
        .spyOn(activeChain.directMessages, 'send')
        .mockRejectedValue(offline())
      const chats = useChatStore()
      expect(
        await chats.sendMessage({
          wallet,
          address: PEER,
          items: TEXT,
          stampValue: 5n,
        }),
      ).toEqual({ state: 'payment-pending' })
      const original = send.mock.calls[0][0]
      const queued = only(chats)[0]
      expect(queued.status).toBe('payment-pending')
      expect(queued.delivery?.attemptDigest).toBeUndefined()
      const restored = await reload()
      expect(
        only(restored).find(m => m.payloadDigest === queued.payloadDigest)
          ?.status,
      ).toBe('payment-pending')
      send.mockResolvedValue(okResult(HASH))
      await Promise.all([
        restored.reconcileOutgoing({ wallet }),
        restored.reconcileOutgoing({ wallet }),
      ])
      expect(send).toHaveBeenCalledTimes(4)
      expect(send.mock.calls[3][0]).toEqual(
        expect.objectContaining({
          messageId: original.messageId,
          recipient: original.recipient,
          items: original.items,
          stampValue: 5n,
        }),
      )
      expect(
        only(restored).filter(
          m => m.items[0]?.type === 'text' && m.items[0].text === TEXT[0].text,
        ),
      ).toEqual([
        expect.objectContaining({ status: 'confirmed', payloadDigest: HASH }),
      ])
      await restored.reconcileOutgoing({ wallet })
      expect(send).toHaveBeenCalledTimes(4)
      expect(only(await reload())).toHaveLength(1)
    })

    it('does not hold unrelated messages while the offline request waits', async () => {
      let rejectOffline!: (error: unknown) => void
      const waiting = new Promise<never>((_resolve, reject) => {
        rejectOffline = reject
      })
      const send = jest
        .spyOn(activeChain.directMessages, 'send')
        .mockRejectedValue(offline())
        .mockReturnValueOnce(waiting)
      const chats = useChatStore()
      const first = chats.sendMessage({
        wallet,
        address: PEER,
        items: TEXT,
        stampValue: 5n,
      })
      while (send.mock.calls.length === 0) await Promise.resolve()
      send.mockResolvedValueOnce(okResult('cd'.repeat(32)))
      expect(
        (
          await chats.sendMessage({
            wallet,
            address: PEER,
            items: [{ type: 'text', text: 'other' }],
            stampValue: 5n,
          })
        ).state,
      ).toBe('sent')
      rejectOffline(offline())
      expect(await first).toEqual({ state: 'payment-pending' })
      expect(only(chats)).toHaveLength(2)
    })

    it('never queues a later labelled refusal after an ambiguous call', async () => {
      const send = jest
        .spyOn(activeChain.directMessages, 'send')
        .mockRejectedValueOnce(new Error('network response lost'))
        .mockRejectedValue(offline())
      const chats = useChatStore()
      expect(
        (
          await chats.sendMessage({
            wallet,
            address: PEER,
            items: TEXT,
            stampValue: 5n,
          })
        ).state,
      ).toBe('failed')
      await chats.reconcileOutgoing({ wallet })
      expect(send).toHaveBeenCalledTimes(3)
      expect(only(chats)[0].status).toBe('error')
    })

    it('reconciles an exposed attempt rather than sending a new request', async () => {
      const send = jest
        .spyOn(activeChain.directMessages, 'send')
        .mockImplementation(async params => {
          await params.onAttemptCreated?.(HASH)
          throw new Error('network response lost')
        })
      const chats = useChatStore()
      await chats.sendMessage({
        wallet,
        address: PEER,
        items: TEXT,
        stampValue: 5n,
      })
      const restored = await reload()
      const reconcile = reconcileReturns({ [HASH]: 'unknown' })
      await restored.reconcileOutgoing({ wallet })
      expect(reconcile).toHaveBeenCalled()
      expect(send).toHaveBeenCalledTimes(1)
      expect(only(restored)[0].delivery?.attemptDigest).toBe(HASH)
    })
  })

  describe('foreground retry scheduling', () => {
    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
      jest.spyOn(console, 'error').mockImplementation(() => undefined)
    })

    afterEach(() => {
      jest.useRealTimers()
    })

    it('waits 500ms then 1000ms, stops at three calls, and retains the message and destination', async () => {
      const send = jest
        .spyOn(activeChain.directMessages, 'send')
        .mockRejectedValue(new Error('network response lost'))
      const chats = useChatStore()
      const sending = chats.sendMessage({
        wallet,
        address: PEER,
        conversationId: STORED_CONVERSATION_ID,
        items: TEXT,
        stampValue: 5n,
      })
      await jest.advanceTimersByTimeAsync(0)
      expect(send).toHaveBeenCalledTimes(1)
      await jest.advanceTimersByTimeAsync(499)
      expect(send).toHaveBeenCalledTimes(1)
      await jest.advanceTimersByTimeAsync(1)
      expect(send).toHaveBeenCalledTimes(2)
      await jest.advanceTimersByTimeAsync(999)
      expect(send).toHaveBeenCalledTimes(2)
      await jest.advanceTimersByTimeAsync(1)
      expect((await sending).state).toBe('failed')
      await jest.advanceTimersByTimeAsync(10_000)
      expect(send).toHaveBeenCalledTimes(3)
      const original = send.mock.calls[0][0]
      expect(original.messageId).toBeDefined()
      expect(original.conversationId).toBe(STORED_CONVERSATION_ID)
      expect(original.recipient).toEqual(activeChain.parseAddress(PEER))
      for (const [request] of send.mock.calls) {
        expect(request).toEqual(
          expect.objectContaining({
            messageId: original.messageId,
            recipient: original.recipient,
            conversationId: STORED_CONVERSATION_ID,
            items: TEXT,
            stampValue: 5n,
          }),
        )
      }
      expect(only(chats)).toHaveLength(1)
      expect(only(chats)[0].status).toBe('error')
    })

    it.each([true, false])(
      'honors a 5000ms readiness budget (ready=%s) before deciding whether to back off',
      async ready => {
        const wait = jest
          .spyOn(identitySession, 'waitForMessagingReady')
          .mockResolvedValue(ready)
        const pending = Object.assign(
          new Error('directory publication pending'),
          {
            name: 'CanonicalMessagingPendingError',
          },
        )
        const send = jest
          .spyOn(activeChain.directMessages, 'send')
          .mockRejectedValueOnce(pending)
          .mockRejectedValueOnce(pending)
          .mockResolvedValue(okResult(HASH))
        const sending = useChatStore().sendMessage({
          wallet,
          address: PEER,
          items: TEXT,
        })
        await jest.advanceTimersByTimeAsync(0)
        if (!ready) {
          expect(send).toHaveBeenCalledTimes(1)
          expect(wait.mock.calls).toEqual([[5_000]])
          await jest.advanceTimersByTimeAsync(499)
          expect(send).toHaveBeenCalledTimes(1)
          await jest.advanceTimersByTimeAsync(1)
          expect(send).toHaveBeenCalledTimes(2)
          await jest.advanceTimersByTimeAsync(999)
          expect(send).toHaveBeenCalledTimes(2)
          await jest.advanceTimersByTimeAsync(1)
        }
        expect((await sending).state).toBe('sent')
        expect(send).toHaveBeenCalledTimes(3)
        expect(wait.mock.calls).toEqual([[5_000], [5_000]])
      },
    )

    it('does not treat a labelled cause as proof that the rejected call did nothing', async () => {
      const unattempted = Object.assign(new Error('network unavailable'), {
        [directMessageNotAttempted]: true,
      })
      const wrapped = Object.assign(new Error('network response lost'), {
        cause: unattempted,
      })
      const send = jest
        .spyOn(activeChain.directMessages, 'send')
        .mockRejectedValueOnce(wrapped)
        .mockRejectedValue(unattempted)
      const chats = useChatStore()
      const sending = chats.sendMessage({ wallet, address: PEER, items: TEXT })
      await jest.advanceTimersByTimeAsync(1_500)
      expect((await sending).state).toBe('failed')
      expect(only(chats)[0].status).toBe('error')
      await chats.reconcileOutgoing({ wallet })
      expect(send).toHaveBeenCalledTimes(3)
    })
  })

  describe('#269: a failed message survives a reload with its Retry', () => {
    it('keeps the text and the failure reason across a reload', async () => {
      jest
        .spyOn(activeChain.directMessages, 'send')
        .mockRejectedValue(
          Object.assign(new Error('no response'), { isAxiosError: true }),
        )
      const chats = useChatStore()
      const outcome = await chats.sendMessage({
        wallet,
        address: PEER,
        items: TEXT,
        stampValue: 5n,
      })
      expect(outcome).toEqual({ state: 'failed', reason: 'unreachable' })

      const restored = await reload()
      expect(only(restored)).toEqual([
        expect.objectContaining({
          status: 'error',
          outbound: true,
          items: TEXT,
          stampValueWei: 5n,
          delivery: expect.objectContaining({ failureReason: 'unreachable' }),
        }),
      ])
    })

    it('Retry after a reload delivers it, and the failed record is replaced (not duplicated)', async () => {
      const send = jest
        .spyOn(activeChain.directMessages, 'send')
        .mockRejectedValueOnce(new MonadMailboxUnavailableError('404', 404))
      await useChatStore().sendMessage({ wallet, address: PEER, items: TEXT })

      const restored = await reload()
      const [failed] = only(restored)
      expect(failed.status).toBe('error')
      send.mockResolvedValueOnce(okResult('cd'.repeat(32)))
      const outcome = await restored.retryOutgoing({
        wallet,
        address: PEER,
        payloadDigest: failed.payloadDigest,
      })
      expect(outcome).toEqual({
        state: 'sent',
        payloadDigest: 'cd'.repeat(32),
      })
      expect(only(restored)).toEqual([
        expect.objectContaining({ status: 'confirmed', items: TEXT }),
      ])
      // And the durable copy after one more reload is the single confirmed message.
      expect(only(await reload())).toHaveLength(1)
      expect([...(await durable()).keys()]).toEqual(['cd'.repeat(32)])
    })

    it('Discard removes it durably; it does not come back after a reload', async () => {
      jest
        .spyOn(activeChain.directMessages, 'send')
        .mockRejectedValue(new Error('boom'))
      const chats = useChatStore()
      await chats.sendMessage({ wallet, address: PEER, items: TEXT })
      await chats.deleteMessage({
        address: PEER,
        payloadDigest: only(chats)[0].payloadDigest,
      })
      expect(only(await reload())).toEqual([])
    })

    it.each([
      [
        'a 404 mailbox',
        new MonadMailboxUnavailableError('404', 404),
        'unavailable',
      ],
      [
        'a terminal relay verdict',
        new MonadStampTerminalError(
          'terminal',
          422,
          'mailbox_terminal',
          true,
          {},
        ),
        'rejected',
      ],
      ['anything else', new Error('nonsense'), 'error'],
    ] as const)('classifies %s as %s', async (_name, error, reason) => {
      jest.spyOn(activeChain.directMessages, 'send').mockRejectedValue(error)
      const outcome = await useChatStore().sendMessage({
        wallet,
        address: PEER,
        items: TEXT,
      })
      expect(outcome).toEqual({ state: 'failed', reason })
    })

    it('retries transient 502 Bad Gateway and succeeds when send resolves', async () => {
      const sendSpy = jest
        .spyOn(activeChain.directMessages, 'send')
        .mockRejectedValueOnce(
          new Error(
            'server response 502 Bad Gateway (invalid_rpc_upstream_response)',
          ),
        )
        .mockResolvedValueOnce(okResult(HASH))

      const outcome = await useChatStore().sendMessage({
        wallet,
        address: PEER,
        items: TEXT,
      })
      expect(outcome).toEqual({ state: 'sent', payloadDigest: HASH })
      expect(sendSpy).toHaveBeenCalledTimes(2)
    })

    it('an in-flight message left over from a stopped app, for which the wallet stored nothing, becomes a failed one (no attempt) it can Retry', async () => {
      // The app was closed mid-send: what is durable is a 'pending' record.
      await seedInterrupted()
      // Until the wallet has been asked it is still shown as sending, not as failed.
      const unasked = await reload({ askWallet: false })
      expect(only(unasked)[0]).toEqual(
        expect.objectContaining({ status: 'pending', delivery: {} }),
      )
      const restored = await reload()
      expect(only(restored)[0]).toEqual(
        expect.objectContaining({
          status: 'error',
          delivery: expect.objectContaining({ failureReason: 'interrupted' }),
        }),
      )
    })

    // Seen in the browser: a just-sent message was shown "Failed to send. It was interrupted
    // before it was sent." after a reload, while the wallet held its complete signed message
    // (and delivered and paid it). The row had not learned the digest when the page went.
    it("a reload while the wallet holds the message's stored attempt RESUMES it: the row points at that attempt, the same bytes are re-sent, nothing is paid again, and it is never shown as interrupted", async () => {
      await seedInterrupted()
      walletHolds = { payloadDigest: HASH, paid: true }
      const send = jest.spyOn(activeChain.directMessages, 'send')
      const restored = await reload()
      const [message] = only(restored)
      expect(message).toEqual(
        expect.objectContaining({
          status: 'payment-pending',
          delivery: { attemptDigest: HASH },
        }),
      )
      // The wallet was asked by this message's own ID, which is fixed by its saved key.
      expect(activeChain.directMessages.attemptOf).toHaveBeenCalledWith({
        wallet,
        messageId: outgoingMessageId('pending:1:1:seed'),
      })
      // Durable: a second reload finds the attempt on the row and asks nothing.
      const again = await reload({ askWallet: false })
      expect(only(again)[0].delivery?.attemptDigest).toBe(HASH)
      // The reconciliation re-sends the stored bytes and the message is delivered.
      const reconcile = reconcileReturns({ [HASH]: 'delivered' })
      expect(await again.reconcileOutgoing({ wallet })).toEqual({ pending: 0 })
      expect(reconcile).toHaveBeenCalledWith(
        expect.objectContaining({ payloadDigests: [HASH] }),
      )
      expect(only(again)[0]).toEqual(
        expect.objectContaining({ status: 'confirmed', payloadDigest: HASH }),
      )
      expect(send).not.toHaveBeenCalled()
    })

    it('the first reconciliation after a reload asks the wallet about a cut-off send by itself; a wallet that cannot answer leaves the message sending, to be asked again', async () => {
      await seedInterrupted()
      const restored = await reload({ askWallet: false })
      const attemptOf = jest
        .spyOn(activeChain.directMessages, 'attemptOf')
        .mockRejectedValueOnce(new Error('wallet not open yet'))
        .mockResolvedValue({ payloadDigest: HASH, paid: true })
      const reconcile = reconcileReturns({ [HASH]: 'live' })
      await restored.reconcileOutgoing({ wallet })
      expect(only(restored)[0].status).toBe('pending')
      expect(reconcile).not.toHaveBeenCalled()
      await restored.reconcileOutgoing({ wallet })
      expect(attemptOf).toHaveBeenCalledTimes(2)
      expect(only(restored)[0]).toEqual(
        expect.objectContaining({
          status: 'payment-pending',
          delivery: expect.objectContaining({ attemptDigest: HASH }),
        }),
      )
      expect(reconcile).toHaveBeenCalledTimes(1)
    })

    it("a Retry of an interrupted message is sent under the same message ID, and when the wallet answers that it already holds that ID's attempt the row takes that attempt instead of a second payment", async () => {
      await seedInterrupted()
      const restored = await reload()
      const [message] = only(restored)
      expect(message.delivery?.failureReason).toBe('interrupted')
      jest
        .spyOn(activeChain.directMessages, 'unattributedAttempts')
        .mockResolvedValue([])
      const send = jest
        .spyOn(activeChain.directMessages, 'send')
        .mockRejectedValue(
          new DirectMessageAlreadyAttemptedError(
            outgoingMessageId(message.payloadDigest),
            HASH,
            'aa'.repeat(33),
          ),
        )
      await expect(
        restored.retryOutgoing({
          wallet,
          address: PEER,
          payloadDigest: message.payloadDigest,
        }),
      ).resolves.toEqual({ state: 'payment-pending' })
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0][0].messageId).toBe(
        outgoingMessageId(message.payloadDigest),
      )
      expect(only(restored)[0]).toEqual(
        expect.objectContaining({
          status: 'payment-pending',
          delivery: expect.objectContaining({ attemptDigest: HASH }),
        }),
      )
    })
  })

  describe('#270: pending payment is not a failure, and it reconciles', () => {
    async function pendingMessage() {
      const send = sendJournalsThenPending()
      const chats = useChatStore()
      const outcome = await chats.sendMessage({
        wallet,
        address: PEER,
        items: TEXT,
      })
      return { send, chats, outcome }
    }

    it('shows Payment pending (not Failed) and records the exact attempt on the message', async () => {
      const { chats, outcome } = await pendingMessage()
      expect(outcome).toEqual({ state: 'payment-pending' })
      expect(only(chats)[0]).toEqual(
        expect.objectContaining({
          status: 'payment-pending',
          delivery: { attemptDigest: HASH, live: true },
        }),
      )
    })

    it('flips to Sent when the same payment finally delivers, with one copy and no rebuilt payment', async () => {
      const { send, chats } = await pendingMessage()
      const reconcile = reconcileReturns(
        { [HASH]: 'live' },
        { [HASH]: 'delivered' },
      )

      await expect(chats.reconcileOutgoing({ wallet })).resolves.toEqual({
        pending: 1,
      })
      expect(only(chats)[0].status).toBe('payment-pending')

      await expect(chats.reconcileOutgoing({ wallet })).resolves.toEqual({
        pending: 0,
      })
      expect(only(chats)).toEqual([
        expect.objectContaining({
          payloadDigest: HASH,
          status: 'confirmed',
          items: TEXT,
        }),
      ])
      expect(send).toHaveBeenCalledTimes(1) // never re-sent as a new message
      expect(reconcile).toHaveBeenCalledTimes(2)
      // Sender history after a reload holds the message once, in its true state.
      expect(only(await reload())).toEqual([
        expect.objectContaining({ payloadDigest: HASH, status: 'confirmed' }),
      ])
    })

    it('a reload while the payment is pending keeps it pending and reconcilable', async () => {
      await pendingMessage()
      const restored = await reload()
      expect(only(restored)[0]).toEqual(
        expect.objectContaining({
          status: 'payment-pending',
          delivery: { attemptDigest: HASH },
        }),
      )
      reconcileReturns({ [HASH]: 'delivered' })
      await restored.reconcileOutgoing({ wallet })
      expect(only(restored)[0].status).toBe('confirmed')
    })

    it('a leftover local record beside its confirmed twin is shown once after a reload', async () => {
      const { chats } = await pendingMessage()
      const localId = only(chats)[0].payloadDigest
      const db = await durable()
      const local = deserializeMessageWrapper(db.get(localId) as string)
      // Crash between the two writes of the re-key: both records exist.
      db.set(
        HASH,
        serializeMessageWrapper({
          ...local,
          index: HASH,
          message: {
            ...local.message,
            status: 'confirmed',
            delivery: undefined,
          },
        }),
      )
      const restored = await reload()
      expect(only(restored)).toHaveLength(1)
      expect(only(restored)[0].status).toBe('confirmed')
      // Hydration only rebuilds the view; both durable recovery records remain intact.
      expect([...db.keys()]).toEqual([localId, HASH])
      expect(
        deserializeMessageWrapper(db.get(HASH) as string).message.status,
      ).toBe('confirmed')
    })

    it('does not surface the message as Failed when sending is blocked behind an earlier pending attempt, and sends it once that clears', async () => {
      const send = jest
        .spyOn(activeChain.directMessages, 'send')
        .mockRejectedValueOnce(new MonadStampPendingAttemptError(['other']))
      const chats = useChatStore()
      await expect(
        chats.sendMessage({ wallet, address: PEER, items: TEXT }),
      ).resolves.toEqual({ state: 'payment-pending' })
      expect(only(chats)[0]).toEqual(
        expect.objectContaining({ status: 'payment-pending', delivery: {} }),
      )
      send.mockResolvedValueOnce(okResult('ef'.repeat(32)))
      await chats.reconcileOutgoing({ wallet })
      expect(only(chats)).toEqual([
        expect.objectContaining({ status: 'confirmed' }),
      ])
      expect(send).toHaveBeenCalledTimes(2)
    })

    it('discarding a failed message calls discardAttempt and immediately unblocks subsequent queued messages', async () => {
      const discardSpy = jest.spyOn(
        activeChain.directMessages,
        'discardAttempt',
      )
      const send = jest.spyOn(activeChain.directMessages, 'send')

      // First message fails after recording an attempt
      send.mockImplementationOnce(async params => {
        await params.onAttemptCreated?.(HASH)
        throw new Error('relay connection refused')
      })

      const chats = useChatStore()
      await chats.sendMessage({
        wallet,
        address: PEER,
        items: [{ type: 'text', text: 'first' }],
      })
      const [first] = only(chats)
      expect(first.status).toBe('error')

      // Second message is queued behind the hold
      send.mockImplementationOnce(async () => {
        throw new MonadStampPendingAttemptError([HASH])
      })
      await chats.sendMessage({
        wallet,
        address: PEER,
        items: [{ type: 'text', text: 'second' }],
      })
      expect(only(chats)).toHaveLength(2)
      expect(only(chats)[1].status).toBe('payment-pending')
      expect(only(chats)[1].delivery?.attemptDigest).toBeUndefined()

      // User discards the failed first message
      send.mockResolvedValueOnce(okResult('cd'.repeat(32)))
      await chats.deleteMessage({
        address: PEER,
        payloadDigest: first.payloadDigest,
        attemptDigest: first.delivery?.attemptDigest,
        wallet,
      })

      expect(discardSpy).toHaveBeenCalledWith(
        expect.objectContaining({ wallet, payloadDigest: HASH }),
      )
      // The second message was automatically unblocked and sent by reconcileOutgoing
      expect(only(chats)).toHaveLength(1)
      expect(only(chats)[0].status).toBe('confirmed')
      expect(only(chats)[0].items).toEqual([{ type: 'text', text: 'second' }])
    })

    it('reconcileOutgoing settles an errored message with an attemptDigest as delivered, and sends the queued message behind it', async () => {
      const send = jest.spyOn(activeChain.directMessages, 'send')

      // First message fails after recording an attempt
      send.mockImplementationOnce(async params => {
        await params.onAttemptCreated?.(HASH)
        throw new Error('relay connection refused')
      })

      const chats = useChatStore()
      await chats.sendMessage({
        wallet,
        address: PEER,
        items: [{ type: 'text', text: 'first' }],
      })
      expect(only(chats)[0].status).toBe('error')
      expect(only(chats)[0].delivery?.attemptDigest).toBe(HASH)

      // Second message is queued behind the hold
      send.mockImplementationOnce(async () => {
        throw new MonadStampPendingAttemptError([HASH])
      })
      await chats.sendMessage({
        wallet,
        address: PEER,
        items: [{ type: 'text', text: 'second' }],
      })
      expect(only(chats)[1].status).toBe('payment-pending')

      // Background reconciliation queries HASH, finds it was delivered on-chain,
      // confirms first message and drains second message
      reconcileReturns({ [HASH]: 'delivered' })
      send.mockResolvedValueOnce(okResult('cd'.repeat(32)))

      await chats.reconcileOutgoing({ wallet })

      expect(only(chats)[0].status).toBe('confirmed')
      expect(only(chats)[0].payloadDigest).toBe(HASH)
      expect(only(chats)[1].status).toBe('confirmed')
      expect(only(chats)[1].items).toEqual([{ type: 'text', text: 'second' }])
    })

    it('reconcileOutgoing settles an errored message with an attemptDigest as dead, and sends the queued message behind it', async () => {
      const send = jest.spyOn(activeChain.directMessages, 'send')

      // First message fails after recording an attempt
      send.mockImplementationOnce(async params => {
        await params.onAttemptCreated?.(HASH)
        throw new Error('relay connection refused')
      })

      const chats = useChatStore()
      await chats.sendMessage({
        wallet,
        address: PEER,
        items: [{ type: 'text', text: 'first' }],
      })
      expect(only(chats)[0].status).toBe('error')
      expect(only(chats)[0].delivery?.attemptDigest).toBe(HASH)

      // Second message is queued behind the hold
      send.mockImplementationOnce(async () => {
        throw new MonadStampPendingAttemptError([HASH])
      })
      await chats.sendMessage({
        wallet,
        address: PEER,
        items: [{ type: 'text', text: 'second' }],
      })
      expect(only(chats)[1].status).toBe('payment-pending')

      // A dead report changes presentation but retains the original attempt.
      // The separately authorized queued message can still proceed.
      reconcileReturns({ [HASH]: 'dead' })
      send.mockResolvedValueOnce(okResult('cd'.repeat(32)))

      await chats.reconcileOutgoing({ wallet })

      expect(only(chats)[0].status).toBe('error')
      expect(only(chats)[0].delivery?.failureReason).toBe('rejected')
      expect(only(chats)[0].delivery?.attemptDigest).toBe(HASH)
      expect(only(chats)[1].status).toBe('confirmed')
      expect(only(chats)[1].items).toEqual([{ type: 'text', text: 'second' }])
    })

    it('reconciles pending outgoing messages stored under conversations (UUID key) and drains queued messages', async () => {
      const chats = useChatStore()
      const convId = 'f74c6536-a36c-4860-91fb-145c22824cf4'
      const send = jest.spyOn(activeChain.directMessages, 'send')
      send.mockImplementationOnce(async params => {
        await params.onAttemptCreated?.(HASH)
        throw new Error('relay connection refused')
      })

      await chats.sendMessage({
        wallet,
        address: PEER,
        items: [{ type: 'text', text: 'first' }],
      })

      // Move chat to conversations under UUID key
      const chat = chats.chats[PEER]!
      delete chats.chats[PEER]
      chats.conversations[convId] = {
        ...chat,
        id: convId,
        address: PEER,
      }

      send.mockImplementationOnce(async () => {
        throw new MonadStampPendingAttemptError([HASH])
      })
      await chats.sendMessage({
        wallet,
        address: PEER,
        items: [{ type: 'text', text: 'second' }],
      })

      const convMessages = chats.conversations[convId].messages
      expect(convMessages.length).toBe(2)
      expect(convMessages[1].status).toBe('payment-pending')

      reconcileReturns({ [HASH]: 'dead' })
      send.mockResolvedValueOnce(okResult('cd'.repeat(32)))

      await chats.reconcileOutgoing({ wallet })

      expect(convMessages[0].status).toBe('error')
      expect(convMessages[0].delivery?.failureReason).toBe('rejected')
      expect(convMessages[0].delivery?.attemptDigest).toBe(HASH)
      expect(convMessages[1].status).toBe('confirmed')
      expect(convMessages[1].items).toEqual([{ type: 'text', text: 'second' }])
    })

    it('quarantines an old account unsettled message from automatic and manual spending', async () => {
      const oldSender = '0x3333333333333333333333333333333333333333'
      const db = await durable()
      db.set(
        'pending:old-account',
        serializeMessageWrapper({
          index: 'pending:old-account',
          outbound: true,
          senderAddress: oldSender,
          copartyAddress: PEER,
          message: {
            conversationId: STORED_CONVERSATION_ID,
            outbound: true,
            status: 'payment-pending',
            receivedTime: 1,
            serverTime: 1,
            items: TEXT,
            outpoints: [],
            stampValueWei: 5n,
            senderAddress: oldSender,
            delivery: {},
          },
        }),
      )
      const restored = await reload()
      const send = jest.spyOn(activeChain.directMessages, 'send')

      await expect(restored.reconcileOutgoing({ wallet })).resolves.toEqual({
        pending: 0,
      })
      only(restored)[0].status = 'error'
      await expect(
        restored.retryOutgoing({
          wallet,
          address: PEER,
          payloadDigest: 'pending:old-account',
        }),
      ).resolves.toEqual({ state: 'busy' })
      expect(send).not.toHaveBeenCalled()
    })
  })

  it('accounts only confirmed value live and after reload', async () => {
    const send = jest
      .spyOn(activeChain.directMessages, 'send')
      .mockRejectedValueOnce(new Error('preparation failed'))
      .mockResolvedValueOnce({
        ...okResult('confirmed-value'),
        stampValueWei: 7n,
      })
    const chats = useChatStore()
    await chats.sendMessage({
      wallet,
      address: PEER,
      items: TEXT,
      stampValue: 5n,
    })
    await chats.sendMessage({
      wallet,
      address: PEER,
      items: TEXT,
      stampValue: 7n,
    })
    expect(chats.chats[PEER]?.totalValue).toBe(7)
    expect((await reload()).chats[PEER]?.totalValue).toBe(7)
    expect(send).toHaveBeenCalledTimes(2)
  })

  describe('a manual Retry never pays twice for the same message', () => {
    async function failedWithAttempt() {
      // The send journaled its payment set, then failed for an unrelated reason.
      const send = jest
        .spyOn(activeChain.directMessages, 'send')
        .mockImplementationOnce(async (params: SendParams) => {
          await params.onAttemptCreated?.(HASH)
          throw new Error('storage hiccup after journaling')
        })
      const chats = useChatStore()
      await chats.sendMessage({ wallet, address: PEER, items: TEXT })
      expect(only(chats)[0]).toEqual(
        expect.objectContaining({
          status: 'error',
          delivery: expect.objectContaining({ attemptDigest: HASH }),
        }),
      )
      return { send, chats, id: only(chats)[0].payloadDigest }
    }

    it('live attempt: Retry re-sends the SAME bytes (no new payment set is built)', async () => {
      const { send, chats, id } = await failedWithAttempt()
      const reconcile = reconcileReturns({ [HASH]: 'live' })
      await expect(
        chats.retryOutgoing({ wallet, address: PEER, payloadDigest: id }),
      ).resolves.toEqual({ state: 'payment-pending' })
      expect(reconcile).toHaveBeenCalledWith(
        expect.objectContaining({ payloadDigests: [HASH] }),
      )
      expect(send).toHaveBeenCalledTimes(1) // only the original send ever built payments
      expect(only(chats)[0].status).toBe('payment-pending')
    })

    it('delivered attempt: Retry just confirms it; nothing is sent again', async () => {
      const { send, chats, id } = await failedWithAttempt()
      reconcileReturns({ [HASH]: 'delivered' })
      await expect(
        chats.retryOutgoing({ wallet, address: PEER, payloadDigest: id }),
      ).resolves.toEqual({ state: 'sent', payloadDigest: HASH })
      expect(send).toHaveBeenCalledTimes(1)
    })

    it('terminal report: Retry preserves the original payment instead of replacing it', async () => {
      const { send, chats, id } = await failedWithAttempt()
      reconcileReturns({ [HASH]: 'dead' })
      await expect(
        chats.retryOutgoing({ wallet, address: PEER, payloadDigest: id }),
      ).resolves.toEqual({ state: 'failed', reason: 'rejected' })
      expect(send).toHaveBeenCalledTimes(1)
      expect(only(chats)[0].delivery?.attemptDigest).toBe(HASH)
      expect(only(chats)).toHaveLength(1)
    })

    it('the background loop retains a dead-reported attempt for later reconciliation', async () => {
      const { send, chats } = await failedWithAttempt()
      // Put it back to payment-pending like an in-progress pending message.
      const message = only(chats)[0]
      message.status = 'payment-pending'
      reconcileReturns({ [HASH]: 'dead' })
      await chats.reconcileOutgoing({ wallet })
      expect(send).toHaveBeenCalledTimes(1)
      expect(only(chats)[0]).toEqual(
        expect.objectContaining({
          status: 'error',
          delivery: expect.objectContaining({ failureReason: 'rejected' }),
        }),
      )
    })

    it('unknown fate: even confirmed Retry cannot replace the recorded payment', async () => {
      const { send, chats, id } = await failedWithAttempt()
      reconcileReturns({ [HASH]: 'unknown' }, { [HASH]: 'unknown' })
      await expect(
        chats.retryOutgoing({ wallet, address: PEER, payloadDigest: id }),
      ).resolves.toEqual({ state: 'failed', reason: 'unverified' })
      expect(send).toHaveBeenCalledTimes(1)

      await expect(
        chats.retryOutgoing({
          wallet,
          address: PEER,
          payloadDigest: id,
          confirmed: true,
        }),
      ).resolves.toEqual({ state: 'failed', reason: 'unverified' })
      expect(send).toHaveBeenCalledTimes(1)
      expect(only(chats)[0].delivery?.attemptDigest).toBe(HASH)
    })

    it('an abandoned attempt (relay may own the bytes) is unverified, not freely retryable', async () => {
      jest
        .spyOn(activeChain.directMessages, 'send')
        .mockRejectedValue(new MonadStampAbandonedError('gone', HASH))
      const chats = useChatStore()
      await expect(
        chats.sendMessage({ wallet, address: PEER, items: TEXT }),
      ).resolves.toEqual({ state: 'failed', reason: 'unverified' })
      expect(only(chats)[0].delivery?.attemptDigest).toBe(HASH)
    })

    it('a Recovered earlier attempt marks this draft failed until the user confirms sending it again', async () => {
      const send = jest
        .spyOn(activeChain.directMessages, 'send')
        .mockRejectedValueOnce(new MonadStampRecoveredAttemptError(['other']))
      jest
        .spyOn(activeChain.directMessages, 'reconcileAttempts')
        .mockResolvedValue({})
      const chats = useChatStore()
      await expect(
        chats.sendMessage({ wallet, address: PEER, items: TEXT }),
      ).resolves.toEqual({ state: 'failed', reason: 'recovered' })
      const id = only(chats)[0].payloadDigest
      await expect(
        chats.retryOutgoing({ wallet, address: PEER, payloadDigest: id }),
      ).resolves.toEqual({ state: 'needs-confirmation', reason: 'recovered' })
      expect(send).toHaveBeenCalledTimes(1)
    })

    it('a second click while a retry is running is ignored', async () => {
      const { send, chats, id } = await failedWithAttempt()
      let release: (
        status: Record<string, DirectMessageAttemptStatus>,
      ) => void = () => undefined
      jest
        .spyOn(activeChain.directMessages, 'reconcileAttempts')
        .mockReturnValue(
          new Promise(resolve => {
            release = resolve
          }),
        )
      const first = chats.retryOutgoing({
        wallet,
        address: PEER,
        payloadDigest: id,
      })
      await expect(
        chats.retryOutgoing({ wallet, address: PEER, payloadDigest: id }),
      ).resolves.toEqual({ state: 'busy' })
      release({ [HASH]: 'live' })
      await first
      expect(send).toHaveBeenCalledTimes(1)
    })

    it('Discard wins over a Retry waiting on reconciliation without durable resurrection', async () => {
      const { chats, id } = await failedWithAttempt()
      let release: (
        status: Record<string, DirectMessageAttemptStatus>,
      ) => void = () => undefined
      const reconcile = jest
        .spyOn(activeChain.directMessages, 'reconcileAttempts')
        .mockReturnValue(
          new Promise(resolve => {
            release = resolve
          }),
        )
      const retrying = chats.retryOutgoing({
        wallet,
        address: PEER,
        payloadDigest: id,
      })
      while (reconcile.mock.calls.length === 0) await Promise.resolve()

      await chats.deleteMessage({ address: PEER, payloadDigest: id })
      release({ [HASH]: 'live' })

      await expect(retrying).resolves.toEqual({ state: 'busy' })
      expect(only(chats)).toEqual([])
      expect(only(await reload())).toEqual([])
    })
  })

  describe('Clear and composer sends share one durable state order', () => {
    it('a send whose first save started before Clear is removed live and after reload', async () => {
      const messageStore = (await messageStorePromise) as unknown as {
        saveMessage: jest.Mock
      }
      const originalSave = messageStore.saveMessage.getMockImplementation()
      let saveStarted: (() => void) | undefined
      const started = new Promise<void>(resolve => {
        saveStarted = resolve
      })
      let releaseSave: (() => void) | undefined
      const gate = new Promise<void>(resolve => {
        releaseSave = resolve
      })
      messageStore.saveMessage.mockImplementation(
        async (wrapper: MessageWrapper) => {
          saveStarted?.()
          await gate
          return originalSave?.(wrapper)
        },
      )
      jest
        .spyOn(activeChain.directMessages, 'send')
        .mockRejectedValue(new Error('offline'))
      const chats = useChatStore()

      const sending = chats.sendMessage({ wallet, address: PEER, items: TEXT })
      await started
      const clearing = chats.clearChat(PEER)
      releaseSave?.()
      await Promise.all([sending, clearing])
      messageStore.saveMessage.mockImplementation(originalSave)

      expect(only(chats)).toEqual([])
      expect(only(await reload())).toEqual([])
    })

    it('a send queued after Clear remains both visible and durable', async () => {
      jest
        .spyOn(activeChain.directMessages, 'send')
        .mockRejectedValue(new Error('offline'))
      const chats = useChatStore()
      await chats.sendMessage({ wallet, address: PEER, items: TEXT })
      // Clear's durable write: the row is dropped and its tombstone written in one call.
      const messageStore = (await messageStorePromise) as unknown as {
        suppressAndDelete: jest.Mock
      }
      const originalDelete =
        messageStore.suppressAndDelete.getMockImplementation()
      let clearStarted: (() => void) | undefined
      const started = new Promise<void>(resolve => {
        clearStarted = resolve
      })
      let releaseClear: (() => void) | undefined
      const gate = new Promise<void>(resolve => {
        releaseClear = resolve
      })
      messageStore.suppressAndDelete.mockImplementation(
        async (...args: unknown[]) => {
          clearStarted?.()
          await gate
          return originalDelete?.(...args)
        },
      )

      const clearing = chats.clearChat(PEER)
      await started
      const sending = chats.sendMessage({ wallet, address: PEER, items: TEXT })
      releaseClear?.()
      await Promise.all([clearing, sending])
      messageStore.suppressAndDelete.mockImplementation(originalDelete)

      expect(only(chats)).toHaveLength(1)
      expect(only(await reload())).toHaveLength(1)
    })
  })

  describe('F1: an attempt that could not be recorded is never re-paid unconfirmed', () => {
    /** The wallet journaled a payment set, and the durable write attributing it to the message
     * fails (as it does when local storage is full or broken). */
    async function failDigestWrites() {
      const db = await durable()
      const store = (await messageStorePromise) as unknown as {
        saveMessage: jest.Mock
      }
      const original = store.saveMessage.getMockImplementation()
      store.saveMessage.mockImplementation(
        async (wrapper: MessageWrapper, options?: unknown) => {
          if (wrapper.message.delivery?.attemptDigest !== undefined) {
            throw new Error('disk full')
          }
          return original?.(wrapper, options)
        },
      )
      return () => {
        store.saveMessage.mockImplementation(original)
        return db
      }
    }

    it('layer (a): a failed attribution write aborts relay submission and retains the known attempt', async () => {
      const restore = await failDigestWrites()
      let reachedRelay = false
      const send = jest
        .spyOn(activeChain.directMessages, 'send')
        .mockImplementation(async (params: SendParams) => {
          // Like the wallet: a failing callback aborts the send before any PUT.
          await params.onAttemptCreated?.(HASH)
          reachedRelay = true
          return okResult(HASH)
        })
      const chats = useChatStore()
      const outcome = await chats.sendMessage({
        wallet,
        address: PEER,
        items: TEXT,
      })
      expect(reachedRelay).toBe(false)
      expect(outcome).toEqual(expect.objectContaining({ state: 'failed' }))
      restore()
      // The dead status alone does not prove that the journaled payment cannot land.
      jest
        .spyOn(activeChain.directMessages, 'reconcileAttempts')
        .mockResolvedValue({ [HASH]: 'dead' })
      await expect(
        chats.retryOutgoing({
          wallet,
          address: PEER,
          payloadDigest: only(chats)[0].payloadDigest,
        }),
      ).resolves.toEqual({ state: 'failed', reason: 'rejected' })
      expect(send).toHaveBeenCalledTimes(1)
      expect(only(chats)[0].delivery?.attemptDigest).toBe(HASH)
    })

    it('layer (b), the reviewer repro: a fail-open wallet plus a lost digest write still cannot re-pay an interrupted message without confirmation', async () => {
      // Fail-open wallet (the old behaviour) with a failing digest write: the payment set was
      // journaled and may be submitted, yet the message was stored with no attempt digest and
      // the app then stopped.
      await seedInterrupted()
      const send = jest.spyOn(activeChain.directMessages, 'send')

      const restored = await reload()
      const [message] = only(restored)
      expect(message.status).toBe('error')
      expect(message.delivery).toEqual(
        expect.objectContaining({ failureReason: 'interrupted' }),
      )
      expect(message.delivery?.attemptDigest).toBeUndefined() // the digest was lost

      // The wallet still accounts for a payment no message points at (journaled / resumed).
      const unattributed = jest
        .spyOn(activeChain.directMessages, 'unattributedAttempts')
        .mockResolvedValue([HASH])
      const reconcile = jest.spyOn(
        activeChain.directMessages,
        'reconcileAttempts',
      )
      await expect(
        restored.retryOutgoing({
          wallet,
          address: PEER,
          payloadDigest: message.payloadDigest,
        }),
      ).resolves.toEqual({ state: 'needs-confirmation', reason: 'unverified' })
      expect(send).not.toHaveBeenCalled() // no second payment
      expect(unattributed).toHaveBeenCalledWith(
        expect.objectContaining({ wallet }),
      )
      // Asking again without confirming is still refused (the check repeats).
      await expect(
        restored.retryOutgoing({
          wallet,
          address: PEER,
          payloadDigest: message.payloadDigest,
        }),
      ).resolves.toEqual({ state: 'needs-confirmation', reason: 'unverified' })
      expect(send).not.toHaveBeenCalled()
      expect(reconcile).not.toHaveBeenCalled()

      send.mockResolvedValueOnce(okResult('78'.repeat(32)))
      await expect(
        restored.retryOutgoing({
          wallet,
          address: PEER,
          payloadDigest: message.payloadDigest,
          confirmed: true,
        }),
      ).resolves.toEqual({ state: 'sent', payloadDigest: '78'.repeat(32) })
    })

    // The wallet as the app sees it: a delivered payment nobody points at stays reported in every
    // session until the user's answer is saved. `reload()` is a new app session over this state.
    function durableOrphan() {
      let reported = [HASH]
      const unattributed = jest
        .spyOn(activeChain.directMessages, 'unattributedAttempts')
        .mockImplementation(async () => [...reported])
      const resolve = jest
        .spyOn(activeChain.directMessages, 'resolveUnattributedAttempts')
        .mockImplementation(async ({ payloadDigests }) => {
          reported = reported.filter(digest => !payloadDigests.includes(digest))
        })
      const send = jest.spyOn(activeChain.directMessages, 'send')
      return { unattributed, resolve, send }
    }

    it('an unconfirmed Retry keeps asking across reloads and never pays or saves an answer', async () => {
      await seedInterrupted()
      const { resolve, send } = durableOrphan()
      for (let session = 0; session < 3; session++) {
        const restored = await reload()
        await expect(
          restored.retryOutgoing({
            wallet,
            address: PEER,
            payloadDigest: only(restored)[0].payloadDigest,
          }),
        ).resolves.toEqual({
          state: 'needs-confirmation',
          reason: 'unverified',
        })
      }
      expect(send).not.toHaveBeenCalled()
      expect(resolve).not.toHaveBeenCalled()
    })

    it('a confirmed Retry saves the answer before it pays, so the same payment does not block a later message', async () => {
      await seedInterrupted()
      const { resolve, send } = durableOrphan()
      const restored = await reload()
      const order: string[] = []
      resolve.mockImplementationOnce(async () => void order.push('resolve'))
      send.mockImplementationOnce(async () => {
        order.push('send')
        return okResult('78'.repeat(32))
      })
      await expect(
        restored.retryOutgoing({
          wallet,
          address: PEER,
          payloadDigest: only(restored)[0].payloadDigest,
          confirmed: true,
        }),
      ).resolves.toEqual({ state: 'sent', payloadDigest: '78'.repeat(32) })
      expect(resolve).toHaveBeenCalledTimes(1)
      expect(resolve).toHaveBeenCalledWith({ wallet, payloadDigests: [HASH] })
      expect(order).toEqual(['resolve', 'send'])
      expect(send).toHaveBeenCalledTimes(1)
    })

    it('after the answer is saved, another interrupted message in a later session retries without a prompt', async () => {
      await seedInterrupted()
      const { resolve, send } = durableOrphan()
      let restored = await reload()
      send.mockResolvedValueOnce(okResult('78'.repeat(32)))
      await restored.retryOutgoing({
        wallet,
        address: PEER,
        payloadDigest: only(restored)[0].payloadDigest,
        confirmed: true,
      })
      await seedInterrupted()
      restored = await reload()
      const second = only(restored).find(
        message => message.delivery?.failureReason === 'interrupted',
      )!
      send.mockResolvedValueOnce(okResult('9a'.repeat(32)))
      await expect(
        restored.retryOutgoing({
          wallet,
          address: PEER,
          payloadDigest: second.payloadDigest,
        }),
      ).resolves.toEqual({ state: 'sent', payloadDigest: '9a'.repeat(32) })
      expect(resolve).toHaveBeenCalledTimes(1)
      expect(send).toHaveBeenCalledTimes(2)
    })

    it('a confirmed Retry whose check failed pays once and saves no answer it could not see', async () => {
      await seedInterrupted()
      const restored = await reload()
      jest
        .spyOn(activeChain.directMessages, 'unattributedAttempts')
        .mockRejectedValue(new Error('journal unreadable'))
      const resolve = jest.spyOn(
        activeChain.directMessages,
        'resolveUnattributedAttempts',
      )
      jest
        .spyOn(activeChain.directMessages, 'send')
        .mockResolvedValueOnce(okResult('78'.repeat(32)))
      await expect(
        restored.retryOutgoing({
          wallet,
          address: PEER,
          payloadDigest: only(restored)[0].payloadDigest,
          confirmed: true,
        }),
      ).resolves.toEqual({ state: 'sent', payloadDigest: '78'.repeat(32) })
      expect(resolve).not.toHaveBeenCalled()
    })

    it('an interrupted message with provably no unattributed payment retries without a prompt', async () => {
      await seedInterrupted()
      const restored = await reload()
      jest
        .spyOn(activeChain.directMessages, 'unattributedAttempts')
        .mockResolvedValue([])
      jest
        .spyOn(activeChain.directMessages, 'send')
        .mockResolvedValue(okResult('9a'.repeat(32)))
      await expect(
        restored.retryOutgoing({
          wallet,
          address: PEER,
          payloadDigest: only(restored)[0].payloadDigest,
        }),
      ).resolves.toEqual({ state: 'sent', payloadDigest: '9a'.repeat(32) })
    })

    it('if the unattributed-payment check itself fails, it asks rather than pays', async () => {
      await seedInterrupted()
      const restored = await reload()
      jest
        .spyOn(activeChain.directMessages, 'unattributedAttempts')
        .mockRejectedValue(new Error('journal unreadable'))
      const send = jest.spyOn(activeChain.directMessages, 'send')
      await expect(
        restored.retryOutgoing({
          wallet,
          address: PEER,
          payloadDigest: only(restored)[0].payloadDigest,
        }),
      ).resolves.toEqual({ state: 'needs-confirmation', reason: 'unverified' })
      expect(send).not.toHaveBeenCalled()
    })
  })

  describe('rehydrating stored records', () => {
    it('a persisted pending record WITH an attempt digest comes back payment-pending, keeping the digest', async () => {
      const db = await durable()
      db.set(
        'pending:1:1:zz',
        serializeMessageWrapper({
          index: 'pending:1:1:zz',
          outbound: true,
          senderAddress: ME,
          copartyAddress: PEER,
          message: {
            conversationId: STORED_CONVERSATION_ID,
            outbound: true,
            status: 'pending',
            receivedTime: 1,
            serverTime: 1,
            items: TEXT,
            outpoints: [],
            senderAddress: ME,
            delivery: { attemptDigest: HASH },
          },
        }),
      )
      const [message] = only(await reload())
      expect(message.status).toBe('payment-pending')
      expect(message.delivery).toEqual({ attemptDigest: HASH })
    })

    it('an explicitly owned confirmed record may omit delivery state', async () => {
      const db = await durable()
      db.set(
        'old',
        JSON.stringify({
          index: 'old',
          outbound: true,
          senderAddress: ME,
          copartyAddress: PEER,
          message: {
            conversationId: STORED_CONVERSATION_ID,
            outbound: true,
            status: 'confirmed',
            receivedTime: 5,
            serverTime: 5,
            items: TEXT,
            outpoints: [],
            senderAddress: ME,
          },
        }),
      )
      const [message] = only(await reload())
      expect(message).toEqual(
        expect.objectContaining({
          payloadDigest: 'old',
          status: 'confirmed',
          items: TEXT,
        }),
      )
      expect(message.delivery).toBeUndefined()
    })
  })

  describe('the in-memory live flag', () => {
    async function pendingLive() {
      sendJournalsThenPending()
      const chats = useChatStore()
      await chats.sendMessage({ wallet, address: PEER, items: TEXT })
      expect(only(chats)[0].delivery?.live).toBe(true)
      return chats
    }

    it.each([
      ['dead', 'rejected'],
      ['unknown', 'unverified'],
    ] as const)(
      'is cleared when the attempt turns out %s (the delivery record is replaced, not merged)',
      async (status, reason) => {
        const chats = await pendingLive()
        reconcileReturns({ [HASH]: status })
        await chats.reconcileOutgoing({ wallet })
        expect(only(chats)[0].status).toBe('error')
        expect(only(chats)[0].delivery?.failureReason).toBe(reason)
        expect(only(chats)[0].delivery?.live).toBeUndefined()
      },
    )

    it('is cleared when a later send fails', async () => {
      const chats = await pendingLive()
      const id = only(chats)[0].payloadDigest
      // Manual retry path: an error state that had been live must not keep the flag.
      only(chats)[0].status = 'error'
      reconcileReturns({ [HASH]: 'dead' })
      jest
        .spyOn(activeChain.directMessages, 'send')
        .mockRejectedValue(new Error('boom'))
      await chats.retryOutgoing({ wallet, address: PEER, payloadDigest: id })
      expect(only(chats)[0].delivery?.live).toBeUndefined()
    })

    it('after a reload the text starts as checking (not live); a reconcile that says live moves it to live, once', async () => {
      await pendingLive()
      const restored = await reload()
      expect(only(restored)[0].status).toBe('payment-pending')
      expect(only(restored)[0].delivery).toEqual({ attemptDigest: HASH })
      expect(only(restored)[0].delivery?.live).toBeUndefined() // "Checking payment status"

      const store = (await messageStorePromise) as unknown as {
        saveMessage: jest.Mock
      }
      reconcileReturns({ [HASH]: 'live' }, { [HASH]: 'live' })
      store.saveMessage.mockClear()
      await restored.reconcileOutgoing({ wallet })
      expect(only(restored)[0].delivery?.live).toBe(true) // "will not be charged again"
      const writesAfterFirst = store.saveMessage.mock.calls.length
      expect(writesAfterFirst).toBeGreaterThan(0)
      // Already live: a further reconcile must not rewrite the record every tick.
      await restored.reconcileOutgoing({ wallet })
      expect(store.saveMessage.mock.calls.length).toBe(writesAfterFirst)
      // And the flag itself is never persisted.
      const stored = deserializeMessageWrapper(
        (await durable()).get(only(restored)[0].payloadDigest) as string,
      )
      expect(stored.message.delivery).toEqual({ attemptDigest: HASH })
    })
  })

  describe('strict attribution writes', () => {
    it('a record that vanished mid-send makes the attribution fail, so the wallet rolls the attempt back', async () => {
      let callbackError: unknown
      jest
        .spyOn(activeChain.directMessages, 'send')
        .mockImplementation(async (params: SendParams) => {
          // The user discards the message while it is still being prepared.
          const chats = useChatStore()
          await chats.deleteMessage({
            address: PEER,
            payloadDigest: only(chats)[0].payloadDigest,
          })
          try {
            await params.onAttemptCreated?.(HASH)
          } catch (error) {
            callbackError = error
            throw error
          }
          return okResult(HASH)
        })
      await useChatStore().sendMessage({ wallet, address: PEER, items: TEXT })
      expect(callbackError).toEqual(
        expect.objectContaining({
          message: expect.stringContaining('no longer exists'),
        }),
      )
    })
  })

  // The human dealer path: a blackjack message is an ordinary outgoing message, so closing the
  // window mid-send leaves it in the chat, counted by the hand, and not delivered. "Reload" is a
  // fresh store over what was durably written.
  describe('a blackjack message cut off by closing the window', () => {
    const GAME = '0123456789abcdef0123456789abcdef'
    const DEAL = [
      {
        type: 'blackjack-hand' as const,
        gameId: GAME,
        seq: 2,
        prev: '02'.repeat(32),
        action: 'deal' as const,
        link: 'c'.repeat(64),
        playerCards: [1, 2],
        dealerUpCard: 3,
      },
    ]
    const BET = [
      {
        type: 'blackjack-hand' as const,
        gameId: GAME,
        seq: 1,
        prev: '01'.repeat(32),
        action: 'bet' as const,
        commitment: 'b'.repeat(64),
      },
    ]
    /** The hand's earlier messages, already delivered: this user dealing (a challenge as dealer
     * and the peer's bet) or playing (the peer's challenge as dealer). */
    const handBefore = (role: 'dealer' | 'player') => {
      const challenge = {
        outbound: role === 'dealer',
        status: 'confirmed',
        items: [
          {
            type: 'blackjack-hand' as const,
            gameId: GAME,
            seq: 0,
            action: 'challenge' as const,
            role: 'dealer' as const,
            maxBetWei: '500',
            commitment: 'c'.repeat(64),
          },
        ],
        stampValueWei: 1n,
        payloadDigest: '01'.repeat(32),
      }
      const bet = {
        outbound: false,
        status: 'confirmed',
        items: BET,
        stampValueWei: 300n,
        payloadDigest: '02'.repeat(32),
      }
      return role === 'dealer' ? [challenge, bet] : [challenge]
    }
    const resume = (
      chats: ReturnType<typeof useChatStore>,
      role: 'dealer' | 'player' = 'dealer',
    ) =>
      resumeHandMessages({
        store: chats as unknown as HandResumeStore,
        wallet,
        address: PEER,
        own: ME,
        messages: [...handBefore(role), ...only(chats)],
        attempted: new Set(),
        ordinaryStampWei: 1_000_000_000_000n,
      })
    /** The app stops while `send` is in flight; `journaled` says whether the wallet had
     * already recorded the message's payment set. */
    async function killedMidSend(
      items: typeof DEAL | typeof BET,
      journaled: string | undefined,
      stampValue?: bigint,
    ) {
      let stop: (error: Error) => void = () => undefined
      jest
        .spyOn(activeChain.directMessages, 'send')
        .mockImplementation(async (params: SendParams) => {
          if (journaled) await params.onAttemptCreated?.(journaled)
          return new Promise((_, reject) => {
            stop = reject
          })
        })
      void useChatStore().sendMessage({
        wallet,
        address: PEER,
        items,
        ...(stampValue === undefined ? {} : { stampValue }),
      })
      await new Promise(resolve => setImmediate(resolve))
      // The process dies here. What is durable at this instant is all that survives; the dying
      // instance is let go afterwards and whatever it would still have written is dropped.
      const db = await durable()
      const survived = new Map(db)
      stop(new Error('process killed'))
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
      db.clear()
      survived.forEach((value, key) => db.set(key, value))
      jest.restoreAllMocks()
      jest.spyOn(console, 'warn').mockImplementation(() => undefined)
      return reload()
    }

    it('killed between "message saved" and the PUT: the deal is sent again on reopening, once', async () => {
      const restored = await killedMidSend(DEAL, undefined)
      expect(undeliveredHandMessages(only(restored), ME, PEER)).toEqual([
        expect.objectContaining({
          action: 'deal',
          state: 'failed',
          hasAttempt: false,
          carriesMoney: false,
        }),
      ])
      jest
        .spyOn(activeChain.directMessages, 'unattributedAttempts')
        .mockResolvedValue([])
      const send = jest
        .spyOn(activeChain.directMessages, 'send')
        .mockResolvedValue(okResult(HASH))
      expect(await resume(restored)).toBe(1)
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0][0].items).toEqual(DEAL)
      expect(only(restored)).toEqual([
        expect.objectContaining({ status: 'confirmed', payloadDigest: HASH }),
      ])
      expect(undeliveredHandMessages(only(restored), ME, PEER)).toEqual([])
      // Reopening again finds nothing to do.
      const again = await reload()
      expect(await resume(again)).toBe(0)
      expect(send).toHaveBeenCalledTimes(1)
    })

    it('killed after the payment set was recorded: the same bytes are delivered, no new payment', async () => {
      const restored = await killedMidSend(DEAL, HASH)
      expect(only(restored)[0]).toEqual(
        expect.objectContaining({ status: 'payment-pending' }),
      )
      const send = jest.spyOn(activeChain.directMessages, 'send')
      reconcileReturns({ [HASH]: 'delivered' })
      // Nothing for the hand to resume: the store's own reconciliation settles it.
      expect(await resume(restored)).toBe(0)
      await restored.reconcileOutgoing({ wallet })
      expect(only(restored)).toEqual([
        expect.objectContaining({ status: 'confirmed', payloadDigest: HASH }),
      ])
      expect(send).not.toHaveBeenCalled()
    })

    it('a cut-off deal is not sent while a payment nobody points at may exist', async () => {
      const restored = await killedMidSend(DEAL, undefined)
      jest
        .spyOn(activeChain.directMessages, 'unattributedAttempts')
        .mockResolvedValue(['ee'.repeat(32)])
      const send = jest.spyOn(activeChain.directMessages, 'send')
      await resume(restored)
      expect(send).not.toHaveBeenCalled()
      // Still shown as failed, with its Retry.
      expect(undeliveredHandMessages(only(restored), ME, PEER)).toEqual([
        expect.objectContaining({ state: 'failed' }),
      ])
    })

    it('a cut-off bet with no recorded payment is never sent by itself', async () => {
      const restored = await killedMidSend(BET, undefined, 40n)
      const send = jest.spyOn(activeChain.directMessages, 'send')
      const reconcile = jest.spyOn(
        activeChain.directMessages,
        'reconcileAttempts',
      )
      expect(await resume(restored, 'player')).toBe(0)
      expect(send).not.toHaveBeenCalled()
      expect(reconcile).not.toHaveBeenCalled()
      expect(undeliveredHandMessages(only(restored), ME, PEER)).toEqual([
        expect.objectContaining({
          action: 'bet',
          state: 'failed',
          carriesMoney: true,
        }),
      ])
    })

    it('a failed bet with a recorded payment is settled with the wallet: live bytes are re-sent, a dead payment is not replaced', async () => {
      for (const [status, after] of [
        ['delivered', 'confirmed'],
        ['live', 'payment-pending'],
        ['dead', 'error'],
        ['unknown', 'error'],
      ] as const) {
        ;(await durable()).clear()
        setActivePinia(createPinia())
        jest.restoreAllMocks()
        jest.spyOn(console, 'warn').mockImplementation(() => undefined)
        // A bet whose payment set exists and whose delivery could not be confirmed.
        jest
          .spyOn(activeChain.directMessages, 'send')
          .mockImplementation(async (params: SendParams) => {
            await params.onAttemptCreated?.(HASH)
            throw new MonadStampAbandonedError('abandoned', HASH)
          })
        const chats = useChatStore()
        await chats.sendMessage({
          wallet,
          address: PEER,
          items: BET,
          stampValue: 40n,
        })
        const restored = await reload()
        expect(only(restored)[0]).toEqual(
          expect.objectContaining({
            status: 'error',
            delivery: expect.objectContaining({ attemptDigest: HASH }),
          }),
        )
        jest.restoreAllMocks()
        jest.spyOn(console, 'warn').mockImplementation(() => undefined)
        const send = jest.spyOn(activeChain.directMessages, 'send')
        reconcileReturns({ [HASH]: status })
        await resume(restored, 'player')
        expect(send).not.toHaveBeenCalled()
        expect(only(restored)[0].status).toBe(after)
      }
    })

    it('two tabs: while tab A is sending a deal, tab B neither resumes nor retries it, and nothing is paid twice', async () => {
      const locks = new FakeLockManager()
      const uninstall = locks.install()
      try {
        let finish: (result: DirectMessageSendResult) => void = () => undefined
        const send = jest
          .spyOn(activeChain.directMessages, 'send')
          .mockImplementation(
            () =>
              new Promise<DirectMessageSendResult>(resolve => {
                finish = resolve
              }),
          )
        const unattributed = jest
          .spyOn(activeChain.directMessages, 'unattributedAttempts')
          .mockResolvedValue([])
        const tabA = useChatStore()
        const sentA = tabA.sendMessage({ wallet, address: PEER, items: DEAL })
        await new Promise(resolve => setImmediate(resolve))
        expect(send).toHaveBeenCalledTimes(1)
        // Tab B opens now: its copy of A's in-flight row is a message being sent. A holds the
        // message's lock, so B does not judge it (it is not called interrupted) and asks nothing.
        const tabB = await reload()
        const [inB] = only(tabB)
        expect(inB).toEqual(
          expect.objectContaining({ status: 'pending', delivery: {} }),
        )
        const delivery = { ...inB.delivery }
        jest.spyOn(console, 'info').mockImplementation(() => undefined)
        expect(await resume(tabB)).toBe(0)
        // A Retry clicked in tab B (or an automatic one) is refused without touching the message.
        for (const automatic of [false, true]) {
          await expect(
            tabB.retryOutgoing({
              wallet,
              address: PEER,
              payloadDigest: inB.payloadDigest,
              automatic,
            }),
          ).resolves.toEqual({ state: 'busy' })
        }
        expect(only(tabB)[0].status).toBe('pending')
        expect(only(tabB)[0].delivery).toEqual(delivery)
        expect(send).toHaveBeenCalledTimes(1)
        expect(unattributed).not.toHaveBeenCalled()
        finish(okResult(HASH))
        await expect(sentA).resolves.toEqual({
          state: 'sent',
          payloadDigest: HASH,
        })
        expect(locks.held.size).toBe(0)
        // A delivered and let go. B's copy still says sending, with no payment recorded: the
        // durable row (gone now) tells B the truth at its next reconciliation.
        expect(await resume(tabB)).toBe(0)
        await expect(
          tabB.retryOutgoing({
            wallet,
            address: PEER,
            payloadDigest: inB.payloadDigest,
          }),
        ).resolves.toEqual({ state: 'busy' })
        await tabB.reconcileOutgoing({ wallet })
        expect(send).toHaveBeenCalledTimes(1)
        expect(unattributed).not.toHaveBeenCalled()
        // B dropped its stale copy instead of showing a failed deal that was delivered.
        expect(
          only(tabB).some(m => m.payloadDigest === inB.payloadDigest),
        ).toBe(false)
      } finally {
        uninstall()
      }
    })

    it('a Retry whose stored row has meanwhile recorded a payment settles that payment instead of paying again', async () => {
      const restored = await killedMidSend(DEAL, undefined)
      const [inB] = only(restored)
      expect(inB.delivery?.attemptDigest).toBeUndefined()
      // Another tab recorded this message's payment set after this tab loaded.
      const db = await durable()
      const row = deserializeMessageWrapper(db.get(inB.payloadDigest) as string)
      row.message.status = 'pending'
      row.message.delivery = { attemptDigest: HASH }
      db.set(inB.payloadDigest, serializeMessageWrapper(row))
      const send = jest.spyOn(activeChain.directMessages, 'send')
      const unattributed = jest.spyOn(
        activeChain.directMessages,
        'unattributedAttempts',
      )
      const reconcile = reconcileReturns({ [HASH]: 'live' })
      // An automatic retry leaves it to the background settling; a click settles it now.
      await expect(
        restored.retryOutgoing({
          wallet,
          address: PEER,
          payloadDigest: inB.payloadDigest,
          automatic: true,
        }),
      ).resolves.toEqual({ state: 'busy' })
      expect(only(restored)[0]).toEqual(
        expect.objectContaining({
          status: 'payment-pending',
          delivery: expect.objectContaining({ attemptDigest: HASH }),
        }),
      )
      only(restored)[0].status = 'error'
      await expect(
        restored.retryOutgoing({
          wallet,
          address: PEER,
          payloadDigest: inB.payloadDigest,
        }),
      ).resolves.toEqual({ state: 'payment-pending' })
      expect(reconcile).toHaveBeenCalledWith(
        expect.objectContaining({ payloadDigests: [HASH] }),
      )
      expect(send).not.toHaveBeenCalled()
      expect(unattributed).not.toHaveBeenCalled()
    })

    it("a new message's lock is already held when its row is first saved", async () => {
      const locks = new FakeLockManager()
      const uninstall = locks.install()
      const messageStore = (await messageStorePromise) as unknown as {
        saveMessage: jest.Mock
      }
      const original = messageStore.saveMessage.getMockImplementation()
      const heldAtSave: boolean[] = []
      messageStore.saveMessage.mockImplementation(
        async (wrapper: MessageWrapper) => {
          if (wrapper.index.startsWith('pending:'))
            heldAtSave.push(locks.held.has(outgoingLockName(wrapper.index)))
          return original?.(wrapper)
        },
      )
      try {
        jest
          .spyOn(activeChain.directMessages, 'send')
          .mockResolvedValue(okResult(HASH))
        await expect(
          useChatStore().sendMessage({ wallet, address: PEER, items: DEAL }),
        ).resolves.toEqual({ state: 'sent', payloadDigest: HASH })
        expect(heldAtSave.length).toBeGreaterThan(0)
        expect(heldAtSave.every(Boolean)).toBe(true)
        expect(locks.held.size).toBe(0)
      } finally {
        if (original) messageStore.saveMessage.mockImplementation(original)
        uninstall()
      }
    })

    it('another tab holding the message lock is all that stops a second payment; once it lets go a Retry works', async () => {
      // Here this module's in-tab bookkeeping knows nothing of the other tab: only its Web Lock
      // (as a separate tab mid-send would hold it) says the message is being sent.
      const restored = await killedMidSend(DEAL, undefined)
      const [inB] = only(restored)
      const locks = new FakeLockManager()
      const uninstall = locks.install()
      try {
        const release = locks.hold(outgoingLockName(inB.payloadDigest))
        const send = jest
          .spyOn(activeChain.directMessages, 'send')
          .mockResolvedValue(okResult(HASH))
        const unattributed = jest
          .spyOn(activeChain.directMessages, 'unattributedAttempts')
          .mockResolvedValue([])
        jest.spyOn(console, 'info').mockImplementation(() => undefined)
        const delivery = { ...inB.delivery }
        expect(await resume(restored)).toBe(0)
        for (const automatic of [false, true]) {
          await expect(
            restored.retryOutgoing({
              wallet,
              address: PEER,
              payloadDigest: inB.payloadDigest,
              automatic,
            }),
          ).resolves.toEqual({ state: 'busy' })
        }
        expect(only(restored)[0].delivery).toEqual(delivery)
        expect(send).not.toHaveBeenCalled()
        expect(unattributed).not.toHaveBeenCalled()
        release()
        await new Promise(resolve => setImmediate(resolve))
        await expect(
          restored.retryOutgoing({
            wallet,
            address: PEER,
            payloadDigest: inB.payloadDigest,
          }),
        ).resolves.toEqual({ state: 'sent', payloadDigest: HASH })
        expect(send).toHaveBeenCalledTimes(1)
      } finally {
        uninstall()
      }
    })

    it('without the Web Locks API a send still runs (in-tab protection only)', async () => {
      const g = globalThis as { navigator?: unknown }
      const before = Object.getOwnPropertyDescriptor(g, 'navigator')
      Object.defineProperty(g, 'navigator', {
        configurable: true,
        writable: true,
        value: {},
      })
      try {
        jest
          .spyOn(activeChain.directMessages, 'send')
          .mockResolvedValue(okResult(HASH))
        await expect(
          useChatStore().sendMessage({ wallet, address: PEER, items: DEAL }),
        ).resolves.toEqual({ state: 'sent', payloadDigest: HASH })
      } finally {
        if (before) Object.defineProperty(g, 'navigator', before)
        else delete g.navigator
      }
    })

    describe('an automatic retry never builds a payment a click would have to decide', () => {
      /** A deal whose payment set was recorded and then given up by the wallet. */
      async function failedWithAttempt() {
        jest
          .spyOn(activeChain.directMessages, 'send')
          .mockImplementation(async (params: SendParams) => {
            await params.onAttemptCreated?.(HASH)
            throw new MonadStampAbandonedError('abandoned', HASH)
          })
        const chats = useChatStore()
        await chats.sendMessage({ wallet, address: PEER, items: DEAL })
        jest.restoreAllMocks()
        jest.spyOn(console, 'warn').mockImplementation(() => undefined)
        const [message] = only(chats)
        expect(message.delivery?.attemptDigest).toBe(HASH)
        return { chats, id: message.payloadDigest }
      }

      it('after a dead report: neither automatic retries nor a click replace the earlier payment', async () => {
        const { chats, id } = await failedWithAttempt()
        const send = jest
          .spyOn(activeChain.directMessages, 'send')
          .mockResolvedValue(okResult('cd'.repeat(32)))
        jest
          .spyOn(activeChain.directMessages, 'unattributedAttempts')
          .mockResolvedValue([])
        reconcileReturns(
          { [HASH]: 'dead' },
          { [HASH]: 'dead' },
          { [HASH]: 'dead' },
        )
        const retry = (automatic: boolean) =>
          chats.retryOutgoing({
            wallet,
            address: PEER,
            payloadDigest: id,
            automatic,
          })
        await expect(retry(true)).resolves.toEqual({
          state: 'failed',
          reason: 'rejected',
        })
        expect(only(chats)[0]).toEqual(
          expect.objectContaining({
            status: 'error',
            delivery: expect.objectContaining({ failureReason: 'rejected' }),
          }),
        )
        // The recorded attempt remains associated on every subsequent retry.
        await expect(retry(true)).resolves.toEqual({
          state: 'failed',
          reason: 'rejected',
        })
        expect(send).not.toHaveBeenCalled()
        await expect(retry(false)).resolves.toEqual({
          state: 'failed',
          reason: 'rejected',
        })
        expect(send).not.toHaveBeenCalled()
        expect(only(chats)[0].delivery?.attemptDigest).toBe(HASH)
      })

      it('when the earlier payment cannot be accounted for: no new payment, even if `confirmed` is passed', async () => {
        const { chats, id } = await failedWithAttempt()
        const send = jest.spyOn(activeChain.directMessages, 'send')
        reconcileReturns({ [HASH]: 'unknown' }, { [HASH]: 'unknown' })
        for (const confirmed of [false, true]) {
          const outcome = await chats.retryOutgoing({
            wallet,
            address: PEER,
            payloadDigest: id,
            automatic: true,
            confirmed,
          })
          expect(outcome).toEqual({ state: 'failed', reason: 'unverified' })
        }
        expect(send).not.toHaveBeenCalled()
        expect(only(chats)[0].delivery?.attemptDigest).toBe(HASH)
      })

      it('a failed message that was not cut off mid-send and has no recorded payment is left as it is', async () => {
        jest
          .spyOn(activeChain.directMessages, 'send')
          .mockRejectedValue(new Error('relay said no'))
        const chats = useChatStore()
        await chats.sendMessage({ wallet, address: PEER, items: DEAL })
        jest.restoreAllMocks()
        const [message] = only(chats)
        expect(message.status).toBe('error')
        expect(message.delivery?.attemptDigest).toBeUndefined()
        expect(message.delivery?.failureReason).not.toBe('interrupted')
        const delivery = { ...message.delivery }
        const send = jest.spyOn(activeChain.directMessages, 'send')
        const unattributed = jest.spyOn(
          activeChain.directMessages,
          'unattributedAttempts',
        )
        const outcome = await chats.retryOutgoing({
          wallet,
          address: PEER,
          payloadDigest: message.payloadDigest,
          automatic: true,
        })
        expect(outcome.state).toBe('failed')
        expect(send).not.toHaveBeenCalled()
        expect(unattributed).not.toHaveBeenCalled()
        expect(only(chats)[0].delivery).toEqual(delivery)
      })
    })
  })
})

describe('financial outbox envelope barrier', () => {
  const financialOperations = [
    { chainIdentifier: 'xec-testnet', operationId: 'xec-payment' },
    { chainIdentifier: 'monad-testnet', operationId: 'token-payment' },
  ]
  let expose: jest.Mock, submit: jest.Mock
  beforeEach(async () => {
    ;(await durable()).clear()
    setActivePinia(createPinia())
    jest.restoreAllMocks()
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    expose = jest.fn(async () => undefined)
    submit = jest.fn(async () => undefined)
    jest
      .mocked(captureOutgoingFinancialOperations)
      .mockReset()
      .mockResolvedValue({ expose, submit })
  })
  const params = () => ({
    wallet,
    address: PEER,
    items: TEXT,
    financialOperations,
    stampValue: 0n,
  })

  it('passes the captured payment operation into stamp construction after saving the financial draft', async () => {
    jest.mocked(captureOutgoingFinancialOperations).mockResolvedValue({
      expose,
      submit,
      paymentOperationId: 'original-native-payment',
    })
    const refs = [
      {
        chainIdentifier: 'monad-testnet',
        operationId: 'original-native-payment',
      },
    ]
    const send = jest
      .spyOn(activeChain.directMessages, 'send')
      .mockImplementation(async p => {
        expect(p.paymentOperationId).toBe('original-native-payment')
        const saved = [...(await durable()).values()].map(
          deserializeMessageWrapper,
        )[0]
        expect(saved.message.financialOperations).toEqual(refs)
        expect(saved.message.sealedMessageId).toBe(p.messageId)
        expect(expose).not.toHaveBeenCalled()
        await p.onEnvelopeDurable?.(HASH)
        expect(expose).toHaveBeenCalledWith(HASH)
        return okResult(HASH)
      })
    const chats = useChatStore()
    await chats.sendMessage({
      ...params(),
      financialOperations: refs,
      stampValue: 7n,
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('requires an explicit reviewed stamp before creating a financial draft', async () => {
    const chats = useChatStore()
    await expect(
      chats.sendMessage({ ...params(), stampValue: undefined }),
    ).rejects.toThrow('explicit')
    expect(only(chats)).toEqual([])
    expect((await durable()).size).toBe(0)
  })

  it('requires the initial financial draft write before any sealing or exposure', async () => {
    const chats = useChatStore()
    const send = jest.spyOn(activeChain.directMessages, 'send')
    jest
      .spyOn(await messageStorePromise, 'saveMessage')
      .mockRejectedValueOnce(new Error('disk full'))
    await expect(chats.sendMessage(params())).rejects.toThrow('disk full')
    expect(send).not.toHaveBeenCalled()
    expect(expose).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it('retries partial binding of a free envelope with its persisted identity and retains refs through reopen/confirmation', async () => {
    let handoffs = 0
    const identities: unknown[] = []
    expose.mockRejectedValueOnce(new Error('second owner unavailable'))
    const send = jest
      .spyOn(activeChain.directMessages, 'send')
      .mockImplementation(async p => {
        identities.push(p.messageId)
        const rows = [...(await durable()).values()].map(
          deserializeMessageWrapper,
        )
        expect(rows[0].message.sealedMessageId).toBe(p.messageId)
        expect(rows[0].message.financialOperations).toEqual(financialOperations)
        await p.onEnvelopeDurable?.(HASH)
        const linked = [...(await durable()).values()].map(
          deserializeMessageWrapper,
        )[0]
        expect(linked.message.delivery?.attemptDigest).toBe(HASH)
        handoffs++
        return { ...okResult(HASH), stampValueWei: 0n }
      })
    const chats = useChatStore()
    expect((await chats.sendMessage(params())).state).toBe('failed')
    expect(handoffs).toBe(0)
    const reloaded = await reload({ askWallet: false })
    await reloaded.retryOutgoing({
      wallet,
      address: PEER,
      payloadDigest: only(reloaded)[0].payloadDigest,
    })
    expect(send).toHaveBeenCalledTimes(2)
    expect(identities[0]).toBe(identities[1])
    expect(expose).toHaveBeenNthCalledWith(1, HASH)
    expect(expose).toHaveBeenNthCalledWith(2, HASH)
    expect(submit).toHaveBeenCalledTimes(1)
    const confirmed = only(reloaded)[0]
    expect(confirmed.status).toBe('confirmed')
    expect(confirmed.financialOperations).toEqual(financialOperations)
    expect(confirmed.sealedMessageId).toBe(identities[0])
    const again = await reload({ askWallet: false })
    expect(only(again)[0].financialOperations).toEqual(financialOperations)
  })

  it('resumes a held paid attempt through its barrier and submits originals only after delivery', async () => {
    const send = jest
      .spyOn(activeChain.directMessages, 'send')
      .mockImplementation(async p => {
        await p.onEnvelopeDurable?.(HASH)
        throw new MonadStampPendingAttemptError([HASH])
      })
    const chats = useChatStore()
    await chats.sendMessage({ ...params(), stampValue: 1n })
    expect(submit).not.toHaveBeenCalled()
    const reloaded = await reload({ askWallet: false })
    const reconcile = jest
      .spyOn(activeChain.directMessages, 'reconcileAttempts')
      .mockImplementation(async p => {
        expect(p.payloadDigests).toEqual([HASH])
        await p.onEnvelopeDurable?.(HASH)
        expect(expose).toHaveBeenCalledTimes(2)
        return { [HASH]: 'delivered' }
      })
    await reloaded.reconcileOutgoing({ wallet })
    expect(send).toHaveBeenCalledTimes(1)
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(only(reloaded)[0].financialOperations).toEqual(financialOperations)
  })

  it('a failed payment submit after delivery is not sent; reconciliation submits the same operations again', async () => {
    const send = jest
      .spyOn(activeChain.directMessages, 'send')
      .mockImplementation(async p => {
        await p.onEnvelopeDurable?.(HASH)
        return okResult(HASH)
      })
    submit.mockRejectedValueOnce(new Error('indexer unreachable'))
    const chats = useChatStore()
    const outcome = await chats.sendMessage({ ...params(), stampValue: 1n })
    expect(outcome.state).toBe('payment-pending')
    expect(submit).toHaveBeenCalledTimes(1)
    expect(only(chats)[0].status).toBe('payment-pending')
    expect(only(chats)[0].delivery?.attemptDigest).toBe(HASH)
    // Durable too: a restart finds it pending, not sent.
    const reloaded = await reload({ askWallet: false })
    expect(only(reloaded)[0].status).toBe('payment-pending')
    // The submit fails again: still pending, and nothing new is sent or paid.
    const reconcile = reconcileReturns({ [HASH]: 'delivered' })
    submit.mockRejectedValueOnce(new Error('indexer unreachable'))
    await reloaded.reconcileOutgoing({ wallet })
    expect(only(reloaded)[0].status).toBe('payment-pending')
    // The chain is reachable again: the same captured operations are submitted, then sent.
    reconcile.mockResolvedValue({ [HASH]: 'delivered' })
    await reloaded.reconcileOutgoing({ wallet })
    expect(submit).toHaveBeenCalledTimes(3)
    expect(send).toHaveBeenCalledTimes(1)
    for (const [, references] of jest.mocked(captureOutgoingFinancialOperations)
      .mock.calls)
      expect(references).toEqual(financialOperations)
    expect(only(reloaded)[0].status).toBe('confirmed')
    expect(only(reloaded)[0].payloadDigest).toBe(HASH)
  })

  it('keeps the financial hold when the digest-link write fails before exposure', async () => {
    const chats = useChatStore()
    const save = jest.spyOn(await messageStorePromise, 'saveMessage')
    let handoffs = 0
    jest
      .spyOn(activeChain.directMessages, 'send')
      .mockImplementation(async p => {
        save.mockRejectedValueOnce(new Error('link write failed'))
        await p.onEnvelopeDurable?.(HASH)
        handoffs++
        return okResult(HASH)
      })
    expect((await chats.sendMessage(params())).state).toBe('failed')
    expect(handoffs).toBe(0)
    expect(expose).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    expect(only(chats)[0].financialOperations).toEqual(financialOperations)
  })
})

describe('financial UI cancellation', () => {
  it('removes presentation without exposing or releasing its prepared financial operation', async () => {
    ;(await durable()).clear()
    setActivePinia(createPinia())
    jest.restoreAllMocks()
    const expose = jest.fn(),
      submit = jest.fn()
    jest
      .mocked(captureOutgoingFinancialOperations)
      .mockResolvedValue({ expose, submit })
    const chats = useChatStore()
    jest
      .spyOn(activeChain.directMessages, 'send')
      .mockImplementation(async p => {
        await chats.deleteMessage({
          address: PEER,
          payloadDigest: only(chats)[0].payloadDigest,
        })
        await p.onEnvelopeDurable?.(HASH)
        throw new Error('must not hand off')
      })
    await chats.sendMessage({
      wallet,
      address: PEER,
      items: TEXT,
      stampValue: 0n,
      financialOperations: [
        { chainIdentifier: 'xec-testnet', operationId: 'held' },
      ],
    })
    expect(expose).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    expect(only(chats)).toEqual([])
  })
})

describe('persisted application message handoff', () => {
  const messageId = 'abababab-abab-5bab-8bab-abababababab'
  const localMessageKey = `pending:application:${messageId}`
  const conversationId = '11111111-1111-4111-8111-111111111111'
  const items = [
    {
      type: 'application' as const,
      itemType: 'synthetic-application',
      value: { exact: 'retained' },
    },
  ]
  const request = (stampValue: bigint, assertCurrent = () => undefined) => ({
    wallet,
    address: PEER,
    conversationId,
    localMessageKey,
    applicationAuthorization: {
      accountId: 'synthetic',
      intentKey: 'synthetic',
    },
    messageId,
    stampValue,
    items,
    assertCurrent,
  })
  beforeEach(async () => {
    ;(await durable()).clear()
    setActivePinia(createPinia())
    jest.restoreAllMocks()
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  it.each([false, true])(
    'reconstructs a missing row using the original %s paid/free attempt and never changes sealed identity',
    async paid => {
      const attempt = jest
        .spyOn(activeChain.directMessages, 'attemptOf')
        .mockResolvedValue({ payloadDigest: HASH, paid })
      const send = jest
        .spyOn(activeChain.directMessages, 'send')
        .mockResolvedValue({
          ...okResult(HASH),
          stampValueWei: paid ? 1000n : 0n,
        })
      const reconcile = reconcileReturns({
        [HASH]: 'delivered',
      })
      const chats = useChatStore()
      const outcome = await chats.deliverPersistedApplicationMessage(
        request(paid ? 1000n : 0n),
      )
      expect(attempt).toHaveBeenCalledWith({ wallet, messageId })
      expect(outcome.state).toBe('sent')
      if (paid) {
        expect(send).not.toHaveBeenCalled()
        expect(reconcile).toHaveBeenCalled()
      } else
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            messageId,
            stampValue: 0n,
            conversationId,
            items,
          }),
        )
      expect(only(chats)[0].sealedMessageId).toBe(messageId)
      // Deleting presentation and restarting never revokes the original application's authorization.
      await chats.deleteMessage({ address: PEER, payloadDigest: HASH })
      setActivePinia(createPinia())
      send.mockClear()
      reconcile.mockResolvedValue({
        [HASH]: 'delivered',
      })
      expect(
        (
          await useChatStore().deliverPersistedApplicationMessage(
            request(paid ? 1000n : 0n),
          )
        ).state,
      ).toBe('sent')
      expect(attempt).toHaveBeenCalledTimes(2)
      if (!paid)
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({ messageId, stampValue: 0n }),
        )
    },
  )
  it.each(['recipient', 'sender', 'conversation', 'stamp', 'items'])(
    'rejects a confirmed row with changed %s before trusting delivery or looking up a payment',
    async changed => {
      const chats = useChatStore()
      jest
        .spyOn(activeChain.directMessages, 'attemptOf')
        .mockResolvedValue(undefined)
      jest
        .spyOn(activeChain.directMessages, 'send')
        .mockResolvedValue({ ...okResult(HASH), stampValueWei: 0n })
      await chats.deliverPersistedApplicationMessage(request(0n))
      const db = await durable(),
        row = deserializeMessageWrapper(db.get(HASH)!)
      if (changed === 'recipient') row.copartyAddress = ME
      if (changed === 'sender') row.senderAddress = PEER
      if (changed === 'conversation')
        row.message.conversationId = '22222222-2222-4222-8222-222222222222'
      if (changed === 'stamp') row.message.stampValueWei = 1n
      if (changed === 'items') row.message.items = TEXT
      db.set(HASH, serializeMessageWrapper(row))
      jest.mocked(activeChain.directMessages.attemptOf!).mockClear()
      await expect(
        chats.deliverPersistedApplicationMessage(request(0n)),
      ).rejects.toThrow('conflict')
      expect(activeChain.directMessages.attemptOf).not.toHaveBeenCalled()
    },
  )
  it('revocation during original attempt lookup prevents preparation and leaves ordinary chat usable', async () => {
    const chats = useChatStore()
    let current = true
    jest
      .spyOn(activeChain.directMessages, 'attemptOf')
      .mockImplementation(async () => {
        current = false
        return undefined
      })
    const send = jest
      .spyOn(activeChain.directMessages, 'send')
      .mockResolvedValue(okResult(HASH))
    await expect(
      chats.deliverPersistedApplicationMessage(
        request(0n, () => {
          if (!current) throw new Error('revoked')
        }),
      ),
    ).rejects.toThrow('revoked')
    expect(send).not.toHaveBeenCalled()
    await chats.sendMessage({
      wallet,
      address: PEER,
      items: TEXT,
      stampValue: 0n,
    })
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('a duplicate tab cannot create a second row or attempt while the original key is held', async () => {
    const locks = new FakeLockManager(),
      restore = locks.install(),
      release = locks.hold(outgoingLockName(localMessageKey))
    const send = jest.spyOn(activeChain.directMessages, 'send')
    try {
      expect(
        (await useChatStore().deliverPersistedApplicationMessage(request(0n)))
          .state,
      ).toBe('busy')
      expect(send).not.toHaveBeenCalled()
      expect(await durable()).toHaveProperty('size', 0)
    } finally {
      release()
      restore()
    }
  })

  it('retries when CanonicalMessagingPendingError is thrown during popup directory startup and succeeds once ready', async () => {
    ;(await durable()).clear()
    setActivePinia(createPinia())
    jest.restoreAllMocks()
    const chats = useChatStore()
    let calls = 0
    jest
      .spyOn(activeChain.directMessages, 'send')
      .mockImplementation(async () => {
        calls++
        if (calls === 1) {
          const pendingErr = new Error(
            'Messaging cannot be used until the account directory entry is published',
          )
          pendingErr.name = 'CanonicalMessagingPendingError'
          throw pendingErr
        }
        return okResult(HASH)
      })
    const outcome = await chats.sendMessage({
      wallet,
      address: PEER,
      items: TEXT,
      stampValue: 0n,
    })
    expect(outcome.state).toBe('sent')
    expect(calls).toBe(2)
    expect(only(chats)[0].status).toBe('confirmed')
  })

  it('classifies OpenDirectoryError(unreachable) as unreachable rather than generic error', async () => {
    ;(await durable()).clear()
    setActivePinia(createPinia())
    jest.restoreAllMocks()
    const chats = useChatStore()
    jest.spyOn(activeChain.directMessages, 'send').mockImplementation(() => {
      const err = Object.assign(
        new Error('The relay could not be reached for a directory entry.'),
        {
          name: 'OpenDirectoryError',
          code: 'unreachable',
        },
      )
      return Promise.reject(err)
    })
    const outcome = await chats.sendMessage({
      wallet,
      address: PEER,
      items: TEXT,
      stampValue: 0n,
    })
    expect(outcome.state).toBe('failed')
    expect(only(chats)[0].status).toBe('error')
    expect(only(chats)[0].delivery?.failureReason).toBe('unreachable')
  })
})
