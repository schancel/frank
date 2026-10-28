import { Transaction, Wallet } from 'ethers'
import {
  applyStoredNativeStampRecovery,
  MemoryRecordStore,
  recordStoredEvmCoin,
  receivedCoinNoteOf,
  receivedPaymentOf,
  validateNativeStampRecovery,
  type EvmCoin,
  type EvmNativeStampRecovery,
} from './evm-coin-store'

const sender = new Wallet('0x' + '11'.repeat(32))
const recipient = new Wallet('0x' + '22'.repeat(32))
const hash = '0x' + '33'.repeat(32)
const blockHash = '0x' + '44'.repeat(32)
async function fixture() {
  const raw = await sender.signTransaction({
    chainId: 10143,
    to: recipient.address,
    value: 100n,
    nonce: 0,
    gasLimit: 21000n,
    gasPrice: 1n,
  })
  const coin: EvmCoin = {
    address: recipient.address.toLowerCase(),
    privateKey: recipient.privateKey,
    origin: 'stamp',
    state: 'pending',
    amountWei: '0',
    claimedAmountWei: '100',
    transactions: [raw.slice(2)],
    childIndex: 0,
    stampSharedPoint: sender.signingKey.compressedPublicKey.slice(2),
    payloadDigest: 'ab'.repeat(32),
    discoveredAtMs: 1,
  }
  const recovery: EvmNativeStampRecovery = {
    chainIdentifier: 'monad-testnet',
    originalTransactionHash: Transaction.from(raw).hash!,
    supersededAt: { blockNumber: 1, blockHash },
    receipts: [
      {
        chainIdentifier: 'monad-testnet',
        txHash: hash,
        from: sender.address.toLowerCase(),
        to: coin.address,
        amount: '30',
        blockNumber: 2,
        blockHash,
        blockTimeMs: 2000,
      },
    ],
  }
  const store = new MemoryRecordStore<EvmCoin>()
  await recordStoredEvmCoin(store, coin)
  return {
    store,
    coin,
    recovery,
    observation: {
      recovery,
      balanceWei: 30n,
      accountNonce: 0,
      atMs: 3,
      canonicalBlocks: [{ blockNumber: 2, blockHash }],
    },
  }
}

it('merges repeated receipt identities, keeps exact original note membership and separates actual from stated', async () => {
  const { store, coin, recovery, observation } = await fixture()
  await applyStoredNativeStampRecovery(store, coin.address, observation)
  await applyStoredNativeStampRecovery(store, coin.address, observation)
  await recordStoredEvmCoin(store, coin)
  const observed = store.get(coin.address)!
  expect(observed.nativeStampRecovery?.receipts).toHaveLength(1)
  expect(receivedPaymentOf(observed)).toMatchObject({
    status: 'received',
    receivedAmountWei: 30n,
    claimedAmountWei: 100n,
    partial: true,
  })
  expect(observed.transactions).toEqual(coin.transactions)
  expect(observed.settledTransactions).toBeUndefined()
  expect(receivedCoinNoteOf(observed, recovery.chainIdentifier)?.transactions).toEqual(
    coin.transactions,
  )
})
it.each([
  'wrong chain',
  'wrong address',
  'wrong original',
  'duplicate receipt',
  'negative amount',
  'wrong key',
  'wrong child index',
])('rejects stored recovery %s', async kind => {
  const { coin, recovery } = await fixture()
  const candidate = { ...coin, nativeStampRecovery: recovery }
  if (kind === 'wrong chain') Object.assign(recovery, { chainIdentifier: 'ethereum-sepolia' })
  if (kind === 'wrong address')
    Object.assign(recovery.receipts[0]!, { to: sender.address.toLowerCase() })
  if (kind === 'wrong original') Object.assign(recovery, { originalTransactionHash: hash })
  if (kind === 'duplicate receipt')
    Object.assign(recovery, { receipts: [...recovery.receipts, ...recovery.receipts] })
  if (kind === 'negative amount') Object.assign(recovery.receipts[0]!, { amount: '-1' })
  if (kind === 'wrong key') Object.assign(candidate, { privateKey: sender.privateKey })
  if (kind === 'wrong child index') Object.assign(candidate, { childIndex: -1 })
  expect(() => validateNativeStampRecovery(candidate, 'monad-testnet')).toThrow()
})
it('does not erase prior facts when a subsequent observation has no newly readable receipts', async () => {
  const { store, coin, observation } = await fixture()
  await applyStoredNativeStampRecovery(store, coin.address, observation)
  await applyStoredNativeStampRecovery(store, coin.address, {
    ...observation,
    recovery: { ...observation.recovery, receipts: [] },
    canonicalBlocks: [],
    atMs: 4,
  })
  expect(store.get(coin.address)?.receivedAmountWei).toBe('30')
})
it('removes a contradicted receipt by canonical block identity, and can learn the re-included transaction once', async () => {
  const { store, coin, recovery, observation } = await fixture()
  await applyStoredNativeStampRecovery(store, coin.address, observation)
  const newHash = '0x' + '55'.repeat(32)
  await applyStoredNativeStampRecovery(store, coin.address, {
    ...observation,
    balanceWei: 0n,
    recovery: { ...recovery, receipts: [] },
    canonicalBlocks: [{ blockNumber: 2, blockHash: newHash }],
    atMs: 4,
  })
  expect(store.get(coin.address)?.receivedAmountWei).toBe('0')
  await applyStoredNativeStampRecovery(store, coin.address, {
    ...observation,
    recovery: { ...recovery, receipts: [{ ...recovery.receipts[0]!, blockHash: newHash }] },
    canonicalBlocks: [{ blockNumber: 2, blockHash: newHash }],
    atMs: 5,
  })
  expect(store.get(coin.address)?.nativeStampRecovery?.receipts).toHaveLength(1)
  expect(store.get(coin.address)?.receivedAmountWei).toBe('30')
})
it('merges against a concurrent self-note write and refuses an older account observation', async () => {
  const { store, coin, observation } = await fixture()
  const compare = store.compareAndPut.bind(store)
  let raced = false
  jest.spyOn(store, 'compareAndPut').mockImplementation(async (key, expected, next) => {
    if (!raced) {
      raced = true
      await store.put(key, { ...store.get(key)!, notedAtMs: 99 })
    }
    return compare(key, expected, next)
  })
  await applyStoredNativeStampRecovery(store, coin.address, observation)
  expect(store.get(coin.address)?.notedAtMs).toBe(99)
  await applyStoredNativeStampRecovery(store, coin.address, {
    ...observation,
    balanceWei: 0n,
    accountNonce: 1,
    atMs: 2,
  })
  expect(store.get(coin.address)?.amountWei).toBe('30')
})
