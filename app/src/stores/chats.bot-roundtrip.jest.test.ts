/** App send/store -> actual bot poll/handler/reply journal -> app receive/store.
 * Custody, signing, canonical originals and Level journals are real. Only host acquisition,
 * directory/profile publication and external node/relay I/O are synthetic. No direct-message
 * send/reconcile/fetch method is replaced. This characterizes the existing shared canonical
 * engine, not a shared host policy or native browser/extension rendering.
 */
import { createPinia, setActivePinia } from 'pinia'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { hexlify } from 'ethers'
import { toHex } from '@frank/codec'
import { conversationIdSalt } from '@frank/cashweb/relay/conversation-id'
import { LevelMessageStore } from '@frank/cashweb/relay/storage/level-storage'
import { restoreCanonicalRequest } from '@frank/cashweb/relay/canonical-dm-transport'
import { activeChain } from '@frank/wallet/chain'
import {
  installCanonicalDirectory,
  type CanonicalDirectory,
} from '@frank/wallet/chain/evm-chain'
import type { EvmChainWalletHandle } from '@frank/wallet/evm-wallet-handle'
import {
  fixture,
  roots,
  offlineChain,
  mockBalances,
  mailboxes,
  START_BALANCE,
  useProviderStandIns,
  type Fixture,
  type InboxRecord,
} from '@frank/wallet/chain/canonical-two-wallets.testutil'
import {
  LevelOutgoingMessageStore,
  type StoredMessage,
} from '@frank/wallet/storage/outgoing-message-store'
import { FrankBotHost } from '@frank/bot-framework/bot-host'
import {
  replyMessageId,
  type InboundOperationStore,
} from '@frank/bot-framework/inbound-operation-store'
import type { FrankBotDefinition } from '@frank/bot-framework/types'
import { useChatStore, setConversationIdSalt } from './chats'
import { useContactStore } from './contacts'
import { profilePubKeyFromBytes } from '../utils/profile-pubkey'
import { startDirectMessagePolling } from '../adapters/pinia-chain-adapter'

let mockFixture: Fixture | undefined
let mockStore: LevelMessageStore
let mockSession: ReturnType<
  typeof import('../accounts/session').createAccountSession
>
let mockBotWallet: EvmChainWalletHandle
let mockDirectoryEpoch = 0
let mockLoseBotAcknowledgment = false
let mockLostAcknowledgments = 0

jest.mock('../adapters/level-message-store', () => ({
  store: {
    then: (
      resolve: (store: LevelMessageStore) => unknown,
      reject: (error: unknown) => unknown,
    ) => Promise.resolve(mockStore).then(resolve, reject),
  },
}))
jest.mock('../accounts/session', () => ({
  get accountSession() {
    return mockSession
  },
  get accountStatus() {
    return mockSession?.state
  },
}))
jest.mock('../utils/notifications', () => ({ desktopNotify: jest.fn() }))
// Profile metadata publication is outside the message/financial boundary under test.
jest.mock('../utils/own-profile', () => ({
  syncOwnProfileWithRelay: async () => true,
}))
jest.mock('@frank/wallet/evm-provider', () =>
  jest
    .requireActual('@frank/wallet/chain/canonical-two-wallets.testutil')
    .offlineProviderModule(),
)
jest.mock('@frank/wallet/evm-http', () =>
  jest
    .requireActual('@frank/wallet/chain/canonical-two-wallets.testutil')
    .offlineHttpModule(),
)
jest.mock('@frank/cashweb/relay/mailbox-client', () =>
  jest
    .requireActual('@frank/wallet/chain/canonical-two-wallets.testutil')
    .offlineMailboxModule(),
)
// Inject the real fixture chain at the host's composition boundary, including its real wallet
// factory. Registration still admits its own durable account root and checks wallet ownership.
jest.mock('@frank/wallet/chain/evm-host', () => {
  const actual = jest.requireActual('@frank/wallet/chain/evm-host')
  return {
    ...actual,
    createRelayPricedEvmChain: (...args: unknown[]) =>
      mockFixture?.chain ?? actual.createRelayPricedEvmChain(...args),
  }
})
jest.mock('@frank/bot-framework/relay-profile-manager', () => ({
  RelayProfileManager: { registerProfile: async () => undefined },
}))
jest.mock('@frank/bot-framework/directory-manager', () => ({
  DirectoryManager: {
    create: ({ handle }: { handle: EvmChainWalletHandle }) => {
      let directory: CanonicalDirectory
      return {
        network: 'monad-testnet',
        get rawDirectory() {
          return directory
        },
        async publishWithRetry() {
          if (!mockFixture) throw new Error('Missing test fixture')
          mockBotWallet = handle
          const account = (await handle.getReceiveAddress()).raw.toLowerCase()
          if (!mockBalances.has(account))
            mockBalances.set(account, START_BALANCE)
          const original = await mockFixture.directoryFor(
            `bot-${mockDirectoryEpoch++}`,
            handle,
            mockFixture.alice,
          )
          directory = {
            ...original,
            async fetch(url, init) {
              const response = await original.fetch!(url, init)
              if (mockLoseBotAcknowledgment) {
                mockLoseBotAcknowledgment = false
                mockLostAcknowledgments++
                throw new Error(
                  'Synthetic lost reply acknowledgment after relay storage',
                )
              }
              return response
            },
          }
        },
        startHeartbeat() {
          // Synthetic publication has no background heartbeat.
        },
        async lookupPeer() {
          return undefined
        },
        async close() {
          // Synthetic publication owns no external connection.
        },
      }
    },
  },
}))

type ObservedHost = {
  pollAllBots(): Promise<void>
  instances: Map<
    string,
    {
      wallet: EvmChainWalletHandle
      operations: InboundOperationStore
      tasks: Set<Promise<unknown>>
    }
  >
}
// Read-only test observation of the actual host's private scheduler/journal, not a replacement.
const observed = (host: FrankBotHost) => host as unknown as ObservedHost
const STAMP = 300_000n
const CONVERSATIONS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
]

async function sessionFor(wallet: EvmChainWalletHandle) {
  const { createAccountSession } = jest.requireActual<
    typeof import('../accounts/session')
  >('../accounts/session')
  const account = {
    displayName: 'Synthetic app account',
    descriptor: 'public',
    receipt: {
      operationId: 'synthetic',
      context: { accountId: 'synthetic-app' },
    },
  }
  const material = roots(0)
  const session = createAccountSession({
    open: async () =>
      ({
        snapshot: async () => ({
          schema: 1,
          revision: 1,
          active: account,
          pending: null,
        }),
        reconcile: async () => 'ready',
        openActive: async () => ({
          account,
          close() {
            // Synthetic account lease owns no external resource.
          },
          takeRoots: () => Object.values(material),
        }),
        close() {
          // Synthetic custody owns no external resource.
        },
      } as unknown as import('../accounts/custody').AccountCustody),
    createWallet: async () =>
      wallet as import('../accounts/session').RuntimeWallet,
  })
  await session.initialize()
  return session
}

async function pollBot(host: FrankBotHost) {
  await observed(host).pollAllBots()
  const instance = observed(host).instances.get('roundtrip')!
  while (instance.tasks.size) await Promise.allSettled([...instance.tasks])
}

const previousPromise = global.Promise
const previousDocument = global.document
beforeAll(() => {
  global.Promise = (async () => undefined)().constructor as PromiseConstructor
  ;(global as unknown as { document: unknown }).document = {
    hasFocus: () => true,
    hidden: false,
  }
})
afterAll(() => {
  global.Promise = previousPromise
  global.document = previousDocument
})

it.each([false, true])(
  'app/bot paid round trip uses canonical originals (lost acknowledgment=%s)',
  async ambiguous => {
    jest.setTimeout(120_000)
    const externalFetch = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('No external fixture routes'))
    const priorChain = { ...activeChain }
    offlineChain.reset()
    mockBalances.clear()
    mailboxes.clear()
    useProviderStandIns()
    mockLostAcknowledgments = 0
    mockLoseBotAcknowledgment = false
    const f = await fixture({
      transactionSetPolicy: () => ({
        sourceOrder: [
          'stealth',
          'stamp',
          'change',
          'deterministic',
          'root',
          'identity',
        ],
        gasPriceWei: 1n,
        paymentGasLimit: () => 21_000n,
        changeGasLimit: 21_000n,
        paymentFeeIsExact: true,
        dustWei: 210_000n,
        radix: 2,
        jitterBps: 1500,
        maxChangeOutputs: 4,
        head: 100,
      }),
      spendSpacingBlocks: undefined,
      reserveBalanceWei: undefined,
    })
    mockFixture = f
    Object.assign(activeChain, f.chain)
    let host: FrankBotHost | undefined
    let polling: ReturnType<typeof startDirectMessagePolling> | undefined
    const rows: StoredMessage[] = []
    const put = LevelOutgoingMessageStore.prototype.put
    const writes = jest
      .spyOn(LevelOutgoingMessageStore.prototype, 'put')
      .mockImplementation(async function (
        this: LevelOutgoingMessageStore,
        row,
      ) {
        await put.call(this, row)
        rows.push(structuredClone(row))
      })
    try {
      const handlers: {
        conversation: string | undefined
        digest: string
        text: string
      }[] = []
      const definition: FrankBotDefinition = {
        id: 'roundtrip',
        getProfile: () => ({ name: 'Roundtrip bot', bot: true }),
        async onMessage(message) {
          const text = message.items.find(item => item.type === 'text')
          if (text?.type !== 'text')
            throw new Error('Expected real decoded text')
          handlers.push({
            conversation: message.conversationId,
            digest: message.payloadDigest,
            text: text.text,
          })
          return { kind: 'prepared-reply', text: `Reply: ${text.text}` }
        },
      }
      const openHost = async () => {
        const opened = new FrankBotHost({
          relayBaseUrl: f.config.relayBaseUrl,
          rpcUrl: 'http://127.0.0.1:1',
          stateDir: join(f.root, 'bot-host'),
          networkTag: 'MONT',
          watchRegistrations: false,
          stampValueWei: STAMP,
          minStampValueWei: 0n,
        })
        await opened.register(definition)
        return opened
      }
      host = await openHost()
      const peer = mockBotWallet.identity.displayAddress
      installCanonicalDirectory(
        f.alice,
        await f.directoryFor('app', f.alice, mockBotWallet),
      )
      const botInbox: InboxRecord[] = []
      const appInbox: InboxRecord[] = []
      mailboxes.set(toHex(mockBotWallet.identity.compressedPubKey), botInbox)
      mailboxes.set(toHex(f.alice.identity.compressedPubKey), appInbox)
      mockSession = await sessionFor(f.alice)
      mkdirSync(join(f.root, 'presentation'), { recursive: true })
      mockStore = new LevelMessageStore(join(f.root, 'presentation'))
      await mockStore.Open()
      setActivePinia(createPinia())
      setConversationIdSalt(conversationIdSalt(new Uint8Array(32).fill(0x7e)))
      const chats = useChatStore()
      for (const id of CONVERSATIONS)
        chats.createConversation({
          conversationId: id,
          name: 'Same subject',
          address: peer,
          participants: [f.alice.identity.displayAddress, peer],
        })
      useContactStore().addLoadingContact({
        address: peer,
        pubKey: profilePubKeyFromBytes(mockBotWallet.identity.compressedPubKey),
      })
      const conversation = CONVERSATIONS[ambiguous ? 1 : 0]
      const other = CONVERSATIONS[ambiguous ? 0 : 1]
      f.setMailbox(botInbox)
      const sent = await chats.sendMessage({
        wallet: f.alice,
        address: peer,
        conversationId: conversation,
        items: [{ type: 'text', text: `Question ${conversation}` }],
        stampValue: STAMP,
      })
      expect(sent.state).toBe('sent')
      if (sent.state !== 'sent')
        throw new Error(`App send did not complete: ${JSON.stringify(sent)}`)
      expect(botInbox).toHaveLength(1)
      const appRow = rows.find(
        row => row.digest === sent.payloadDigest && row.request,
      )!
      expect(appRow.payments.length).toBeGreaterThan(0)
      expect(appRow.otherTransactions.length).toBeGreaterThan(0)
      const appRequest = f.requests.find(
        request => hexlify(request.body).slice(2) === appRow.request!.body,
      )!
      const appRecipientBytes = restoreCanonicalRequest(
        appRequest,
      ).parts.transactions.map(raw => hexlify(raw))
      expect(appRecipientBytes).toEqual(
        appRow.payments.map(member => member.rawTx),
      )
      for (const change of appRow.otherTransactions)
        expect(offlineChain.walletBroadcasts).toContain(change.rawTx)
      const appOperation = f.alice.getNativeOperations!().find(operation =>
        operation.members.some(
          member => member.signed?.rawTransaction === appRow.payments[0].rawTx,
        ),
      )!
      expect(
        new Set(
          appOperation.members.map(member => member.signed!.rawTransaction),
        ),
      ).toEqual(
        new Set([
          ...appRecipientBytes,
          ...appRow.otherTransactions.map(member => member.rawTx),
        ]),
      )
      // Host first admission scans the last day; this fixture relay otherwise dates records
      // from its deterministic epoch (1000 ms).
      botInbox[0].timestampMs = Date.now()
      f.setMailbox(appInbox)
      mockLoseBotAcknowledgment = ambiguous
      await pollBot(host)
      expect(handlers).toEqual([
        {
          conversation,
          digest: sent.payloadDigest,
          text: `Question ${conversation}`,
        },
      ])
      const instance = observed(host).instances.get('roundtrip')!
      const replyId = replyMessageId(
        instance.operations.owner,
        sent.payloadDigest,
      )
      const original = await f.chain.directMessages.attemptOf!({
        wallet: mockBotWallet,
        messageId: replyId,
      })
      expect(original?.paid).toBe(true)
      const replyRow = rows.find(
        row =>
          row.consumerId === `frank-dm:${replyId.replace(/-/g, '')}` &&
          row.request,
      )!
      expect(replyRow.request).toBeDefined()
      expect(replyRow.payments.length).toBeGreaterThan(0)
      expect(replyRow.otherTransactions.length).toBeGreaterThan(0)
      const originalOperation = mockBotWallet.getNativeOperations!().find(
        operation =>
          operation.members.some(
            member =>
              member.signed?.rawTransaction === replyRow.payments[0].rawTx,
          ),
      )!
      expect(originalOperation).toBeDefined()
      const operationId = originalOperation.operationId
      const signed = originalOperation!.members.map(
        member => member.signed!.rawTransaction,
      )
      expect(signed.length).toBeGreaterThan(1)
      if (ambiguous) {
        expect(mockLostAcknowledgments).toBe(1)
        expect(instance.operations.get(sent.payloadDigest)?.reply?.digest).toBe(
          original!.payloadDigest,
        )
        await host.stop()
        host = await openHost()
        const reopened = await mockBotWallet.readNativeOperation!(operationId)
        expect(
          reopened!.members.map(member => member.signed!.rawTransaction),
        ).toEqual(signed)
        expect(
          await f.chain.directMessages.attemptOf!({
            wallet: mockBotWallet,
            messageId: replyId,
          }),
        ).toEqual(original)
      }
      await pollBot(host)
      expect(handlers).toHaveLength(1)
      expect(
        await observed(host)
          .instances.get('roundtrip')!
          .operations.finished(sent.payloadDigest),
      ).toBe(true)
      const replyRequests = f.requests.filter(
        request => hexlify(request.body).slice(2) === replyRow.request!.body,
      )
      expect(replyRequests.length).toBe(ambiguous ? 2 : 1)
      for (const request of replyRequests) {
        const relay = restoreCanonicalRequest(request)
        expect(relay.parts.transactions.map(raw => hexlify(raw))).toEqual(
          replyRow.payments.map(member => member.rawTx),
        )
      }
      for (const change of replyRow.otherTransactions)
        expect(offlineChain.walletBroadcasts).toContain(change.rawTx)
      const submitted = new Set([
        ...replyRow.payments.map(member => member.rawTx),
        ...offlineChain.walletBroadcasts.filter(raw => signed.includes(raw)),
      ])
      expect(submitted).toEqual(new Set(signed))
      // Observe completion through the real poller's real receive/store action.
      let received!: () => void
      const receiveDone = new Promise<void>(resolve => {
        received = resolve
      })
      const receive = chats.receiveMessages.bind(chats)
      const receiving = jest
        .spyOn(chats, 'receiveMessages')
        .mockImplementation(async (...args: Parameters<typeof receive>) => {
          const result = await receive(...args)
          received()
          return result
        })
      polling = startDirectMessagePolling({
        wallet: f.alice,
        intervalMs: 60_000,
      })
      await receiveDone
      polling.stop()
      polling = undefined
      receiving.mockRestore()
      const replies = chats.conversations[conversation].messages.filter(
        message => !message.outbound,
      )
      expect(replies).toHaveLength(1)
      expect(replies[0]).toMatchObject({
        payloadDigest: original!.payloadDigest,
        conversationId: conversation,
        logicalMessageId: replyId,
        items: [{ type: 'text', text: `Reply: Question ${conversation}` }],
      })
      expect(chats.conversations[other].messages).toHaveLength(0)
      expect(
        (await mockStore.getMessage(original!.payloadDigest))?.message
          .conversationId,
      ).toBe(conversation)
      const originalIds = new Set(
        rows
          .filter(row => row.consumerId === replyRow.consumerId)
          .map(row => row.transactionSetOperationId),
      )
      expect(originalIds).toEqual(new Set([replyRow.transactionSetOperationId]))
    } finally {
      polling?.stop()
      await host?.stop()
      await mockStore?.Close()
      writes.mockRestore()
      mockFixture = undefined
      Object.assign(activeChain, priorChain)
      externalFetch.mockRestore()
      await f.close()
    }
  },
  120_000,
)
