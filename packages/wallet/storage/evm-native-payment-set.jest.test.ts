import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Transaction, Wallet } from 'ethers'
import {
  LevelRecordStore,
  recordStoredEvmCoin,
  registerStoredEvmNativePayment,
  registerStoredEvmNativePaymentSet,
  type EvmCoin,
} from './evm-coin-store'

const recipient = new Wallet('0x' + '33'.repeat(32))
const senders = [11, 12].map(
  n => new Wallet('0x' + n.toString(16).padStart(64, '0')),
)
const note: EvmCoin = {
  address: recipient.address.toLowerCase(),
  privateKey: recipient.privateKey,
  origin: 'stealth',
  state: 'pending',
  amountWei: '0',
  claimedAmountWei: '0',
  transactions: [],
  ephemeralPubKey: senders[0]!.signingKey.compressedPublicKey.slice(2),
  discoveredAtMs: 1,
  erc20Positions: [],
}
const signed = (
  sender = senders[0]!,
  value = 1000n,
  nonce = 0,
  chainId = 10143n,
  to = note.address,
) =>
  sender.signTransaction({
    type: 2,
    chainId,
    nonce,
    to,
    value,
    gasLimit: 21000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
  })
const payment = (rawTransactions: readonly string[]) => ({
  chainIdentifier: 'monad-testnet',
  ephemeralPubKey: note.ephemeralPubKey!,
  rawTransactions,
  amountWei: 2000n,
  payloadDigest: 'ab'.repeat(32),
})

describe('atomic native received payment sets', () => {
  let root: string, store: LevelRecordStore<EvmCoin>
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'frank-native-receipt-set-'))
    store = await LevelRecordStore.open(root, 'native-receipt-test')
    await recordStoredEvmCoin(store, note)
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await store.close()
    await rm(root, { recursive: true, force: true })
  })
  async function reopen() {
    await store.close()
    store = await LevelRecordStore.open(root, 'native-receipt-test')
  }
  it('persists the exact whole set across reopen without crediting balances and rejects subset/reordered/replaced claims', async () => {
    const raws = await Promise.all(senders.map(sender => signed(sender)))
    const original = await registerStoredEvmNativePaymentSet(
      store,
      note.address,
      payment(raws),
    )
    expect(original).toEqual({
      ...note,
      transactions: raws.map(raw => raw.slice(2)),
      claimedAmountWei: '2000',
      payloadDigest: 'ab'.repeat(32),
    })
    await reopen()
    await expect(
      registerStoredEvmNativePaymentSet(store, note.address, payment(raws)),
    ).resolves.toEqual(original)
    for (const input of [
      { ...payment(raws), rawTransactions: [raws[0]!], amountWei: 1000n },
      payment([...raws].reverse()),
      payment([raws[0]!, await signed(senders[1]!, 1000n, 1)]),
      { ...payment(raws), amountWei: 1999n },
      { ...payment(raws), payloadDigest: 'cd'.repeat(32) },
    ])
      await expect(
        registerStoredEvmNativePaymentSet(store, note.address, input),
      ).rejects.toThrow()
    expect(store.get(note.address)).toEqual(original)
  })
  it('rejects duplicate hash/source nonce, chain/recipient/derivation/amount mismatch before mutation', async () => {
    const raws = await Promise.all(senders.map(sender => signed(sender)))
    for (const input of [
      payment([raws[0]!, raws[0]!]),
      payment([raws[0]!, await signed(senders[0]!, 1000n)]),
      {
        ...payment(raws),
        rawTransactions: [raws[0]!, await signed(senders[0]!, 999n)],
        amountWei: 1999n,
      },
      payment([raws[0]!, await signed(senders[1]!, 1000n, 0, 1n)]),
      payment([
        raws[0]!,
        await signed(senders[1]!, 1000n, 0, 10143n, senders[0]!.address),
      ]),
      {
        ...payment(raws),
        ephemeralPubKey: senders[1]!.signingKey.compressedPublicKey.slice(2),
      },
      { ...payment(raws), chainIdentifier: 'monad' },
      { ...payment(raws), amountWei: 1000n },
      { ...payment(raws), payloadDigest: 'bad' },
      { ...payment(raws), rawTransactions: [] },
    ]) {
      await expect(
        registerStoredEvmNativePaymentSet(store, note.address, input),
      ).rejects.toThrow()
      expect(store.get(note.address)).toEqual(note)
    }
  })
  it('has no partial set when the single atomic claim write is interrupted', async () => {
    const raws = await Promise.all(senders.map(sender => signed(sender)))
    jest
      .spyOn(store, 'compareAndPut')
      .mockRejectedValueOnce(new Error('interrupted before claim commit'))
    await expect(
      registerStoredEvmNativePaymentSet(store, note.address, payment(raws)),
    ).rejects.toThrow('interrupted')
    await reopen()
    expect(store.get(note.address)).toEqual(note)
    await registerStoredEvmNativePaymentSet(store, note.address, payment(raws))
    await reopen()
    expect(store.get(note.address)!.transactions).toEqual(
      raws.map(raw => raw.slice(2)),
    )
  })
  it('admits only one concurrent conflicting complete claim and preserves native/token observations', async () => {
    const observed = {
      ...note,
      state: 'unspent' as const,
      amountWei: '777',
      receivedAmountWei: '888',
      checkedAtMs: 10,
    }
    await store.compareAndPut(note.address, note, observed)
    const a = payment(await Promise.all(senders.map(sender => signed(sender))))
    const b = payment(
      await Promise.all(senders.map(sender => signed(sender, 1000n, 1))),
    )
    const results = await Promise.allSettled([
      registerStoredEvmNativePaymentSet(store, note.address, a),
      registerStoredEvmNativePaymentSet(store, note.address, b),
    ])
    expect(
      results.filter(result => result.status === 'fulfilled'),
    ).toHaveLength(1)
    expect(store.get(note.address)).toMatchObject({
      amountWei: '777',
      receivedAmountWei: '888',
      checkedAtMs: 10,
      erc20Positions: [],
    })
    expect(store.get(note.address)!.transactions).toHaveLength(2)
  })
  it('keeps singleton registration on the same validator and persistence path', async () => {
    const raw = await signed()
    const input = { ...payment([raw]), rawTransaction: raw, amountWei: 1000n }
    const result = await registerStoredEvmNativePayment(
      store,
      note.address,
      input,
    )
    await reopen()
    await expect(
      registerStoredEvmNativePaymentSet(store, note.address, input),
    ).resolves.toEqual(result)
    expect(Transaction.from('0x' + result.transactions[0]!).value).toBe(1000n)
  })
})
