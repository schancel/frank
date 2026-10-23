/** Real wallet stores and signatures; only node and relay I/O are scripted. */
import { Transaction, hexlify } from 'ethers'
import { fixture, mockBalances, offlineChain, roots, useProviderStandIns } from './canonical-two-wallets.testutil'
import { installCanonicalDirectory } from './evm-chain'
import { LevelOutgoingMessageStore, type StoredMessage } from './canonical-dm'
import { evmWalletInternals } from '../evm-wallet'
import { evmStealthTransactionSetOperationId } from './evm-stealth-payments'
import { summarizeEvmNativeOperation } from './evm-native-operation-status'
import { recipientAssetPaymentFromPrepared } from '../message-item-plugins/stealth-asset/from-prepared'
import { MonadStampPendingAttemptError } from '../evm-stamp-client'
import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import type { EvmTransactionSetPolicy } from '../evm-transaction-set-types'

jest.mock('../evm-provider', () => require('./canonical-two-wallets.testutil').offlineProviderModule())
jest.mock('../evm-http', () => require('./canonical-two-wallets.testutil').offlineHttpModule())
jest.mock('@frank/cashweb/relay/mailbox-client', () => require('./canonical-two-wallets.testutil').offlineMailboxModule())
const messageId = '11111111-2222-4333-8444-555555555555'
const paymentId = 'combined-stealth-payment'
const stamp = 30000n
const policy: EvmTransactionSetPolicy = {
  sourceOrder: ['stealth', 'stamp', 'change', 'deterministic', 'root', 'identity'],
  gasPriceWei: 1n, paymentGasLimit: () => 21000n, changeGasLimit: 21000n,
  paymentFeeIsExact: true, dustWei: 210000n, radix: 2, jitterBps: 1500,
  maxChangeOutputs: 4, head: 100,
}
async function setup() {
  offlineChain.reset(); mockBalances.clear(); useProviderStandIns()
  const f = await fixture({ transactionSetPolicy: () => policy, spendSpacingBlocks: undefined, reserveBalanceWei: undefined })
  const directory = await f.directoryFor('alice', f.alice, f.bob)
  installCanonicalDirectory(f.alice, directory)
  mockBalances.set(f.alice.mainAccount!.address.toLowerCase(), 1000000n)
  await f.alice.refreshTransactionSetInventory!()
  const intent = { operationId: paymentId, chainIdentifier: 'monad-testnet', asset: { kind: 'native' as const },
    recipientSpendPublicKey: f.bob.identity.compressedPubKey, amountAtomic: 300000n,
    maxNativeFeeAtomic: 400000n, messageStamp: { amountAtomic: stamp, maxNativeFeeAtomic: 100000n } }
  const prepared = await f.alice.stealthPayments!.prepare(intent)
  return { ...f, directory, prepared, intent }
}
afterEach(() => { jest.restoreAllMocks(); useProviderStandIns(false) })

test('one funded root prepares a stealth payment and its stamp under one operation before any exposure', async () => {
  const f = await setup()
  try {
    const id = evmStealthTransactionSetOperationId(paymentId)
    const original = f.alice.transactionSetPreparer!.getOperation(id)!
    const originalBytes = original.members.map(m => m.signed!.rawTransaction)
    const changes = original.members.filter(m => m.transactionSet?.role === 'change')
      .map(m => Transaction.from(m.signed!.rawTransaction).to!.toLowerCase())
    let complete: StoredMessage | undefined
    const put = LevelOutgoingMessageStore.prototype.put
    jest.spyOn(LevelOutgoingMessageStore.prototype, 'put').mockImplementation(async function(row) {
      await put.call(this, row)
      if (row.request) complete = structuredClone(row)
    })
    const mine = offlineChain.mine.bind(offlineChain)
    jest.spyOn(offlineChain, 'mine').mockImplementation(raw => {
      expect(complete?.construction?.payload).toBeTruthy()
      expect(complete?.request).toBeDefined()
      expect(f.alice.transactionSetPreparer!.getOperation(id)!.members.every(m => m.signed)).toBe(true)
      return mine(raw)
    })
    const result = await f.chain.directMessages.send({ wallet: f.alice, recipient: f.bob.identity.address,
      messageId, paymentOperationId: paymentId, stampValue: stamp,
      items: [recipientAssetPaymentFromPrepared(f.prepared)],
      onEnvelopeDurable: digest => f.alice.stealthPayments!.expose({ operationId: paymentId, payloadDigest: digest }),
    }).catch(error => { expect(error).toBeInstanceOf(MonadStampPendingAttemptError); return undefined })
    expect(complete).toBeDefined()
    for (let i = 0; i < 6; i++) await f.chain.directMessages.reconcileAttempts({ wallet: f.alice, payloadDigests: [complete!.digest], maxPutAttempts: 1 })
    const graph = f.alice.transactionSetPreparer!.getOperation(id)!
    expect(graph.operationId).toBe(original.operationId)
    expect(graph.members.slice(0, originalBytes.length).map(m => m.signed!.rawTransaction)).toEqual(originalBytes)
    expect(complete!.transactionSetOperationId).toBe(id)
    expect(complete!.transactionSetStageId).toBe(`stamp-${messageId.replace(/-/g, '')}`)
    expect(complete!.payments.every(p => changes.includes(p.address.toLowerCase()))).toBe(true)
    expect(await f.alice.stealthPayments!.get(paymentId)).toEqual(f.prepared)
    expect(f.requests.length).toBeGreaterThan(0)
    expect(await f.chain.directMessages.deliveryOf!({ wallet: f.alice, payloadDigest: complete!.digest })).toBe('delivered')
    expect((await f.alice.stealthPayments!.reconcile(paymentId)).verifiedReceivedAmountAtomic).toBeGreaterThanOrEqual(300000n)
    expect(evmWalletInternals(f.alice).coinList!.all().filter(c => c.holder && c.holder !== id)).toEqual([])
    void result
  } finally { await f.close() }
})

test('restart after stamp append preserves original payment, stamp, encrypted payload, and reservations', async () => {
  const f = await setup()
  let active: EvmChainWalletHandle = f.alice
  try {
    let completed: StoredMessage | undefined
    const put = LevelOutgoingMessageStore.prototype.put
    const fail = jest.spyOn(LevelOutgoingMessageStore.prototype, 'put').mockImplementation(async function(row) {
      if (row.request) { completed = structuredClone(row); throw new Error('interrupted stage link') }
      return put.call(this, row)
    })
    await expect(f.chain.directMessages.send({ wallet: active, recipient: f.bob.identity.address,
      messageId, paymentOperationId: paymentId, stampValue: stamp,
      items: [recipientAssetPaymentFromPrepared(f.prepared)],
    })).rejects.toThrow('interrupted stage link')
    const id = evmStealthTransactionSetOperationId(paymentId)
    const original = active.transactionSetPreparer!.getOperation(id)!
    const bytes = original.members.map(m => m.signed!.rawTransaction)
    expect(f.requests).toEqual([]); expect(offlineChain.walletBroadcasts).toEqual([])
    fail.mockRestore()
    await active.close()
    active = await f.chain.createWallet(roots(0)) as EvmChainWalletHandle
    installCanonicalDirectory(active, f.directory)
    expect(active.transactionSetPreparer!.getOperation(id)!.members.map(m => m.signed!.rawTransaction)).toEqual(bytes)
    for (let i = 0; i < 6; i++) await f.chain.directMessages.reconcileAttempts({ wallet: active, payloadDigests: [completed!.digest], maxPutAttempts: 1 })
    expect(f.requests.length).toBeGreaterThan(0)
    expect(hexlify(f.requests[0]!.body).slice(2)).toBe(completed!.request!.body)
    expect(active.transactionSetPreparer!.getOperation(id)!.operationId).toBe(original.operationId)
    expect(active.transactionSetPreparer!.getOperation(id)!.members.map(m => m.signed!.rawTransaction)).toEqual(bytes)
  } finally { await active.close(); await f.close() }
})

test('stamp amount changes cannot consume a prepared payment reservation', async () => {
  const f = await setup()
  try {
    await expect(f.alice.stealthPayments!.prepare({ ...f.intent, messageStamp: { ...f.intent.messageStamp, amountAtomic: stamp + 1n } })).rejects.toThrow('stamp authorization conflict')
    await expect(f.chain.directMessages.send({ wallet: f.alice, recipient: f.bob.identity.address, messageId,
      paymentOperationId: paymentId, stampValue: stamp + 1n, items: [recipientAssetPaymentFromPrepared(f.prepared)] })).rejects.toThrow('stamp differs')
    expect(f.requests).toEqual([]); expect(offlineChain.walletBroadcasts).toEqual([])
  } finally { await f.close() }
})

test('contact payment submits the original payment, stamp, and all owned change through one wrapper', async () => {
  offlineChain.reset(); mockBalances.clear(); useProviderStandIns()
  offlineChain.relayBroadcasts = false
  const f = await fixture({ transactionSetPolicy: () => policy, spendSpacingBlocks: undefined, reserveBalanceWei: undefined })
  try {
    installCanonicalDirectory(f.alice, await f.directoryFor('alice', f.alice, f.bob))
    mockBalances.set(f.alice.mainAccount!.address.toLowerCase(), 1000000n)
    await f.alice.refreshTransactionSetInventory!()
    const prepared = await f.alice.prepareContactPayment!({ recipient: f.bob.identity.address, value: 300000n, stampValue: stamp })
    expect(offlineChain.walletBroadcasts).toHaveLength(0)
    const send = jest.spyOn(f.alice.transactionSetSubmission!, 'sendTransaction')
    let digest: string | undefined
    await f.chain.directMessages.send({ wallet: f.alice, recipient: f.bob.identity.address,
      messageId, stampValue: stamp, items: [prepared.item],
      onAttemptCreated: async value => { digest = value },
    }).catch(error => { expect(error).toBeInstanceOf(MonadStampPendingAttemptError) })
    expect(digest).toBeDefined()
    for (let i = 0; i < 6; i++) await f.chain.directMessages.reconcileAttempts({ wallet: f.alice, payloadDigests: [digest!], maxPutAttempts: 1 })
    expect(send).toHaveBeenCalled()
    const wrapper = send.mock.calls[0]![0]
    expect(wrapper.bundle).toHaveLength(2)
    expect(wrapper.otherTransactions.length).toBeGreaterThan(0)
    const graph = f.alice.transactionSetPreparer!.getOperation(wrapper.operationId)!
    expect(graph.members.every(member => member.observation.state === 'included-success')).toBe(true)
    expect(summarizeEvmNativeOperation(graph)).toMatchObject({ intendedValueWei: '300000', payment: 'included' })
    for (const member of [...wrapper.bundle, ...wrapper.otherTransactions])
      expect(offlineChain.walletBroadcasts).toContain(member.rawTransaction)
  } finally { await f.close() }
})

test('host contact recovery preserves its original message identity when the relay attempt is unknown', async () => {
  offlineChain.reset(); mockBalances.clear(); useProviderStandIns()
  const f = await fixture({ transactionSetPolicy: () => policy, spendSpacingBlocks: undefined, reserveBalanceWei: undefined })
  try {
    installCanonicalDirectory(f.alice, await f.directoryFor('alice', f.alice, f.bob))
    mockBalances.set(f.alice.mainAccount!.address.toLowerCase(), 1000000n)
    await f.alice.refreshTransactionSetInventory!()
    const prepared = await f.alice.prepareContactPayment!({ recipient: f.bob.identity.address, value: 300000n, stampValue: stamp })
    const contacts = evmWalletInternals(f.alice).receivedCoinOwner!
    const ephemeral = prepared.item.ephemeralPubKey.replace(/^0x/, '')
    const digest = 'ab'.repeat(32)
    await contacts.contactMessageAttempted([ephemeral], digest)
    const original = f.alice.getContactPayments!()[0]!
    jest.spyOn(f.chain.directMessages, 'reconcileAttempts').mockResolvedValue({ [digest]: 'unknown' })
    await f.alice.settleContactPayment!(ephemeral)
    expect(f.alice.getContactPayments!()[0]).toEqual(original)
    expect(offlineChain.walletBroadcasts).toHaveLength(0)
  } finally { await f.close() }
})

test('refused financial cancellation leaves the contact payment and its signed bytes intact', async () => {
  offlineChain.reset(); mockBalances.clear(); useProviderStandIns()
  const f = await fixture({ transactionSetPolicy: () => policy, spendSpacingBlocks: undefined, reserveBalanceWei: undefined })
  try {
    installCanonicalDirectory(f.alice, await f.directoryFor('alice', f.alice, f.bob))
    mockBalances.set(f.alice.mainAccount!.address.toLowerCase(), 1000000n)
    await f.alice.refreshTransactionSetInventory!()
    const prepared = await f.alice.prepareContactPayment!({ recipient: f.bob.identity.address, value: 300000n, stampValue: stamp })
    const original = f.alice.getContactPayments!()[0]!
    jest.spyOn(f.alice.transactionSetPreparer!, 'releaseUnexposed').mockResolvedValue(false)
    await f.alice.settleContactPayment!(prepared.item.ephemeralPubKey.replace(/^0x/, ''))
    expect(f.alice.getContactPayments!()[0]).toEqual(original)
    expect(offlineChain.walletBroadcasts).toHaveLength(0)
  } finally { await f.close() }
})

test('public construction snapshots the requested amount before refreshing inventory', async () => {
  offlineChain.reset(); mockBalances.clear(); useProviderStandIns()
  const f = await fixture({ transactionSetPolicy: () => policy, spendSpacingBlocks: undefined, reserveBalanceWei: undefined })
  try {
    mockBalances.set(f.alice.mainAccount!.address.toLowerCase(), 1000000n)
    const request = { operationId: 'snapshot-public-construction', amountAtomic: 300000n,
      kdf: () => Uint8Array.from(Buffer.from(f.bob.mainAccount!.address.slice(2), 'hex')),
      maxNativeFeeAtomic: 400000n }
    const preparing = f.alice.constructTransactionSet!(request)
    request.amountAtomic = 600000n
    const prepared = await preparing
    expect(f.alice.transactionSetPreparer!.getOperation(prepared.operationId)!.intendedValueWei).toBe('300000')
    expect(offlineChain.walletBroadcasts).toHaveLength(0)
  } finally { await f.close() }
})
