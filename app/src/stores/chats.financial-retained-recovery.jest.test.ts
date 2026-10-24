/** Synthetic production composition: real Chat orchestration, canonical sealing/signing,
 * financial capture, durable message/operation owners and production recovery tick.
 * Synthetic custody and host acquisition return the real session wallet; financial policy
 * is unchanged. Node/relay I/O and notification presentation are offline stand-ins.
 */
import { createPinia, setActivePinia } from 'pinia'
import { join } from 'path'
import { evmStealthTransactionSetOperationId } from '@frank/wallet/chain/evm-stealth-payments'
import { fromHex, toHex } from '@frank/codec'
import { freezeCanonicalRequest } from '@frank/cashweb/relay/canonical-dm-transport'
import { mkdirSync } from 'fs'
import { LevelMessageStore } from '@frank/cashweb/relay/storage/level-storage'
import { activeChain } from '@frank/wallet/chain'
import { LevelOutgoingMessageStore } from '@frank/wallet/storage/outgoing-message-store'
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

const mockBackgroundTasks = new Set<Promise<unknown>>()
function mockTrackBackground<T>(task: Promise<T>): Promise<T> {
  mockBackgroundTasks.add(task)
  void task.then(
    () => mockBackgroundTasks.delete(task),
    () => mockBackgroundTasks.delete(task),
  )
  return task
}
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
  // Observe the actual background policy so cleanup can drain it before closing
  // wallets. Do not replace it with a successful no-op.
  recoverSecondaryEvmWallets: (
    ...args: Parameters<
      typeof import('../accounts/evm-wallets').recoverSecondaryEvmWallets
    >
  ) =>
    mockTrackBackground(
      jest
        .requireActual<typeof import('../accounts/evm-wallets')>(
          '../accounts/evm-wallets',
        )
        .recoverSecondaryEvmWallets(...args),
    ),
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
          close() {
            // Synthetic custody has no external resource to close.
          },
          takeRoots: () => Object.values(material),
        }),
        close() {
          // Synthetic custody has no external resource to close.
        },
      } as unknown as import('../accounts/custody').AccountCustody),
    createWallet: async () =>
      wallet as import('../accounts/session').RuntimeWallet,
  })
  await session.initialize()
  return session
}

const externalDiscoveryInventory: { cut: string; calls: number }[] = []
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
  console.info(
    'Rejected synthetic secondary /chains discovery calls:',
    externalDiscoveryInventory,
  )
  global.Promise = previousPromise
  global.document = previousDocument
})

it.each([
  [0n, 'deleted', false, 'presentation'],
  [30000n, 'deleted', false, 'presentation'],
  [0n, 'retained', false, 'presentation'],
  [30000n, 'retained', false, 'presentation'],
  [30000n, 'authorized', false, 'presentation'],
  [30000n, 'deleted', true, 'presentation'],
  [30000n, 'retained', true, 'presentation'],
  [30000n, 'authorized', true, 'presentation'],
  [30000n, 'deleted', true, 'pending-before'],
  [30000n, 'deleted', true, 'pending-after'],
  [30000n, 'deleted', true, 'bound-before'],
  [30000n, 'deleted', true, 'bound-after'],
  [0n, 'deleted', false, 'bound-before'],
  [0n, 'deleted', false, 'bound-after'],
  [30000n, 'deleted', true, 'bootstrap-bound-before'],
] as const)(
  'recovers original envelope (stamp=%s, presentation=%s, distinct=%s, cut=%s)',
  async (stampValue, mode, distinctPayment, cut) => {
    const noOriginal = cut === 'pending-before' || cut === 'pending-after'
    // Canonical transport is injected. Secondary discovery must never fall through
    // to process-global networking while this synthetic primary session is active.
    const externalFetch = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Synthetic fixture has no external routes'))
    jest.spyOn(console, 'debug').mockImplementation(() => undefined)
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
      if (distinctPayment) {
        // A separate synthetic source covers the stamp without consuming the held
        // financial operation's inputs or treating its change as available.
        const [source] = wallet.pool.ensureSize(1)
        await wallet.pool.flush()
        mockBalances.set(source.address.toLowerCase(), 2000000n)
      }
      await wallet.refreshTransactionSetInventory!()
      const prepared = await wallet.stealthPayments!.prepare({
        operationId,
        chainIdentifier: 'monad-testnet',
        asset: { kind: 'native' },
        recipientSpendPublicKey: f.bob.identity.compressedPubKey,
        amountAtomic: 300000n,
        maxNativeFeeAtomic: 400000n,
        ...(stampValue && !distinctPayment
          ? {
              messageStamp: {
                amountAtomic: stampValue,
                maxNativeFeeAtomic: 100000n,
              },
            }
          : {}),
      })
      const paymentRow = wallet.transactionSetPreparer!.getOperation(
        evmStealthTransactionSetOperationId(operationId),
      )
      expect(paymentRow).toBeDefined()
      const paymentMembers = paymentRow!.members.map(member => ({
        role: member.transactionSet?.role,
        raw: member.signed?.rawTransaction,
      }))
      expect(
        paymentMembers.filter(member => member.role === 'payment').length,
      ).toBeGreaterThan(0)
      expect(
        paymentMembers.filter(member => member.role === 'change').length,
      ).toBeGreaterThan(0)
      for (const member of paymentMembers)
        expect(member.raw).toMatch(/^0x[0-9a-f]+$/i)
      if (distinctPayment) expect(prepared.messageStamp).toBeUndefined()
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
      const chats = useChatStore()
      const references = [{ chainIdentifier: 'monad-testnet', operationId }]
      const exposeBeforeRecovery = jest.spyOn(wallet.stealthPayments!, 'expose')
      let bootstrapDigest: string | undefined
      const bootstrapId = '11111111-2222-4333-8444-555555555555'
      if (cut === 'bootstrap-bound-before') {
        // Actual previously authorized original, before independent host bindings existed.
        // Neither the binding writer nor the canonical exposure barrier is faked.
        f.setPhase('retained')
        await f.chain.directMessages
          .send({
            wallet,
            recipient: f.bob.identity.address,
            items: [item],
            stampValue,
            messageId: bootstrapId,
            onEnvelopeDurable: async digest => {
              bootstrapDigest = digest
              await wallet.stealthPayments!.expose({
                operationId,
                payloadDigest: digest,
              })
            },
          })
          .catch(error => {
            expect(error).toHaveProperty('payloadHashes', [bootstrapDigest])
          })
        expect(bootstrapDigest).toBeDefined()
        expect(exposeBeforeRecovery).toHaveBeenCalledTimes(1)
        chats.sendMessageLocal({
          address: f.bob.identity.address.raw,
          senderAddress: wallet.identity.displayAddress,
          index: 'pending:bootstrap',
          items: [item],
          outpoints: [],
          previousHash: null,
          status: 'error',
          stampValueWei: stampValue,
          sealedMessageId: bootstrapId,
          financialOperations: references,
          delivery: { attemptDigest: bootstrapDigest },
        })
        await chats.saveOutgoing(
          f.bob.identity.address.raw,
          'pending:bootstrap',
          { strict: true },
        )
      }
      if (mode === 'authorized') f.setPhase('retained')
      const bind = mockStore.bindFinancialEnvelope.bind(mockStore)
      let interrupted = false
      const bindingWrite = jest
        .spyOn(mockStore, 'bindFinancialEnvelope')
        .mockImplementation(async binding => {
          const target = noOriginal ? 'pending' : 'bound'
          if (
            cut !== 'presentation' &&
            !interrupted &&
            binding.phase === target
          ) {
            interrupted = true
            if (cut.endsWith('-after')) await bind(binding)
            throw new Error('synthetic binding write interruption')
          }
          return bind(binding)
        })
      const save = mockStore.saveMessage.bind(mockStore)
      const write = jest
        .spyOn(mockStore, 'saveMessage')
        .mockImplementation(async row => {
          if (
            cut === 'presentation' &&
            mode !== 'authorized' &&
            row.message.delivery?.attemptDigest
          )
            throw new Error('synthetic host linkage interruption')
          return save(row)
        })
      const attempt =
        cut === 'bootstrap-bound-before'
          ? chats.retryOutgoing({
              wallet,
              address: f.bob.identity.address.raw,
              payloadDigest: 'pending:bootstrap',
            })
          : chats.sendMessage({
              wallet,
              address: f.bob.identity.address.raw,
              items: [item],
              stampValue,
              financialOperations: references,
            })
      await attempt.catch(error => {
        if (cut === 'presentation') throw error
        expect(error.message).toContain('synthetic binding write interruption')
      })
      bindingWrite.mockRestore()
      write.mockRestore()
      if (cut !== 'presentation') {
        expect(interrupted).toBe(true)
        const bindings = await mockStore.financialEnvelopeBindings({
          accountId: 'synthetic-account',
          messagingChainIdentifier: 'monad-testnet',
        })
        if (cut === 'pending-before') expect(bindings).toEqual([])
        else {
          expect(bindings).toHaveLength(1)
          expect(bindings[0].phase).toBe(
            cut === 'bound-after' ? 'bound' : 'pending',
          )
          expect(bindings[0].financialOperations).toEqual(references)
        }
      }
      if (cut !== 'bootstrap-bound-before' && mode !== 'authorized')
        expect(exposeBeforeRecovery).not.toHaveBeenCalled()
      else if (cut === 'bootstrap-bound-before')
        expect(exposeBeforeRecovery).toHaveBeenCalledTimes(1)
      const message = Object.values(chats.messages)[0]
      expect(message.sealedMessageId).toBeDefined()
      const held = await f.chain.directMessages.attemptOf!({
        wallet,
        messageId: message.sealedMessageId!,
      })
      if (noOriginal) expect(held).toBeUndefined()
      else expect(held).toBeDefined()
      if (cut === 'bootstrap-bound-before')
        expect(held).toEqual({ payloadDigest: bootstrapDigest, paid: true })
      expect(inbox).toHaveLength(0)
      // A distinct operation must still need explicit submission after reopen.
      // Combined-stamp delivery may already have driven its shared operation.
      if (distinctPayment || mode !== 'authorized')
        for (const member of paymentMembers) {
          expect(offlineChain.walletBroadcasts).not.toContain(member.raw)
          expect([...offlineChain.signedTransactions.values()]).not.toContain(
            member.raw,
          )
        }
      const originalEnvelope = held
        ? sealed.get(held.payloadDigest)![0]
        : undefined
      if (!noOriginal) expect(originalEnvelope).toBeDefined()
      const originalRequestBody = noOriginal
        ? undefined
        : stampValue
        ? originalEnvelope
        : (() => {
            const [delivery, context, boundary] = JSON.parse(
              originalEnvelope!,
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
      if (!noOriginal) expect(originalRequestBody).toMatch(/^[0-9a-f]+$/)
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
      const exposeAfterReopen = jest.spyOn(wallet.stealthPayments!, 'expose')
      // Retained-envelope recovery is independent of Chat ticks. Observe the real
      // original-operation submission finishing, not a number of presentation passes.
      let finish!: () => void
      let fail!: (error: unknown) => void
      const recovered = new Promise<void>((resolve, reject) => {
        finish = resolve
        fail = reject
      })
      const submit = wallet.stealthPayments!.submit.bind(
        wallet.stealthPayments!,
      )
      jest
        .spyOn(wallet.stealthPayments!, 'submit')
        .mockImplementation(async id => {
          try {
            expect(id).toBe(operationId)
            await mockTrackBackground(submit(id))
            finish()
          } catch (error) {
            fail(error)
            throw error
          }
        })
      const warn = console.warn.bind(console)
      jest.spyOn(console, 'warn').mockImplementation((...args) => {
        warn(...args)
        if (args[0] === 'Financial envelope recovery remains pending') {
          if (
            cut === 'pending-after' &&
            args[1] instanceof Error &&
            args[1].message.includes('original has not been stored')
          )
            finish()
          else fail(args[1])
        }
      })
      if (cut === 'pending-before') {
        const bindings = mockStore.financialEnvelopeBindings.bind(mockStore)
        jest
          .spyOn(mockStore, 'financialEnvelopeBindings')
          .mockImplementation(async scope => {
            const rows = await bindings(scope)
            expect(rows).toEqual([])
            finish()
            return rows
          })
      }
      polling = startOutgoingReconciliation({
        wallet,
        intervalMs: 10,
        maxIntervalMs: 10,
        idleIntervalMs: 10,
      })
      // Bound a broken scheduler fixture below Jest's timeout so finally still
      // stops the production poller and closes its real stores on failure.
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          recovered,
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(
              () =>
                reject(
                  new Error(
                    'Original financial operation did not complete recovery submission',
                  ),
                ),
              5000,
            )
          }),
        ])
      } finally {
        if (deadline !== undefined) clearTimeout(deadline)
      }
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
      if (!noOriginal)
        expect(new Set(sealed.get(held!.payloadDigest))).toEqual(
          new Set([originalEnvelope]),
        )
      for (const originalRow of originalOperations) {
        const row = await wallet.readNativeOperation!(originalRow.id)
        expect(
          row?.members.map(member => member.signed?.rawTransaction),
        ).toEqual(originalRow.signed)
      }
      if (noOriginal) {
        expect(exposeAfterReopen).not.toHaveBeenCalled()
        expect(inbox).toHaveLength(0)
        expect(f.requests).toHaveLength(0)
        return
      }
      expect(inbox).toHaveLength(1)
      const observedBroadcasts = new Set([
        ...offlineChain.walletBroadcasts,
        ...offlineChain.signedTransactions.values(),
      ])
      for (const member of paymentMembers) {
        expect(observedBroadcasts.has(member.raw!)).toBe(true)
        // Change is wallet-owned and never carried in the recipient's stamp
        // bundle. A distinct payment also needs its own explicit submission.
        if (distinctPayment || member.role === 'change')
          expect(offlineChain.walletBroadcasts).toContain(member.raw)
      }
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
      await Promise.allSettled([...mockBackgroundTasks])
      const rejectedExternalCalls = [...externalFetch.mock.calls]
      jest.useRealTimers()
      jest.restoreAllMocks()
      await mockStore.Close()
      if (wallet !== f.alice) await wallet.close()
      await f.close()
      Object.assign(activeChain, originalChain)
      useProviderStandIns(false)
      externalDiscoveryInventory.push({
        cut: `${stampValue}/${mode}/${distinctPayment}/${cut}`,
        calls: rejectedExternalCalls.length,
      })
      // The secondary-owner policy reads the app default development relay; the
      // canonical primary fixture instead uses its injected .example transport.
      // Every external attempt was rejected above; any other destination fails
      // this test after cleanup, even if production caught its transport error.
      for (const [url, init] of rejectedExternalCalls) {
        expect(url).toBe('http://127.0.0.1:8098/chains')
        expect(init).toMatchObject({ cache: 'no-store' })
      }
    }
  },
  30000,
)
