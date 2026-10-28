// What a send can draw on right now (`spendableNowWei`, the wallet's `getSpendableBalance`): the
// coin list as selection sees it at the head, not the display balance. A bot sizes what it offers
// from it (the blackjack dealer: "No point in betting when you won't be paid out", owner ruling on
// #1947), so money an operation holds or that is still settling must not be in it.
import { Wallet, parseEther } from 'ethers'
import { EvmCoinList, type StoredEvmListCoin } from './evm-coin-list'
import { MemoryRecordStore } from './storage/evm-coin-store'
import { EvmNativeOperationJournal } from './storage/evm-native-operation-journal'
import { EvmTransactionSetPreparer } from './evm-transaction-set'
import type { EvmTransactionSetPolicy } from './evm-transaction-set-types'

const signer = (index: number) => new Wallet('0x' + index.toString(16).padStart(64, '0'))
const RECIPIENT = signer(50).address
const GAS_PRICE = 1_000n
const FEE = 21_000n * GAS_PRICE

async function wallet() {
  const head = { value: 100 }
  const coins = await EvmCoinList.open(new MemoryRecordStore<StoredEvmListCoin>())
  const journal = new EvmNativeOperationJournal({
    testOnlyEphemeral: true,
    binding: { chainIdentifier: 'monad-testnet', nativeChainId: '10143', publicTuple: 'spendable-now' },
  })
  await journal.Open()
  const policy = (): EvmTransactionSetPolicy => ({
    sourceOrder: ['stealth', 'stamp', 'change', 'deterministic', 'root', 'identity'],
    gasPriceWei: GAS_PRICE,
    paymentGasLimit: () => 21_000n,
    changeGasLimit: 21_000n,
    paymentFeeIsExact: true,
    dustWei: 1_000n,
    radix: 2,
    jitterBps: 0,
    maxChangeOutputs: 1,
    head: head.value,
  })
  const preparer = new EvmTransactionSetPreparer({
    coins,
    journal,
    policy,
    random: () => 0.5,
    deriveChange: (index: number) => ({
      account: signer(100 + index).address.toLowerCase(),
      privateKey: signer(100 + index).privateKey,
      changeIndex: index,
    }),
  })
  let next = 1
  const put = async (valueWei: bigint, extra: Partial<StoredEvmListCoin> = {}) => {
    const key = signer(next++)
    await coins.put({ account: key.address, privateKey: key.privateKey, nonce: 0, valueWei, origin: 'stealth', ...extra })
    return key.address.toLowerCase()
  }
  return { head, coins, journal, preparer, put }
}

describe('what a send can draw on right now', () => {
  it('is every free coin less its own transfer fee', async () => {
    const w = await wallet()
    await w.put(parseEther('1'))
    await w.put(parseEther('2'))
    expect(w.preparer.spendableNowWei()).toBe(parseEther('3') - 2n * FEE)
    await w.journal.Close()
  })

  it('does not count a coin an operation holds', async () => {
    const w = await wallet()
    const held = await w.put(parseEther('1'))
    await w.put(parseEther('2'))
    // A payment takes the 1 MON coin (and leaves the other free).
    const set = await w.preparer.constructTransactionSet({
      operationId: 'holds-one',
      amountWei: parseEther('0.5'),
      kdf: () => RECIPIENT,
      sourceAccounts: [held],
    })
    expect([...set.bundle, ...set.otherTransactions].every(tx => tx.sourceAccount.toLowerCase() === held)).toBe(true)
    // Its change coin is the payment's until the payment lands, and the source is held.
    expect(w.preparer.spendableNowWei()).toBe(parseEther('2') - FEE)
    await w.journal.Close()
  })

  it('does not count a coin still waiting for its block, until the head reaches it', async () => {
    const w = await wallet()
    await w.put(parseEther('1'))
    await w.put(parseEther('2'), { spendableFromBlock: 104, fundsVisibleFromBlock: 104 })
    expect(w.preparer.spendableNowWei()).toBe(parseEther('1') - FEE)
    w.head.value = 103
    expect(w.preparer.spendableNowWei()).toBe(parseEther('1') - FEE)
    w.head.value = 104
    expect(w.preparer.spendableNowWei()).toBe(parseEther('3') - 2n * FEE)
    await w.journal.Close()
  })

  it('does not count a coin worth less than its own transfer fee', async () => {
    const w = await wallet()
    await w.put(parseEther('1'))
    await w.put(FEE - 1n)
    expect(w.preparer.spendableNowWei()).toBe(parseEther('1') - FEE)
    await w.journal.Close()
  })
})
