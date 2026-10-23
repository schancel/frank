import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Interface, Transaction, Wallet } from 'ethers'
import { getEvmDexDeployment } from '../chain/dex-deployments'
import {
  LevelRecordStore,
  refreshStoredEvmNativePaymentSet,
  applyStoredNativeCoinObservation,
  markStoredEvmCoinNoted,
  registerStoredEvmErc20Payment,
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
  it('retains the intended amount separately from a signed residual gift across reopen', async () => {
    const raw = await signed(senders[0]!, 2010n)
    const result = await registerStoredEvmNativePaymentSet(store, note.address, payment([raw]))
    expect(result.claimedAmountWei).toBe('2000')
    expect(result.amountWei).toBe('0')
    expect(result.state).toBe('pending')
    await reopen()
    expect(store.get(note.address)).toEqual(result)
    await expect(registerStoredEvmNativePaymentSet(store, note.address, payment([raw]))).resolves.toEqual(result)
  })
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
      { ...payment(raws), amountWei: 3000n },
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
  it('updates canonical received totals across partial/full/reorg evidence without treating balances as receipt value', async () => {
    const raws = await Promise.all(senders.map(sender => signed(sender)))
    const claim = payment(raws)
    await registerStoredEvmNativePaymentSet(store, note.address, claim)
    let at = 10
    for (const [values, expected, complete] of [
      [[1000n, undefined], 1000n, false],
      [[1000n, 1000n], 2000n, true],
      [[undefined, 1000n], 1000n, false],
      [[undefined, undefined], 0n, false],
      [[0n, 0n], 0n, true],
      [[1000n, 1000n], 2000n, true],
    ] as const) {
      const result = await refreshStoredEvmNativePaymentSet(
        store,
        note.address,
        claim,
        async (address, original) => {
          expect(address).toBe(note.address)
          expect(original).toEqual(raws)
          return { balanceWei: 777n, receivedAmountsWei: values }
        },
        at++,
      )
      expect(result.applied).toBe(true)
      expect(result.verifiedReceivedAmountWei).toBe(expected)
      expect(result.complete).toBe(complete)
      expect(result.allFailed).toBe(values.every(value => value === 0n))
      expect(result.coin.receivedAmountWei).toBe(expected.toString())
      expect(result.coin.amountWei).toBe('777')
      expect(result.coin.claimedAmountWei).toBe('2000')
    }
    await reopen()
    expect(store.get(note.address)!.receivedAmountWei).toBe('2000')
  })
  it('rejects observation of another/subset claim and impossible member evidence without changes', async () => {
    const raws = await Promise.all(senders.map(sender => signed(sender))),
      claim = payment(raws)
    await registerStoredEvmNativePaymentSet(store, note.address, claim)
    const before = store.get(note.address)
    for (const invalid of [
      { ...claim, payloadDigest: 'cd'.repeat(32) },
      { ...claim, rawTransactions: [raws[0]!], amountWei: 1000n },
    ])
      await expect(
        refreshStoredEvmNativePaymentSet(
          store,
          note.address,
          invalid,
          async () => ({ balanceWei: 0n, receivedAmountsWei: [1000n, 1000n] }),
          10,
        ),
      ).rejects.toThrow()
    for (const evidence of [
      { balanceWei: 0n, receivedAmountsWei: [999n, 1000n] },
      { balanceWei: -1n, receivedAmountsWei: [1000n, 1000n] },
      { balanceWei: 0n, receivedAmountsWei: [1000n] },
    ])
      await expect(
        refreshStoredEvmNativePaymentSet(
          store,
          note.address,
          claim,
          async () => evidence,
          10,
        ),
      ).rejects.toThrow()
    expect(store.get(note.address)).toEqual(before)
  })
  it('merges unrelated facts during RPC and refuses a stale native result', async () => {
    const raws = await Promise.all(senders.map(sender => signed(sender))),
      claim = payment(raws)
    await registerStoredEvmNativePaymentSet(store, note.address, claim)
    const merged = await refreshStoredEvmNativePaymentSet(
      store,
      note.address,
      claim,
      async () => {
        const token = getEvmDexDeployment('monad-testnet')!.tokens.find(
          token => token.symbol === 'USDC',
        )!.address!
        const raw = await senders[0]!.signTransaction({
          type: 2,
          chainId: 10143n,
          nonce: 7,
          to: token,
          value: 0n,
          data: new Interface([
            'function transfer(address to,uint256 amount)',
          ]).encodeFunctionData('transfer', [note.address, 7n]),
          gasLimit: 100000n,
          maxFeePerGas: 1n,
          maxPriorityFeePerGas: 1n,
        })
        await registerStoredEvmErc20Payment(store, note.address, {
          chainIdentifier: 'monad-testnet',
          contractAddress: token,
          rawTransaction: raw,
          amountBaseUnits: 7n,
          payloadDigest: 'cd'.repeat(32),
          discoveredAtMs: 15,
        })
        await markStoredEvmCoinNoted(store, note.address, 15)
        return { balanceWei: 777n, receivedAmountsWei: [1000n, undefined] }
      },
      20,
    )
    expect(merged.applied).toBe(true)
    expect(merged.coin.notedAtMs).toBe(15)
    expect(merged.coin.erc20Positions![0]!.claims[0]!.amountBaseUnits).toBe('7')
    const stale = await refreshStoredEvmNativePaymentSet(
      store,
      note.address,
      claim,
      async () => {
        await applyStoredNativeCoinObservation(store, note.address, {
          balanceWei: 999n,
          transfer: 'none',
          atMs: 30,
        })
        return { balanceWei: 0n, receivedAmountsWei: [undefined, undefined] }
      },
      40,
    )
    expect(stale.applied).toBe(false)
    expect(stale.coin.amountWei).toBe('999')
    expect(stale.coin.receivedAmountWei).toBe('1000')
    expect(stale.coin.checkedAtMs).toBe(30)
    expect(stale.coin.notedAtMs).toBe(15)
    expect(stale.coin.erc20Positions).toEqual(merged.coin.erc20Positions)
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
