/** Real typed wallets, crypto and LevelDB; relay/node effects use the established scripted boundary. */
import {
  fixture,
  mockBalances,
  offlineChain,
  useProviderStandIns,
} from './canonical-two-wallets.testutil'
import { Transaction, getBytes, hexlify } from 'ethers'
import { EvmStampPayer } from '../evm-stamp-payer'
import { LevelOutgoingMessageStore, type StoredMessage } from './canonical-dm'
import { evmWalletInternals } from '../evm-wallet'
import { installCanonicalDirectory } from './evm-chain'
import { restoreCanonicalRequest } from '@frank/cashweb/relay/canonical-dm-transport'
import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import type { EvmTransactionSetPolicy } from '../evm-transaction-set-types'
import vectors from '../../domain-roots/vectors/domain-roots-v1.json'
import type { DomainPurpose, DomainRoot } from '../../domain-roots/src'

jest.mock('../evm-provider', () =>
  require('./canonical-two-wallets.testutil').offlineProviderModule(),
)
jest.mock('../evm-http', () =>
  require('./canonical-two-wallets.testutil').offlineHttpModule(),
)
jest.mock('@frank/cashweb/relay/mailbox-client', () =>
  require('./canonical-two-wallets.testutil').offlineMailboxModule(),
)
const policy: EvmTransactionSetPolicy = {
  sourceOrder: [
    'stealth',
    'stamp',
    'change',
    'deterministic',
    'root',
    'identity',
  ],
  gasPriceWei: 1n,
  paymentGasLimit: () => 21000n,
  changeGasLimit: 21000n,
  paymentFeeIsExact: true,
  dustWei: 210000n,
  radix: 2,
  jitterBps: 1500,
  maxChangeOutputs: 20,
  head: 100,
}
const id = '11111111-2222-4333-8444-555555555555'
function roots() {
  const root = <P extends DomainPurpose>(purpose: P): DomainRoot<P> => ({
    registry: 'frank-domain-roots-v1',
    purpose,
    bytes: getBytes('0x' + vectors.vectors[0].outputs[purpose]),
  })
  return {
    evm: root('evm-wallet'),
    authentication: root('identity-authentication'),
    messaging: root('messaging-encryption'),
  }
}
async function setup() {
  offlineChain.reset()
  mockBalances.clear()
  useProviderStandIns()
  const f = await fixture({
    transactionSetPolicy: () => policy,
    spendSpacingBlocks: undefined,
    reserveBalanceWei: undefined,
  })
  const directory = await f.directoryFor('alice', f.alice, f.bob)
  installCanonicalDirectory(f.alice, directory)
  const main = f.alice.mainAccount!
  mockBalances.set(main.address.toLowerCase(), 1000000n)
  await evmWalletInternals(f.alice).coinList!.put({
    account: main.address,
    privateKey: main.privateKey,
    nonce: 0,
    valueWei: 1000000n,
    origin: 'root',
  })
  await f.alice.refreshTransactionSetInventory?.()
  return { ...f, directory }
}
afterEach(() => {
  jest.restoreAllMocks()
  useProviderStandIns(false)
})

test('stamp send persists its encrypted construction before the shared signature and keeps change out of recipient evidence', async () => {
  const f = await setup()
  try {
    const rows: StoredMessage[] = []
    const put = LevelOutgoingMessageStore.prototype.put
    jest
      .spyOn(LevelOutgoingMessageStore.prototype, 'put')
      .mockImplementation(async function (row) {
        rows.push(structuredClone(row))
        return put.call(this, row)
      })
    const prep = f.alice.transactionSetPreparer!
    const construct = prep.constructTransactionSet.bind(prep)
    const sign = jest.spyOn(EvmStampPayer.prototype, 'sign')
    jest
      .spyOn(prep, 'constructTransactionSet')
      .mockImplementation(async (request) => {
        expect(rows[0]?.construction?.payload).toBeTruthy()
        expect(f.requests).toEqual([])
        return construct(request)
      })
    const result = await f.chain.directMessages.send({
      wallet: f.alice,
      recipient: f.bob.identity.address,
      messageId: id,
      stampValue: 300000n,
      items: [{ type: 'text', text: 'shared signature' }],
    })
    const row = rows.find((candidate) => candidate.request)!
    // Completion retains the immutable encrypted construction for stable-ID recovery.
    expect(row.construction).toEqual(rows[0]!.construction)
    expect(row.request).toBeDefined()
    expect(row.payments.length).toBeGreaterThan(0)
    expect(row.otherTransactions.length).toBeGreaterThan(0)
    const relay = restoreCanonicalRequest(f.requests[0]!)
    expect(relay.parts.transactions.map((raw) => hexlify(raw))).toEqual(
      row.payments.map((payment) => payment.rawTx),
    )
    for (const change of row.otherTransactions)
      expect(relay.parts.transactions.map((raw) => hexlify(raw))).not.toContain(
        change.rawTx,
      )
    expect(result.stampValueWei).toBe(300000n)
    expect(sign).not.toHaveBeenCalled()
  } finally {
    await f.close()
  }
})

test('restart after core persistence finishes the original encrypted message and signed bytes', async () => {
  const f = await setup()
  let active: EvmChainWalletHandle = f.alice
  try {
    const rows: StoredMessage[] = []
    let interruptedCompletion: StoredMessage | undefined
    let messageStore: LevelOutgoingMessageStore | undefined
    const originalPut = LevelOutgoingMessageStore.prototype.put
    const fail = jest
      .spyOn(LevelOutgoingMessageStore.prototype, 'put')
      .mockImplementation(async function (row) {
        rows.push(structuredClone(row))
        messageStore = this
        if (row.request && row.payments.length > 0) {
          interruptedCompletion = structuredClone(row)
          throw new Error('interrupted encrypted host completion')
        }
        return originalPut.call(this, row)
      })
    await expect(
      f.chain.directMessages.send({
        wallet: active,
        recipient: f.bob.identity.address,
        messageId: id,
        stampValue: 300000n,
        items: [{ type: 'text', text: 'original encrypted body' }],
      }),
    ).rejects.toThrow('interrupted encrypted host completion')
    expect(interruptedCompletion).toBeDefined()
    expect(interruptedCompletion!.construction).toEqual(rows[0]!.construction)
    const persisted = messageStore!.get(rows[0]!.consumerId)!
    expect(persisted.construction).toEqual(rows[0]!.construction)
    expect(persisted.request).toBeUndefined()
    expect(persisted.payments).toEqual([])
    expect(persisted.otherTransactions).toEqual([])
    const original = active.transactionSetPreparer!.getOperation(
      'stamp-' + id.replace(/-/g, ''),
    )!
    expect(original.members.length).toBeGreaterThan(0)
    expect(original.members.every((member) => member.signed)).toBe(true)
    expect(f.requests).toEqual([])
    expect(offlineChain.walletBroadcasts).toEqual([])
    fail.mockRestore()
    await active.close()
    active = (await f.chain.createWallet(roots())) as EvmChainWalletHandle
    installCanonicalDirectory(active, f.directory)
    const before = active.transactionSetPreparer!.getOperation(
      'stamp-' + id.replace(/-/g, ''),
    )!
    expect(
      before.members.map((member) => member.signed!.rawTransaction),
    ).toEqual(original.members.map((member) => member.signed!.rawTransaction))
    await f.chain.directMessages.reconcileAttempts({
      wallet: active,
      payloadDigests: [rows[0]!.digest],
      maxPutAttempts: 1,
    })
    expect(f.requests).toHaveLength(1)
    const relay = restoreCanonicalRequest(f.requests[0]!)
    expect({
      body: hexlify(f.requests[0]!.body).slice(2),
      contentType: f.requests[0]!.contentType,
    }).toEqual(interruptedCompletion!.request)
    expect(hexlify(relay.parts.context).slice(2)).toBe(
      rows[0]!.construction!.context,
    )
    expect(
      relay.parts.transactions.map(
        (raw) => Transaction.from(hexlify(raw)).hash,
      ),
    ).toEqual(
      original.members
        .filter((member) => member.transactionSet?.role === 'payment')
        .map((member) => member.signed!.transactionHash),
    )
    const recovered = active.transactionSetPreparer!.getOperation(
      'stamp-' + id.replace(/-/g, ''),
    )!
    expect(recovered.members.map((member) => member.signed!.rawTransaction)).toEqual(
      original.members.map((member) => member.signed!.rawTransaction),
    )
  } finally {
    await active.close()
    await f.close()
  }
})

test('ambiguous relay submission reopens with the same signed recipient and change transactions reserved', async () => {
  const f = await setup()
  let active: EvmChainWalletHandle = f.alice
  try {
    const rows: StoredMessage[] = []
    const put = LevelOutgoingMessageStore.prototype.put
    const capture = jest.spyOn(LevelOutgoingMessageStore.prototype, 'put')
      .mockImplementation(async function (row) {
        rows.push(structuredClone(row))
        return put.call(this, row)
      })
    f.setPhase('fail')
    await expect(
      f.chain.directMessages.send({
        wallet: active,
        recipient: f.bob.identity.address,
        messageId: id,
        stampValue: 300000n,
        items: [{ type: 'text', text: 'ambiguous submission' }],
      }),
    ).rejects.toThrow()
    const consumerId = `frank-dm:${id.replace(/-/g, '')}`
    const stored = rows.find(row => row.consumerId === consumerId && row.request)!
    expect(stored.request).toBeDefined()
    expect(stored.payments.length).toBeGreaterThan(0)
    expect(stored.otherTransactions.length).toBeGreaterThan(0)
    const operationId = stored.transactionSetOperationId!
    const original = active.transactionSetPreparer!.getOperation(operationId)!
    const originalBytes = original.members.map(member => member.signed!.rawTransaction)
    expect(original.members.filter(member => member.transactionSet?.role === 'change'))
      .toHaveLength(stored.otherTransactions.length)
    expect(original.members.filter(member => member.transactionSet?.role === 'payment')
      .some(member => !member.exposed)).toBe(true)
    expect(evmWalletInternals(active).coinList!.heldBy(operationId).length)
      .toBe(original.members.length)
    // Lower-nonce private change may precede the payment. Recipient bytes and
    // successor change must remain withheld until the original relay attempt resolves.
    for (const raw of offlineChain.walletBroadcasts) {
      expect(stored.otherTransactions.some(change => change.rawTx === raw)).toBe(true)
      const change = Transaction.from(raw)
      const payment = stored.payments.map(item => Transaction.from(item.rawTx))
        .find(item => item.from === change.from)!
      expect(change.nonce).toBeLessThan(payment.nonce)
    }
    await active.close()
    active = (await f.chain.createWallet(roots())) as EvmChainWalletHandle
    installCanonicalDirectory(active, f.directory)
    const reopened = active.transactionSetPreparer!.getOperation(operationId)!
    expect(reopened.members.map(member => member.signed!.rawTransaction)).toEqual(originalBytes)
    expect(active.transactionSetPreparer!.getOperation(operationId)!.members).toEqual(
      expect.arrayContaining(reopened.members.filter(member => member.signed)),
    )
    f.setPhase('delivered')
    await active.refreshTransactionSetInventory?.()
    await f.chain.directMessages.reconcileAttempts({
      wallet: active,
      payloadDigests: [stored.digest],
      maxPutAttempts: 1,
    })
    expect(f.requests).toHaveLength(1)
    expect(hexlify(f.requests[0]!.body).slice(2)).toBe(stored.request!.body)
    const relay = restoreCanonicalRequest(f.requests[0]!)
    expect(relay.parts.transactions.map(raw => Transaction.from(hexlify(raw)).hash)).toEqual(
      stored.payments.map(payment => Transaction.from(payment.rawTx).hash),
    )
    expect(relay.parts.transactions.map(raw => hexlify(raw))).not.toEqual(
      expect.arrayContaining(stored.otherTransactions.map(payment => payment.rawTx)),
    )
    capture.mockRestore()
  } finally {
    await active.close()
    await f.close()
  }
})
