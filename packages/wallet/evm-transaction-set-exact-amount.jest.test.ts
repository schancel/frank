/**
 * The recipient receives exactly the intended amount. Residual value stays with the sender:
 * in fresh change accounts when the radix split can carry it, otherwise on the source
 * account's next nonce. Fees are never taken from the recipient's amount and residuals are
 * never gifted to it (AGENTS.md §3, payment operations).
 *
 * Values mirror monad-regtest QA runs: gas price 102 gwei, dust ten transfer fees, radix 2.
 */
import { Transaction, Wallet, parseEther } from 'ethers'
import { EvmCoinList } from './evm-coin-list'
import { MemoryRecordStore } from './storage/evm-coin-store'
import { EvmNativeOperationJournal } from './storage/evm-native-operation-journal'
import { EvmTransactionSetPreparer } from './evm-transaction-set'
import type {
  EvmTransactionSetPolicy,
  PreparedEvmTransactionSet,
} from './evm-transaction-set-types'

const signer = (index: number) =>
  new Wallet('0x' + index.toString(16).padStart(64, '0'))
const PRICE = 102_000_000_000n
const FEE = 21_000n * PRICE
const basePolicy: EvmTransactionSetPolicy = {
  sourceOrder: ['stealth', 'stamp', 'change', 'deterministic', 'root', 'identity'],
  gasPriceWei: PRICE,
  paymentGasLimit: () => 21_000n,
  changeGasLimit: 21_000n,
  paymentFeeIsExact: true,
  dustWei: 10n * FEE,
  radix: 2,
  jitterBps: 1_500,
  maxChangeOutputs: 20,
  head: 1_000,
}
const monadPolicy: EvmTransactionSetPolicy = {
  ...basePolicy,
  spendRule: { belowWei: parseEther('10'), waitBlocks: 3 },
}

/** Small deterministic PRNG so failures reproduce. */
function prng(seed: number): () => number {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 2 ** 32
  }
}

async function setup(
  values: readonly bigint[],
  policy: EvmTransactionSetPolicy = basePolicy,
  random: () => number = prng(7),
) {
  const coins = await EvmCoinList.open(
    new MemoryRecordStore<import('./evm-coin-list').StoredEvmListCoin>(),
  )
  for (const [index, valueWei] of values.entries())
    await coins.put({
      account: signer(index + 1).address,
      privateKey: signer(index + 1).privateKey,
      nonce: 0,
      valueWei,
      origin: 'change',
      changeIndex: index,
    })
  const journal = new EvmNativeOperationJournal({
    testOnlyEphemeral: true,
    binding: {
      chainIdentifier: 'monad-regtest',
      nativeChainId: '20143',
      publicTuple: 'exact-amount',
    },
  })
  await journal.Open()
  const preparer = new EvmTransactionSetPreparer({
    coins,
    journal,
    policy: () => policy,
    recoverySpendRule: policy.spendRule,
    random,
    deriveChange: (index: number) => ({
      account: signer(10_000 + index).address.toLowerCase(),
      privateKey: signer(10_000 + index).privateKey,
      changeIndex: index,
    }),
  })
  return { coins, preparer }
}

let recipients = 0
const recipientKdf = () => {
  const base = 500_000 + 100 * recipients++
  return (index: number) => signer(base + index).address
}

function paid(set: PreparedEvmTransactionSet): bigint {
  return set.bundle.reduce((sum, tx) => sum + tx.valueWei, 0n)
}

/** Every wei of every selected source is accounted for: payments, change, fees and the
 * successor residual that stays on the source account. */
function assertConserved(
  set: PreparedEvmTransactionSet,
  coins: EvmCoinList,
  original: ReadonlyMap<string, bigint>,
) {
  const all = [...set.bundle, ...set.otherTransactions]
  const sources = new Set(all.map(tx => tx.sourceAccount))
  for (const source of sources) {
    const txs = all.filter(tx => tx.sourceAccount === source)
    const spent = txs.reduce(
      (sum, tx) => sum + tx.valueWei + tx.gasLimit * PRICE,
      0n,
    )
    const last = Math.max(...txs.map(tx => tx.nonce))
    const residual = coins.get(source, last + 1)?.valueWei ?? 0n
    const before = original.get(source)
    // Private change accounts funded inside this set are not original sources.
    if (before === undefined) continue
    expect(spent + residual).toBe(before)
  }
}

async function payExactly(
  values: readonly bigint[],
  amountWei: bigint,
  policy: EvmTransactionSetPolicy = basePolicy,
  random?: () => number,
) {
  const { coins, preparer } = await setup(values, policy, random)
  const original = new Map(coins.all().map(coin => [coin.account, coin.valueWei]))
  const set = await preparer.constructTransactionSet({
    operationId: `exact-${recipients}`,
    amountWei,
    kdf: recipientKdf(),
  })
  expect(paid(set)).toBe(amountWei)
  for (const tx of set.bundle) {
    const decoded = Transaction.from(tx.rawTransaction)
    expect(decoded.value).toBe(tx.valueWei)
  }
  assertConserved(set, coins, original)
  return { set, coins }
}

describe.each([
  ['no spend rule', basePolicy],
  ['monad reserve rule', monadPolicy],
])('exact payment amounts (%s)', (_name, policy) => {
  it('pays part of one coin and keeps the rest with the sender', async () => {
    await payExactly([parseEther('1')], parseEther('0.3'), policy)
  })

  it('pays from several coins without gifting the last coin\'s residual (vendor 0.05)', async () => {
    // QA F4: 0xaa565a63 + 0xdabc24f2 paid 0.063792679774997897 for 0.05.
    const { set, coins } = await payExactly(
      [45_716_000_000_000_000n + FEE, 18_076_679_774_997_897n + FEE],
      parseEther('0.05'),
      policy,
    )
    expect(set.bundle).toHaveLength(2)
    const last = set.bundle.find(tx => tx.valueWei < 45_716_000_000_000_000n)!
    expect(coins.get(last.sourceAccount, last.nonce + 1)?.valueWei).toBe(
      18_076_679_774_997_897n - (parseEther('0.05') - 45_716_000_000_000_000n),
    )
  })

  it('pays a raffle entry from two small coins exactly (raffle 0.02)', async () => {
    // QA F4: 0x15e8ef6e + 0xd461a7e4 paid 0.034447832412789899 for 0.02.
    await payExactly(
      [17_478_000_000_000_000n + FEE, 16_969_832_412_789_899n + FEE],
      parseEther('0.02'),
      policy,
    )
  })

  it('pays a DM stamp at the stamp price from a coin about ten times larger (#1853)', async () => {
    // 20570393559449098 wei carried for a 2142000000000000 wei stamp.
    const stamp = 2_142_000_000_000_000n
    const { set } = await payExactly([20_570_393_559_449_098n + FEE], stamp, policy)
    expect(set.bundle).toHaveLength(1)
    expect(set.bundle[0]!.valueWei).toBe(stamp)
  })

  it('does not throw when the residual has no legal change partition (F5)', async () => {
    // Residual just above dust + fee, but every legal change size sits in the payment's
    // base-2 magnitude: the radix split cannot carry it. Previously a RangeError.
    await payExactly([parseEther('0.05')], parseEther('0.02'), policy)
  })
})

describe('F5 shape: about 1.05 spread over many coins, paying 0.02', () => {
  it('never throws and always pays exactly 0.02 across many coin layouts', async () => {
    const random = prng(1853)
    for (let trial = 0; trial < 60; trial++) {
      const count = 2 + Math.floor(random() * 30)
      const weights = Array.from({ length: count }, () => 0.05 + random())
      const total = weights.reduce((a, b) => a + b, 0)
      const values = weights.map(weight =>
        (parseEther('1.05') * BigInt(Math.floor((weight / total) * 1e9))) / 1_000_000_000n,
      )
      for (const policy of [basePolicy, monadPolicy])
        await payExactly(values, parseEther('0.02'), policy, prng(trial + 1))
    }
  })
})
