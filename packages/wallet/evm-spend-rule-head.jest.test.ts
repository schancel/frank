// A received payment is spent only once the node can see it. Monad's transaction pool judges a
// new transaction against the sender's balance at its last committed block minus
// `spendSpacingBlocks - 1` (monad-bft v0.16.4, monad-eth-txpool/src/pool/mod.rs); eth_blockNumber
// names the newest proposed block, which a loaded node lets run ahead of the committed one.
//
// The layout and timing are the blackjack livecheck's (PR #1947, run 13, hand 1): the player's
// bet of 0.04284 MON reached a fresh stealth account in block 348579; the dealer's payout spent
// all of it (0.040698 to the player plus 21,000 gas at 102 gwei) when the proposed head was
// 348588. The node refused it ("Signer had insufficient balance"), so its view was still before
// block 348579, and it kept refusing those bytes for 15 minutes.
import { Transaction, Wallet, type Provider } from 'ethers'
import { installEvmTransactionSetRuntime } from './evm-transaction-set-runtime'
import { EvmCoinList, type StoredEvmListCoin } from './evm-coin-list'
import { EvmChangePool } from './evm-change-pool'
import { EvmSubAccountPool } from './evm-account-pool'
import { MonadHdKeyring, MonadChangeKeyring } from './secp256k1-hd-keyring'
import { MonadIdentity } from './evm-identity'
import { MemoryRecordStore, type EvmCoin } from './storage/evm-coin-store'
import { EvmNativeOperationJournal } from './storage/evm-native-operation-journal'
import { EvmTransactionSetInsufficientFundsError } from './evm-transaction-set-types'
import { readSpendRuleHead } from './chain/evm-spend-rule'
import { getChainRegistryEntry } from './chain/chains-registry'

const FUNDED = 348579
const BET = 42_840_000_000_000_000n
const PAYOUT = 40_698_000_000_000_000n
const GAS_PRICE = 102_000_000_000n
const SPACING = 3
const mnemonic = 'test test test test test test test test test test test junk'
const RECIPIENT = new Wallet('0x' + '50'.repeat(32)).address

/** A Monad node: `latest` is the proposed head, `finalized` the committed one; the pool admits
 * a transaction only if its sender held the gas it may pay at `finalized - (SPACING - 1)`. */
function monadNode(stealth: string) {
  const heads = { latest: FUNDED + 9, finalized: FUNDED + 1 }
  const balanceAt = (address: string, block: number) =>
    address.toLowerCase() === stealth && block >= FUNDED ? BET : 0n
  const blockOf = (tag?: number | string) =>
    typeof tag === 'number' ? tag : heads.latest
  const provider = {
    getBlockNumber: jest.fn(async () => heads.latest),
    getBlock: jest.fn(async (tag: string) => {
      if (tag !== 'finalized') throw new Error(`unexpected block tag ${tag}`)
      return { number: heads.finalized }
    }),
    getBalance: jest.fn(async (address: string, tag?: number | string) =>
      balanceAt(address, blockOf(tag)),
    ),
    getTransactionCount: jest.fn(async () => 0),
    getFeeData: jest.fn(async () => ({ gasPrice: GAS_PRICE })),
  }
  const admits = (raw: string) => {
    const tx = Transaction.from(raw)
    const view = heads.finalized - (SPACING - 1)
    return balanceAt(tx.from!, view) >= tx.gasLimit * tx.gasPrice!
  }
  return { heads, provider, admits }
}

async function dealer(spendRuleHead: 'latest' | 'finalized' | undefined) {
  const stealthKey = new Wallet('0x' + '33'.repeat(32))
  const stealth = stealthKey.address.toLowerCase()
  const node = monadNode(stealth)
  const coinStore = new MemoryRecordStore<EvmCoin>()
  await coinStore.put(stealth, {
    address: stealth,
    privateKey: stealthKey.privateKey,
    origin: 'stealth',
    state: 'unspent',
    amountWei: BET.toString(),
    claimedAmountWei: BET.toString(),
    transactions: [],
    discoveredAtMs: 0,
  })
  const changeKeyring = MonadChangeKeyring.fromMnemonic(mnemonic)
  const journal = new EvmNativeOperationJournal({
    testOnlyEphemeral: true,
    binding: { chainIdentifier: 'monad-regtest', nativeChainId: '20143', publicTuple: 'spend-rule-head' },
  })
  await journal.Open()
  const runtime = installEvmTransactionSetRuntime({
    mainAccount: new Wallet('0x' + '11'.repeat(32)),
    identity: MonadIdentity.fromSeed({ mnemonic }),
    coinList: await EvmCoinList.open(new MemoryRecordStore<StoredEvmListCoin>()),
    changeKeyring,
    changePool: new EvmChangePool({ keyring: changeKeyring }),
    pool: new EvmSubAccountPool({ keyring: MonadHdKeyring.fromMnemonic(mnemonic) }),
    coinStore,
    provider: node.provider as unknown as Provider,
    journal,
    kind: 'monad',
    knownNoCodeAddress: new Wallet('0x' + '22'.repeat(32)).address,
    spendSpacingBlocks: SPACING,
    reserveBalanceWei: 10_000_000_000_000_000_000n,
    spendRuleHead,
  })
  const pay = (operationId: string) =>
    runtime.transactionSetPreparer.constructTransactionSet({
      operationId,
      amountWei: PAYOUT,
      kdf: () => RECIPIENT,
    })
  return { node, runtime, journal, stealth, pay }
}

it('the Monad networks count the spend rule from the finalized head', () => {
  for (const id of ['monad-testnet', 'monad-regtest', 'monad-mainnet'])
    expect(getChainRegistryEntry(id)?.spendRuleHead).toBe('finalized')
})

it('readSpendRuleHead names the finalized block on Monad and the newest one elsewhere', async () => {
  const { provider, heads } = monadNode('0x')
  await expect(readSpendRuleHead(provider, 'finalized')).resolves.toBe(heads.finalized)
  await expect(readSpendRuleHead(provider, undefined)).resolves.toBe(heads.latest)
  await expect(readSpendRuleHead(provider, 'latest')).resolves.toBe(heads.latest)
})

it('does not sign the payout from a bet the node cannot see yet, and pays it once the node can', async () => {
  const f = await dealer('finalized')
  try {
    await f.runtime.refresh()
    const early = await f.pay('payout-early').catch(error => error)
    expect(early).toBeInstanceOf(EvmTransactionSetInsufficientFundsError)
    // Read as of the newest block, FUNDED + 9: the wallet cannot tell when after FUNDED - 3 the
    // bet arrived, so it waits until the node's head is four blocks past FUNDED + 9.
    expect(early.spendableFromBlock).toBe(FUNDED + 9 + 4)
    expect(f.journal.list()).toHaveLength(0)

    // The node now sees the bet (its view is FUNDED + 3 - 2), but the wallet's wait is not over.
    f.node.heads.finalized = FUNDED + 3
    f.node.heads.latest = FUNDED + 12
    await f.runtime.refresh()
    await expect(f.pay('payout-still-early')).rejects.toBeInstanceOf(
      EvmTransactionSetInsufficientFundsError,
    )

    f.node.heads.finalized = FUNDED + 13
    f.node.heads.latest = FUNDED + 15
    await f.runtime.refresh()
    const set = await f.pay('payout')
    const raws = [...set.bundle, ...set.otherTransactions].map(tx => tx.rawTransaction)
    const payout = raws.map(raw => Transaction.from(raw)).find(tx => tx.to === RECIPIENT)!
    expect(payout.from!.toLowerCase()).toBe(f.stealth)
    expect(payout.value).toBe(PAYOUT)
    for (const raw of raws) expect(f.node.admits(raw)).toBe(true)
  } finally {
    await f.runtime.stop()
    await f.journal.Close()
  }
})

it('counted from the proposed head, the same coin is signed at once into bytes the node refuses', async () => {
  // What every Monad network did before `spendRuleHead`: the bet looks nine blocks old.
  const f = await dealer(undefined)
  try {
    await f.runtime.refresh()
    const set = await f.pay('payout')
    const payout = [...set.bundle, ...set.otherTransactions]
      .map(tx => tx.rawTransaction)
      .find(raw => Transaction.from(raw).to === RECIPIENT)!
    expect(Transaction.from(payout).from!.toLowerCase()).toBe(f.stealth)
    expect(f.node.admits(payout)).toBe(false)
  } finally {
    await f.runtime.stop()
    await f.journal.Close()
  }
})
