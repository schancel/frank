/** Real typed wallets, crypto and LevelDB; relay/node effects use the established scripted boundary. */
import {
  fixture,
  mockBalances,
  offlineChain,
  useProviderStandIns,
} from './canonical-two-wallets.testutil'
import { Transaction, getBytes, hexlify } from 'ethers'
import { LevelOutgoingMessageStore, type StoredMessage } from './canonical-dm'
import { evmWalletInternals } from '../evm-wallet'
import { installCanonicalDirectory } from './evm-chain'
import {
  restoreCanonicalRequest,
  type CanonicalFetch,
} from '@frank/cashweb/relay/canonical-dm-transport'
import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import type { EvmTransactionSetPolicy } from '../evm-transaction-set-types'
import vectors from '../../domain-roots/vectors/domain-roots-v1.json'
import type { DomainPurpose, DomainRoot } from '../../domain-roots/src'

jest.mock('../evm-provider', () =>
  require('./canonical-two-wallets.testutil').offlineProviderModule()
)
jest.mock('../evm-http', () =>
  require('./canonical-two-wallets.testutil').offlineHttpModule()
)
jest.mock('@frank/cashweb/relay/mailbox-client', () =>
  require('./canonical-two-wallets.testutil').offlineMailboxModule()
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

test.each(['undeliverable', 'stale_nonce', 'insufficient_total'])(
  'a recovered shared payment keeps its original delivery after %s',
  async (reason) => {
    const f = await setup()
    let active = f.alice
    let latest: StoredMessage | undefined
    let requests = 0
    let reject = true
    const originalPut = LevelOutgoingMessageStore.prototype.put
    jest
      .spyOn(LevelOutgoingMessageStore.prototype, 'put')
      .mockImplementation(async function (row) {
        latest = structuredClone(row)
        return originalPut.call(this, row)
      })
    const fetch: CanonicalFetch = async (url, init) => {
      requests++
      if (!reject) return f.directory.fetch!(url, init)
      const request = {
        body: new Uint8Array(init.body!),
        contentType: init.headers['Content-Type'],
      }
      const answer = new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          phase: 'dead',
          identity: restoreCanonicalRequest(request).identity,
          reason,
        })
      )
      let read = false
      return {
        status: 200,
        url,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'content-type' ? 'application/json' : null,
        },
        body: {
          getReader: () => ({
            read: async () =>
              read
                ? { done: true }
                : ((read = true), { done: false, value: answer }),
            cancel: async () => undefined,
            releaseLock: () => undefined,
          }),
        },
      }
    }
    const directory = { ...f.directory, fetch }
    try {
      installCanonicalDirectory(active, directory)
      await expect(
        f.chain.directMessages.send({
          wallet: active,
          recipient: f.bob.identity.address,
          messageId: id,
          stampValue: 300000n,
          items: [{ type: 'text', text: 'must deliver once paid' }],
          onAttemptCreated: async () => {
            throw new Error('interrupted before exposure')
          },
        })
      ).rejects.toThrow('interrupted before exposure')
      expect(requests).toBe(0)
      expect(offlineChain.walletBroadcasts).toHaveLength(0)
      expect(latest!.unexposed).toBe(true)
      const digest = latest!.digest
      const originalRequest = structuredClone(latest!.request)
      const originalPayments = latest!.payments.map((payment) => payment.rawTx)
      const originalChange = latest!.otherTransactions.map(
        (payment) => payment.rawTx
      )
      await active.close()
      active = (await f.chain.createWallet(roots())) as EvmChainWalletHandle
      installCanonicalDirectory(active, directory)
      await f.chain.directMessages.reconcileAttempts({
        wallet: active,
        payloadDigests: [digest],
        maxPutAttempts: 1,
      })
      expect(requests).toBe(1)
      expect(latest!.outcome).toBeUndefined()
      expect(offlineChain.walletBroadcasts.length).toBeGreaterThan(0)
      const broadcastHashes = offlineChain.walletBroadcasts.map(
        (raw) => Transaction.from(raw).hash
      )
      for (const payment of latest!.payments)
        expect(broadcastHashes).toContain(Transaction.from(payment.rawTx).hash)
      expect(latest!.request).toEqual(originalRequest)
      await active.close()
      active = (await f.chain.createWallet(roots())) as EvmChainWalletHandle
      installCanonicalDirectory(active, directory)
      reject = false
      await f.chain.directMessages.reconcileAttempts({
        wallet: active,
        payloadDigests: [digest],
        maxPutAttempts: 1,
      })
      expect(requests).toBe(2)
      expect(latest!.outcome).toBe('delivered')
      expect({
        body: hexlify(f.requests[0]!.body).slice(2),
        contentType: f.requests[0]!.contentType,
      }).toEqual(originalRequest)
      expect(latest!.payments.map((payment) => payment.rawTx)).toEqual(
        originalPayments
      )
      expect(latest!.otherTransactions.map((payment) => payment.rawTx)).toEqual(
        originalChange
      )
      expect(new Set(offlineChain.walletBroadcasts)).toEqual(
        new Set([...originalPayments, ...originalChange])
      )
    } finally {
      await active.close()
      await f.close()
    }
  }
)


test('a delivered chat remains delivered when post-delivery RPC fails and restart recovers the original change', async () => {
  // Keep the recipient first so owned change is still owed when the node goes away.
  jest.spyOn(Math, 'random').mockReturnValue(0.99)
  const f = await setup()
  offlineChain.broadcastDown = true
  let active = f.alice
  let latest: StoredMessage | undefined
  let requests = 0
  const put = LevelOutgoingMessageStore.prototype.put
  jest.spyOn(LevelOutgoingMessageStore.prototype, 'put').mockImplementation(async function (row) {
    latest = structuredClone(row)
    return put.call(this, row)
  })
  const fetch: CanonicalFetch = async (url, init) => {
    requests++
    const delivered = await f.directory.fetch!(url, init)
    // The relay has accepted the envelope; subsequent wallet chain reads fail.
    offlineChain.broadcastDown = false
    offlineChain.nodeDown = true
    return delivered
  }
  try {
    installCanonicalDirectory(active, { ...f.directory, fetch })
    const result = await f.chain.directMessages.send({ wallet: active,
      recipient: f.bob.identity.address, messageId: id, stampValue: 300000n,
      items: [{ type: 'text', text: 'delivered with RPC unavailable' }] })
    expect(latest!.outcome).toBe('delivered')
    expect(result.payloadDigest).toBe(latest!.digest)
    expect(requests).toBe(1)
    const original = structuredClone(latest!)
    expect(original.otherTransactions.length).toBeGreaterThan(0)
    expect(original.otherTransactions.some(tx => tx.state === 'pending')).toBe(true)
    await active.close()
    offlineChain.nodeDown = false
    active = await f.chain.createWallet(roots()) as EvmChainWalletHandle
    installCanonicalDirectory(active, { ...f.directory, fetch })
    await f.chain.directMessages.reconcileAttempts({ wallet: active,
      payloadDigests: [original.digest], maxPutAttempts: 1 })
    expect(requests).toBe(1)
    expect(latest!.outcome).toBe('delivered')
    expect(latest!.transactionSetOperationId).toBe(original.transactionSetOperationId)
    expect(latest!.request).toEqual(original.request)
    expect(latest!.payments.map(tx => tx.rawTx)).toEqual(original.payments.map(tx => tx.rawTx))
    expect(latest!.otherTransactions.map(tx => tx.rawTx)).toEqual(original.otherTransactions.map(tx => tx.rawTx))
    expect(latest!.payments.every(tx => tx.state === 'spent')).toBe(true)
    expect(latest!.otherTransactions.every(tx => tx.state === 'spent')).toBe(true)
    const authorized = new Set([...original.payments, ...original.otherTransactions].map(tx => tx.rawTx))
    expect(offlineChain.walletBroadcasts.every(raw => authorized.has(raw))).toBe(true)
  } finally { offlineChain.broadcastDown = false; offlineChain.nodeDown = false; await active.close(); await f.close() }
})
