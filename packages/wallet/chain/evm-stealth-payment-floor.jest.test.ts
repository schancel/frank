/** The payment floor (`chain/payment-floor.ts`) on a stealth payment from the chat composer:
 * real coin list, transaction-set preparer, journal and signatures; nothing is broadcast. */
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { getBytes, Transaction, Wallet } from 'ethers'
import { EvmNativeOperationJournal } from '../storage/evm-native-operation-journal'
import { EvmCoinList, type StoredEvmListCoin } from '../evm-coin-list'
import { MemoryRecordStore } from '../storage/evm-coin-store'
import { EvmTransactionSetPreparer } from '../evm-transaction-set'
import { EVM_TRANSACTION_SET_SOURCE_ORDER } from '../evm-transaction-set-types'
import { evmPaymentFloorWei } from './payment-floor'
import { ContactPaymentBelowFloorError } from './chain-wallet'
import {
  createEvmStealthPayments,
  STEALTH_NATIVE_PAYMENT_PARTS,
  type EvmStealthPreparation,
} from './evm-stealth-payments'

const binding = {
  chainIdentifier: 'monad-testnet',
  nativeChainId: '10143',
  publicTuple: 'stealth payment floor',
}
const recipient = new Wallet('0x' + '43'.repeat(32))
// Ten moves of 21,000 gas at a gas price of 1: 210,000.
const FLOOR = evmPaymentFloorWei(1n)
const policy = {
  sourceOrder: EVM_TRANSACTION_SET_SOURCE_ORDER,
  gasPriceWei: 1n,
  paymentGasLimit: () => 21000n,
  changeGasLimit: 21000n,
  paymentFeeIsExact: true,
  dustWei: FLOOR,
  radix: 2,
  jitterBps: 0,
  maxChangeOutputs: 4,
  head: 1,
}
const intent = (operationId: string, amountAtomic: bigint) => ({
  operationId,
  chainIdentifier: binding.chainIdentifier,
  asset: { kind: 'native' as const },
  recipientSpendPublicKey: getBytes(recipient.signingKey.compressedPublicKey),
  amountAtomic,
})

async function setup(coinValues: readonly bigint[]) {
  const root = await mkdtemp(join(tmpdir(), 'wallet-stealth-floor-'))
  const journal = new EvmNativeOperationJournal({ location: root, binding })
  await journal.Open()
  const coins = await EvmCoinList.open(new MemoryRecordStore<StoredEvmListCoin>())
  for (const [index, valueWei] of coinValues.entries()) {
    const owner = new Wallet('0x' + (0x51 + index).toString(16).padStart(64, '0'))
    await coins.put({
      account: owner.address,
      privateKey: owner.privateKey,
      nonce: 0,
      valueWei,
      origin: 'stealth',
      lastSpentInBlock: 0,
    })
  }
  const preparer = new EvmTransactionSetPreparer({
    journal,
    coins,
    policy: () => policy,
    deriveChange: (index) => {
      const wallet = new Wallet('0x' + (100 + index).toString(16).padStart(64, '0'))
      return { account: wallet.address, privateKey: wallet.privateKey, changeIndex: index }
    },
  })
  const store = new MemoryRecordStore<EvmStealthPreparation>()
  const payments = createEvmStealthPayments({
    chainIdentifier: binding.chainIdentifier,
    nativeChainId: 10143n,
    coordinationKey: JSON.stringify(binding),
    store,
    assertActive: () => undefined,
    refreshJournal: async (id) => {
      await journal.refreshPreparation(id)
    },
    derive: () => ({
      stealthAddress: recipient.address.toLowerCase(),
      ephemeralPubKey: getBytes(recipient.signingKey.compressedPublicKey),
    }),
    operations: () => journal.list(),
    readPreparation: (id) => journal.refreshPreparation(id),
    // As the wallet composes it (`evm-received-coin-manager.ts`): the policy's floor, and a
    // quote that selects exactly as construction does.
    paymentFloorWei: async () => preparer.transactionSetPolicy().dustWei,
    quoteNative: async (amountWei, recipientAddress, minimumPaymentWei) => {
      const balance = coins.all().filter((c) => c.state === 'unspent')
        .reduce((sum, c) => sum + c.valueWei, 0n)
      if (amountWei === 0n || recipientAddress === undefined)
        return { nativeBalanceAtomic: balance, assetBalanceAtomic: balance, estimatedNativeFeeAtomic: 0n }
      const quote = await preparer.quoteTransactionSet({
        amountWei,
        kdf: () => recipientAddress,
        maxPaymentParts: STEALTH_NATIVE_PAYMENT_PARTS,
        ...(minimumPaymentWei === undefined ? {} : { minimumPaymentWei }),
      })
      return { nativeBalanceAtomic: balance, assetBalanceAtomic: balance, estimatedNativeFeeAtomic: quote.feeWei }
    },
    constructNativePayment: async (request) => {
      await preparer.constructTransactionSet(request)
      return preparer.getOperation(request.operationId)!
    },
    signIndependentPayment: async () => {
      throw new Error('Native payment entered the independent executor')
    },
    quote: async () => {
      throw new Error('Native payment entered the token quote')
    },
    submit: async () => {
      throw new Error('Nothing is submitted here')
    },
    observe: async () => undefined,
    release: (id) => preparer.releaseUnexposed(id),
    tokenBalance: async () => 0n,
    tokenReceipt: async () => undefined,
  })
  return {
    payments,
    store,
    journal,
    close: async () => {
      await journal.Close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('a stealth payment below the payment floor is refused before anything is recorded or signed', async () => {
  const f = await setup([1_000_000n])
  try {
    for (const attempt of [
      () => f.payments.quote(intent('below-floor', FLOOR - 1n)),
      () => f.payments.prepare({ ...intent('below-floor', FLOOR - 1n), maxNativeFeeAtomic: 100_000n }),
    ]) {
      const refused = await attempt().catch((error: unknown) => error)
      expect(refused).toBeInstanceOf(ContactPaymentBelowFloorError)
      expect(refused).toMatchObject({ valueWei: FLOOR - 1n, floorWei: FLOOR })
    }
    expect(f.store.get('below-floor')).toBeUndefined()
    expect(f.journal.list()).toEqual([])

    // At the floor it is a payment like any other.
    const quote = await f.payments.quote(intent('at-floor', FLOOR))
    const prepared = await f.payments.prepare({
      ...intent('at-floor', FLOOR),
      maxNativeFeeAtomic: quote.estimatedNativeFeeAtomic,
    })
    expect(prepared.members.reduce((sum, member) =>
      sum + Transaction.from(member.rawTransaction).value, 0n)).toBe(FLOOR)
  } finally {
    await f.close()
  }
})

test('a stealth payment split across coins pays no part below the payment floor', async () => {
  // Two coins that can move 500,000 and 300,000 after their 21,000 fee. Filled greedily, 600,000
  // would be 500,000 and a 100,000 part below the floor; the payment pays 390,000 and 210,000.
  const f = await setup([521_000n, 321_000n])
  try {
    const amount = 600_000n
    const quote = await f.payments.quote(intent('split', amount))
    const prepared = await f.payments.prepare({
      ...intent('split', amount),
      maxNativeFeeAtomic: quote.estimatedNativeFeeAtomic,
    })
    const parts = prepared.members.map((member) => Transaction.from(member.rawTransaction))
      .filter((tx) => tx.to?.toLowerCase() === recipient.address.toLowerCase())
      .map((tx) => tx.value)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.reduce((sum, value) => sum + value, 0n)).toBe(amount)
    for (const part of parts) expect(part).toBeGreaterThanOrEqual(FLOOR)
    // The floor is recorded with the intent, so a retried construction makes the same split.
    expect(f.store.get('split')!.minimumPaymentWei).toBe(FLOOR.toString())
    // The reviewed fee is the fee of this very split.
    expect(prepared.members.reduce((sum, member) => {
      const tx = Transaction.from(member.rawTransaction)
      return sum + tx.gasLimit * tx.gasPrice!
    }, 0n)).toBe(quote.estimatedNativeFeeAtomic)
  } finally {
    await f.close()
  }
})
