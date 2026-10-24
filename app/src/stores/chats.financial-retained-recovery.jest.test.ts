/** Synthetic production composition: real Chat orchestration, canonical sealing/signing,
 * financial capture, durable message/operation owners and production recovery tick.
 * Synthetic custody and host acquisition return the real session wallet; financial policy
 * is unchanged. Node/relay I/O and notification presentation are offline stand-ins.
 */
import { createPinia, setActivePinia } from 'pinia'
import { join } from 'path'
import { fromHex, toHex } from '@frank/codec'
import { freezeCanonicalRequest } from '@frank/cashweb/relay/canonical-dm-transport'
import { mkdirSync } from 'fs'
import { LevelMessageStore } from '@frank/cashweb/relay/storage/level-storage'
import { activeChain } from '@frank/wallet/chain'
import { LevelOutgoingMessageStore } from '@frank/wallet/chain/canonical-dm'
import { installCanonicalDirectory } from '@frank/wallet/chain/evm-chain'
import {
  fixture,
  roots,
  offlineChain,
  mockBalances,
  useProviderStandIns,
  type Fixture,
  type InboxRecord,
} from '@frank/wallet/chain/canonical-two-wallets.testutil'
import { recipientAssetPaymentFromPrepared } from '@frank/wallet/message-item-plugins/stealth-asset/from-prepared'
import { useChatStore, rehydateChat, setConversationIdSalt } from './chats'
import { conversationIdSalt } from '@frank/cashweb/relay/conversation-id'
import { startOutgoingReconciliation } from '../adapters/pinia-chain-adapter'

let mockStore: LevelMessageStore
let mockSession: ReturnType<
  typeof import('../accounts/session').createAccountSession
>
let mockOpen: { chain: Fixture['chain']; wallet: Fixture['alice'] }
jest.mock('../adapters/level-message-store', () => ({
  store: {
    then: (
      resolve: (s: LevelMessageStore) => unknown,
      reject: (e: unknown) => unknown,
    ) => Promise.resolve(mockStore).then(resolve, reject),
  },
}))
jest.mock('../accounts/session', () => ({
  get accountSession() {
    return mockSession
  },
}))
// Host acquisition is injected, not financial capture or recovery policy.
jest.mock('../accounts/evm-wallets', () => ({
  ...jest.requireActual('../accounts/evm-wallets'),
  openEvmWallet: async () => mockOpen,
  peekOpenedEvmWallets: () => (mockOpen ? [mockOpen] : []),
}))
jest.mock('@frank/wallet/evm-provider', () =>
  require('@frank/wallet/chain/canonical-two-wallets.testutil').offlineProviderModule(),
)
jest.mock('@frank/wallet/evm-http', () =>
  require('@frank/wallet/chain/canonical-two-wallets.testutil').offlineHttpModule(),
)
jest.mock('@frank/cashweb/relay/mailbox-client', () =>
  require('@frank/wallet/chain/canonical-two-wallets.testutil').offlineMailboxModule(),
)
jest.mock('../utils/notifications', () => ({ desktopNotify: jest.fn() }))

const operationId = 'retained-envelope-payment'
const policy = {
  sourceOrder: [
    'stealth',
    'stamp',
    'change',
    'deterministic',
    'root',
    'identity',
  ] as const,
  gasPriceWei: 1n,
  paymentGasLimit: () => 21000n,
  changeGasLimit: 21000n,
  paymentFeeIsExact: true,
  dustWei: 210000n,
  radix: 2,
  jitterBps: 1500,
  maxChangeOutputs: 4,
  head: 100,
}

async function sessionFor(wallet: Fixture['alice']) {
  const { createAccountSession } = jest.requireActual<
    typeof import('../accounts/session')
  >('../accounts/session')
  const account = {
    displayName: 'Synthetic',
    descriptor: 'public',
    receipt: {
      operationId: 'synthetic',
      context: { accountId: 'synthetic-account' },
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
          close() {},
          takeRoots: () => Object.values(material),
        }),
        close() {},
      } as unknown as import('../accounts/custody').AccountCustody),
    createWallet: async () =>
      wallet as import('../accounts/session').RuntimeWallet,
  })
  await session.initialize()
  return session
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

it.each([
  [0n, 'deleted'],
  [30000n, 'deleted'],
  [0n, 'retained'],
  [30000n, 'retained'],
  [30000n, 'authorized'],
] as const)(
  'recovers original financial envelope after reopen (stamp=%s, presentation=%s)',
  async (stampValue, mode) => {
    offlineChain.reset()
    mockBalances.clear()
    useProviderStandIns()
    const f = await fixture({
      transactionSetPolicy: () => ({
        ...policy,
        sourceOrder: [...policy.sourceOrder],
      }),
      spendSpacingBlocks: undefined,
      reserveBalanceWei: undefined,
    })
    let wallet = f.alice
    let polling: ReturnType<typeof startOutgoingReconciliation> | undefined
    const originalChain = { ...activeChain }
    Object.assign(activeChain, f.chain)
    const inbox: InboxRecord[] = []
    f.setMailbox(inbox)
    const directory = await f.directoryFor('alice', wallet, f.bob)
    installCanonicalDirectory(wallet, directory)
    const location = join(f.root, 'presentation')
    mkdirSync(location, { recursive: true })
    mockStore = new LevelMessageStore(location)
    await mockStore.Open()
    try {
      mockSession = await sessionFor(wallet)
      mockOpen = { chain: f.chain, wallet }
      setActivePinia(createPinia())
      setConversationIdSalt(conversationIdSalt(new Uint8Array(32).fill(0x7e)))
      mockBalances.set(wallet.mainAccount!.address.toLowerCase(), 1000000n)
      await wallet.refreshTransactionSetInventory!()
      const prepared = await wallet.stealthPayments!.prepare({
        operationId,
        chainIdentifier: 'monad-testnet',
        asset: { kind: 'native' },
        recipientSpendPublicKey: f.bob.identity.compressedPubKey,
        amountAtomic: 300000n,
        maxNativeFeeAtomic: 400000n,
        ...(stampValue
          ? {
              messageStamp: {
                amountAtomic: stampValue,
                maxNativeFeeAtomic: 100000n,
              },
            }
          : {}),
      })
      const sealed = new Map<string, string[]>()
      const record = (digest: string, bytes: string) => {
        const versions = sealed.get(digest) ?? []
        versions.push(bytes)
        sealed.set(digest, versions)
      }
      const put = LevelOutgoingMessageStore.prototype.put
      jest
        .spyOn(LevelOutgoingMessageStore.prototype, 'put')
        .mockImplementation(async function (row) {
          await put.call(this, row)
          if (row.request) record(row.digest, row.request.body)
        })
      const setUnpaid = LevelOutgoingMessageStore.prototype.setUnpaid
      jest
        .spyOn(LevelOutgoingMessageStore.prototype, 'setUnpaid')
        .mockImplementation(async function (id, envelope) {
          await setUnpaid.call(this, id, envelope)
          if (envelope)
            record(
              envelope.digest,
              JSON.stringify([
                envelope.delivery,
                envelope.context,
                envelope.boundary,
              ]),
            )
        })
      const item = recipientAssetPaymentFromPrepared(prepared)
      if (mode === 'authorized') f.setPhase('retained')
      const save = mockStore.saveMessage.bind(mockStore)
      const write = jest
        .spyOn(mockStore, 'saveMessage')
        .mockImplementation(async row => {
          if (mode !== 'authorized' && row.message.delivery?.attemptDigest)
            throw new Error('synthetic host linkage interruption')
          return save(row)
        })
      const chats = useChatStore()
      await chats.sendMessage({
        wallet,
        address: f.bob.identity.address.raw,
        items: [item],
        stampValue,
        financialOperations: [
          { chainIdentifier: 'monad-testnet', operationId },
        ],
      })
      write.mockRestore()
      const message = Object.values(chats.messages)[0]
      expect(message.sealedMessageId).toBeDefined()
      const held = await f.chain.directMessages.attemptOf!({
        wallet,
        messageId: message.sealedMessageId!,
      })
      expect(held).toBeDefined()
      expect(inbox).toHaveLength(0)
      const originalEnvelope = sealed.get(held!.payloadDigest)![0]
      expect(originalEnvelope).toBeDefined()
      const originalRequestBody = stampValue
        ? originalEnvelope
        : (() => {
            const [delivery, context, boundary] = JSON.parse(
              originalEnvelope,
            ) as string[]
            return toHex(
              freezeCanonicalRequest(
                {
                  delivery: fromHex(delivery),
                  context: fromHex(context),
                  transactions: [],
                },
                boundary,
              ).body,
            )
          })()
      expect(originalRequestBody).toMatch(/^[0-9a-f]+$/)
      const original = await wallet.stealthPayments!.get(operationId)
      const originalOperations = wallet.getNativeOperations!().map(row => ({
        id: row.operationId,
        signed: row.members.map(member => member.signed?.rawTransaction),
      }))
      expect(originalOperations.length).toBeGreaterThan(0)
      for (const row of originalOperations) {
        expect(row.signed.length).toBeGreaterThan(0)
        for (const raw of row.signed) expect(raw).toMatch(/^0x[0-9a-f]+$/i)
      }
      if (mode !== 'retained')
        await chats.deleteMessage({
          wallet,
          address: f.bob.identity.address.raw,
          payloadDigest: message.payloadDigest,
        })
      // Conversation metadata is carried in memory into a fresh Pinia. Message rows,
      // canonical envelopes and native operation journals are actually closed/reopened;
      // this does not claim a full browser-process or metadata-storage restart.
      const metadata = chats.$state
      await mockStore.Close()
      await wallet.close()
      wallet = (await f.chain.createWallet(roots(0))) as Fixture['alice']
      installCanonicalDirectory(wallet, directory)
      mockSession = await sessionFor(wallet)
      mockOpen = { chain: f.chain, wallet }
      mockStore = new LevelMessageStore(location)
      await mockStore.Open()
      setActivePinia(createPinia())
      const restored = useChatStore()
      restored.$patch(await rehydateChat(metadata))
      expect(Object.values(restored.messages)).toHaveLength(
        mode === 'retained' ? 1 : 0,
      )
      expect(await wallet.stealthPayments!.get(operationId)).toEqual(original)
      const requestsBeforeRecovery = f.requests.length
      f.setPhase('delivered')
      const prepare = jest.spyOn(wallet.stealthPayments!, 'prepare')
      // Stop after the third Chat pass: the first two complete the following orphan
      // phase too; the third is stopped before its orphan phase. This is not three
      // complete ticks, and uses no arbitrary wall-clock success budget.
      let completed = 0
      let finish!: () => void
      const passes = new Promise<void>(resolve => {
        finish = resolve
      })
      const reconcile = restored.reconcileOutgoing.bind(restored)
      jest
        .spyOn(restored, 'reconcileOutgoing')
        .mockImplementation(async params => {
          const result = await reconcile(params)
          if (++completed === 3) {
            polling?.stop()
            finish()
          }
          return result
        })
      polling = startOutgoingReconciliation({
        wallet,
        intervalMs: 10,
        maxIntervalMs: 10,
        idleIntervalMs: 10,
      })
      await passes
      expect(
        await f.chain.directMessages.attemptOf!({
          wallet,
          messageId: message.sealedMessageId!,
        }),
      ).toEqual(held)
      expect(prepare).not.toHaveBeenCalled()
      expect(
        wallet.getNativeOperations!()
          .map(row => row.operationId)
          .sort(),
      ).toEqual(originalOperations.map(row => row.id).sort())
      expect(new Set(sealed.get(held!.payloadDigest))).toEqual(
        new Set([originalEnvelope]),
      )
      for (const originalRow of originalOperations) {
        const row = await wallet.readNativeOperation!(originalRow.id)
        expect(
          row?.members.map(member => member.signed?.rawTransaction),
        ).toEqual(originalRow.signed)
      }
      expect(inbox).toHaveLength(1)
      // Observe the external relay boundary, not only journal setters. The control
      // must transmit exactly the multipart bytes reconstructed from its original
      // persisted envelope after reopen, including the original boundary.
      expect(
        f.requests
          .slice(requestsBeforeRecovery)
          .map(request => toHex(request.body)),
      ).toContain(originalRequestBody)
    } finally {
      polling?.stop()
      jest.useRealTimers()
      jest.restoreAllMocks()
      await mockStore.Close()
      if (wallet !== f.alice) await wallet.close()
      await f.close()
      Object.assign(activeChain, originalChain)
      useProviderStandIns(false)
    }
  },
  30000,
)
