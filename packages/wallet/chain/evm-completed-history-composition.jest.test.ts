/** Actual wallet composition and LevelDB; only network effects and capacity are configured. */
import { fixture, mockBalances, offlineChain, roots, useProviderStandIns } from './canonical-two-wallets.testutil'
import { installCanonicalDirectory } from './evm-chain'
import { LevelOutgoingMessageStore, type StoredMessage } from './canonical-dm'
import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import type { EvmTransactionSetPolicy } from '../evm-transaction-set-types'

jest.mock('../evm-provider', () => require('./canonical-two-wallets.testutil').offlineProviderModule())
jest.mock('../evm-http', () => require('./canonical-two-wallets.testutil').offlineHttpModule())
jest.mock('@frank/cashweb/relay/mailbox-client', () => require('./canonical-two-wallets.testutil').offlineMailboxModule())
jest.mock('../storage/evm-native-operation-journal', () => {
  const actual = jest.requireActual('../storage/evm-native-operation-journal')
  return { ...actual, EvmNativeOperationJournal: class extends actual.EvmNativeOperationJournal {
    constructor(options: ConstructorParameters<typeof import('../storage/evm-native-operation-journal').EvmNativeOperationJournal>[0]) {
      super({ ...options, maxRecords: 1 })
    }
  } }
})

const policy: EvmTransactionSetPolicy = {
  sourceOrder: ['stealth', 'stamp', 'change', 'deterministic', 'root', 'identity'],
  gasPriceWei: 1n, paymentGasLimit: () => 21000n, changeGasLimit: 21000n,
  paymentFeeIsExact: true, dustWei: 21000n, radix: 2, jitterBps: 0,
  maxChangeOutputs: 1, head: 100,
}
const messageId = (index: number) => `11111111-2222-4333-8444-${index.toString(16).padStart(12, '0')}`
async function setup(options: { syncBlocked?: boolean } = {}) {
  offlineChain.reset(); mockBalances.clear(); useProviderStandIns()
  const syncs: string[] = []
  const f = await fixture({ transactionSetPolicy: () => policy,
    spendSpacingBlocks: undefined, reserveBalanceWei: undefined,
    emitWalletSync: async item => {
      if (options.syncBlocked) throw new Error('sync unavailable')
      syncs.push(item.txHash)
    },
  })
  const directory = await f.directoryFor('alice', f.alice, f.bob)
  installCanonicalDirectory(f.alice, directory)
  mockBalances.set(f.alice.mainAccount!.address.toLowerCase(), 1000000n)
  return { ...f, directory, syncs }
}
afterEach(() => { jest.restoreAllMocks(); useProviderStandIns(false) })

test('uncheckpointed sync retains the active record and later completion unblocks the original next intent', async () => {
  const options = { syncBlocked: true }
  const f = await setup(options)
  try {
    await f.chain.directMessages.send({ wallet: f.alice, recipient: f.bob.identity.address,
      messageId: messageId(20), stampValue: 1000n, items: [{ type: 'text', text: 'sync remains owed' }],
    })
    await f.alice.flushNativeSync!()
    expect(f.alice.getNativeOperations!()).toHaveLength(1)
    expect((await f.alice.getNativeOperationHistory!({ limit: 100 })).operations).toEqual([])
    let pendingDigest: string | undefined
    await expect(f.chain.directMessages.send({ wallet: f.alice, recipient: f.bob.identity.address,
      messageId: messageId(21), stampValue: 1000n, items: [{ type: 'text', text: 'waiting for capacity' }],
      onBeforeExposure: digest => { pendingDigest = digest },
    })).rejects.toThrow(/capacity/)
    expect(pendingDigest).toBeDefined()
    options.syncBlocked = false
    await f.alice.flushNativeSync!()
    expect(f.alice.getNativeOperations!()).toEqual([])
    expect(await f.chain.directMessages.reconcileAttempts({ wallet: f.alice, payloadDigests: [pendingDigest!], maxPutAttempts: 1 }))
      .toEqual({ [pendingDigest!]: 'delivered' })
    await f.alice.flushNativeSync!()
    expect((await f.alice.getNativeOperationHistory!({ limit: 100 })).operations).toHaveLength(2)
  } finally { await f.close() }
})

test('completed composed sends free the active slot while exact history and retries survive reopening', async () => {
  const f = await setup()
  let wallet: EvmChainWalletHandle = f.alice
  try {
    const nativeIds: string[] = []
    const originalBytes: string[][] = []
    for (let index = 1; index <= 3; index++) {
      const id = messageId(index)
      await f.chain.directMessages.send({ wallet, recipient: f.bob.identity.address,
        messageId: id, stampValue: 1000n, items: [{ type: 'text', text: `history ${index}` }],
      })
      await wallet.flushNativeSync!()
      const row = await wallet.transactionSetPreparer!.readOperation(`stamp-${id.replace(/-/g, '')}`)
      expect(row).toBeDefined()
      expect(row!.members.every(member => member.syncApplied)).toBe(true)
      nativeIds.push(row!.operationId)
      originalBytes.push(row!.members.map(member => member.signed!.rawTransaction))
      expect(wallet.getNativeOperations!()).toEqual([])
      expect((await wallet.getNativeOperationHistory!({ limit: 100 })).operations).toHaveLength(index)
    }
    expect(f.syncs.length).toBeGreaterThanOrEqual(3)
    await wallet.close()
    wallet = await f.chain.createWallet(roots(0)) as EvmChainWalletHandle
    installCanonicalDirectory(wallet, f.directory)
    expect(wallet.getNativeOperations!()).toEqual([])
    for (const [index, id] of nativeIds.entries()) {
      const row = await wallet.readNativeOperation!(id)
      expect(row!.members.map(member => member.signed!.rawTransaction)).toEqual(originalBytes[index])
    }
    const wrapper = await wallet.transactionSetPreparer!.readTransactionSet(`stamp-${messageId(1).replace(/-/g, '')}`)
    const before = [...offlineChain.walletBroadcasts]
    expect((await wallet.transactionSetSubmission!.sendTransaction(wrapper)).status).toBe('confirmed')
    expect(offlineChain.walletBroadcasts).toEqual(before)
    await f.chain.directMessages.send({ wallet, recipient: f.bob.identity.address,
      messageId: messageId(4), stampValue: 1000n, items: [{ type: 'text', text: 'after reopen' }],
    })
    await wallet.flushNativeSync!()
    expect((await wallet.getNativeOperationHistory!({ limit: 100 })).operations).toHaveLength(4)
  } finally { await wallet.close(); await f.close() }
})

test('settled wallet history does not complete or discard an undelivered message', async () => {
  const f = await setup()
  let wallet: EvmChainWalletHandle = f.alice
  try {
    let stored: StoredMessage | undefined
    const put = LevelOutgoingMessageStore.prototype.put
    jest.spyOn(LevelOutgoingMessageStore.prototype, 'put').mockImplementation(async function(row) {
      await put.call(this, row)
      if (row.request) stored = structuredClone(row)
    })
    f.setPhase('retained')
    await f.chain.directMessages.send({ wallet, recipient: f.bob.identity.address,
      messageId: messageId(10), stampValue: 1000n, items: [{ type: 'text', text: 'still owed delivery' }],
    }).catch(() => undefined)
    expect(stored?.request).toBeDefined()
    expect(stored!.outcome).toBeUndefined()
    await wallet.flushNativeSync!()
    expect(wallet.getNativeOperations!()).toEqual([])
    const history = (await wallet.getNativeOperationHistory!({ limit: 100 })).operations
    expect(history).toHaveLength(1)
    const original = history[0]!.members.map(member => member.signed!.rawTransaction)
    const body = stored!.request!.body
    const digest = stored!.digest
    expect(await f.chain.directMessages.deliveryOf!({ wallet, payloadDigest: digest })).not.toBe('delivered')
    await wallet.close()
    wallet = await f.chain.createWallet(roots(0)) as EvmChainWalletHandle
    installCanonicalDirectory(wallet, f.directory)
    f.setPhase('delivered')
    const before = [...offlineChain.walletBroadcasts]
    expect(await f.chain.directMessages.reconcileAttempts({ wallet, payloadDigests: [digest], maxPutAttempts: 1 }))
      .toEqual({ [digest]: 'delivered' })
    expect(stored!.request!.body).toBe(body)
    expect(stored!.digest).toBe(digest)
    expect(offlineChain.walletBroadcasts).toEqual(before)
    expect((await wallet.readNativeOperation!(history[0]!.operationId))!.members.map(member => member.signed!.rawTransaction)).toEqual(original)
  } finally { await wallet.close(); await f.close() }
})
