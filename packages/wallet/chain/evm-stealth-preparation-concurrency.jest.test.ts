import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import level from 'level'
import { getBytes, Transaction, Wallet, type Provider } from 'ethers'
import { LevelRecordStore } from '../storage/evm-coin-store'
import {
  EvmNativeOperationJournal,
  type EvmNativePlan,
} from '../storage/evm-native-operation-journal'
import { EvmLegacyConsolidator } from './evm-legacy-consolidator'
import { NativeEvmTransactionBuilder } from './evm-transaction-builder'
import {
  createEvmStealthPayments,
  EVM_STEALTH_PREPARATION_NAMESPACE,
  type EvmStealthPreparation,
} from './evm-stealth-payments'

jest.mock('level', () => jest.fn(jest.requireActual('level')))
const a = new Wallet('0x' + '41'.repeat(32))
const b = new Wallet('0x' + '42'.repeat(32))
const destination = new Wallet('0x' + '43'.repeat(32))
const binding = {
  chainIdentifier: 'monad-testnet',
  nativeChainId: '10143',
  publicTuple: 'stable preparation concurrency',
}
const source = (wallet: Wallet) => ({
  kind: 'coin' as const,
  address: wallet.address.toLowerCase(),
})
const intent = (operationId: string, wallet = a) => ({
  operationId,
  chainIdentifier: binding.chainIdentifier,
  asset: { kind: 'native' as const },
  recipientSpendPublicKey: getBytes(destination.signingKey.compressedPublicKey),
  amountAtomic: 1000n,
  maxNativeFeeAtomic: 100000n,
  sourceAddress: wallet.address.toLowerCase(),
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

test('two stale Level capabilities share one business preparation while another operation continues', async () => {
  const root = await mkdtemp(join(tmpdir(), 'frank-stable-preparation-'))
  const actual: typeof level = jest.requireActual('level')
  const databases = new Map<string, ReturnType<typeof level>>()
  jest.mocked(level).mockImplementation(location => {
    let database = databases.get(String(location))
    if (!database) {
      database = actual(location)
      databases.set(String(location), database)
    }
    return database
  })
  // Node permits one physical Level opener. Independent wrappers/caches share real bytes here;
  // this verifies the owner seams, rather than claiming a live cross-tab browser test.
  const journals = [
    new EvmNativeOperationJournal({ location: root, binding }),
    new EvmNativeOperationJournal({ location: root, binding }),
  ]
  const stores: LevelRecordStore<EvmStealthPreparation>[] = []
  const reached = deferred(),
    resume = deferred()
  const signatures: string[] = []
  let pause = true
  const provider = {
    getBlock: async () => ({ hash: '0x' + 'ab'.repeat(32), number: 1 }),
    getBalance: async () => 1000000n,
    getTransactionCount: async () => 0,
    estimateGas: async () => 21000n,
    getFeeData: async () => ({
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
      gasPrice: 2n,
    }),
    getTransaction: async () => null,
    getTransactionReceipt: async () => null,
    broadcastTransaction: jest.fn(),
  } as unknown as Provider
  try {
    for (const journal of journals) await journal.Open()
    for (let i = 0; i < 2; i++)
      stores.push(
        await LevelRecordStore.open(root, EVM_STEALTH_PREPARATION_NAMESPACE),
      )
    const capabilities = journals.map((journal, i) => {
      const executor = new EvmLegacyConsolidator({
        journal,
        provider,
        transactionBuilder: new NativeEvmTransactionBuilder(),
        getSources: async () => [source(a), source(b)],
        sign: async (owned, raw) => {
          if (pause && owned.address === a.address.toLowerCase()) {
            pause = false
            reached.resolve()
            await resume.promise
          }
          signatures.push(owned.address)
          return (
            owned.address === a.address.toLowerCase() ? a : b
          ).signTransaction(Transaction.from(raw))
        },
      })
      return createEvmStealthPayments({
        chainIdentifier: binding.chainIdentifier,
        nativeChainId: 10143n,
        coordinationKey: JSON.stringify(binding),
        store: stores[i]!,
        assertActive: () => undefined,
        refreshJournal: async id => {
          await journal.refreshPreparation(id)
        },
        derive: () => ({
          stealthAddress: destination.address.toLowerCase(),
          ephemeralPubKey: getBytes(destination.signingKey.compressedPublicKey),
        }),
        operations: () => journal.list(),
        signNative: params => executor.signNative(params),
        signContractCall: params => executor.signContractCall(params),
        submit: id => executor.resumeOperation(id),
        observe: async () => undefined,
        release: id => executor.releaseUnexposed(id),
        quote: async () => {
          throw new Error('unused quote')
        },
        tokenBalance: async () => 0n,
        selectTokenSource: async () => {
          throw new Error('unused')
        },
        tokenReceipt: async () => undefined,
      })
    })
    const first = capabilities[0]!.prepare(intent('same-payment'))
    await reached.promise
    const duplicate = capabilities[1]!.prepare(intent('same-payment'))
    const unrelated = await capabilities[1]!.prepare(intent('other-payment', b))
    expect(
      Transaction.from(
        unrelated.members[0]!.rawTransaction,
      ).from?.toLowerCase(),
    ).toBe(b.address.toLowerCase())
    expect(signatures).toEqual([b.address.toLowerCase()])
    resume.resolve()
    const [one, two] = await Promise.all([first, duplicate])
    expect(two).toEqual(one)
    expect(signatures).toEqual([
      b.address.toLowerCase(),
      a.address.toLowerCase(),
    ])
    await journals[1]!.refreshPreparation('stealth-payment:same-payment')
    expect(journals[1]!.list()).toHaveLength(2)
    expect(
      journals[1]!
        .list()
        .filter(row => row.preparationId === 'stealth-payment:same-payment'),
    ).toHaveLength(1)
    await expect(
      capabilities[1]!.prepare({
        ...intent('same-payment'),
        maxNativeFeeAtomic: 99999n,
      }),
    ).rejects.toThrow(/conflict/i)
    expect(provider.broadcastTransaction).not.toHaveBeenCalled()
    await capabilities[0]!.release('same-payment')
    await expect(
      capabilities[1]!.prepare(intent('same-payment')),
    ).rejects.toThrow(/released/i)
    expect(signatures).toHaveLength(2)

    await capabilities[1]!.release('other-payment')

    // The journal itself must reject competing plans even without the business coordinator.
    const base: EvmNativePlan = {
      kind: 'native',
      preparationId: 'stealth-payment:journal-only',
      recipient: destination.address.toLowerCase(),
      intendedValueWei: '1000',
      members: [
        {
          source: source(a),
          dependencies: [],
          unsignedTransaction: Transaction.from({
            type: 2,
            chainId: 10143,
            nonce: 0,
            to: destination.address,
            value: 1000n,
            gasLimit: 21000n,
            maxFeePerGas: 2n,
            maxPriorityFeePerGas: 1n,
          }).unsignedSerialized,
        },
      ],
    }
    const conflicting = {
      ...base,
      members: [{ ...base.members[0]!, source: source(b) }],
    }
    const results = await Promise.allSettled([
      journals[0]!.prepare(base),
      journals[1]!.prepare(conflicting),
    ])
    expect(results.map(result => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ])
    const winner = results.find(result => result.status === 'fulfilled')!
    if (winner.status !== 'fulfilled') throw new Error('missing winner')
    await journals[0]!.refreshPreparation(base.preparationId!)
    expect(
      journals[0]!
        .list()
        .filter(row => row.preparationId === base.preparationId),
    ).toHaveLength(1)
    expect(await journals[0]!.prepare(base)).toEqual(winner.value)
    await journals[0]!.cancelUnsigned(winner.value.operationId)
    await expect(journals[1]!.prepare(base)).rejects.toThrow(/conflict/i)
  } finally {
    resume.resolve()
    await Promise.all(journals.map(journal => journal.Close()))
    await Promise.all(stores.map(store => store.close()))
    jest.mocked(level).mockImplementation(jest.requireActual('level'))
    await rm(root, { recursive: true, force: true })
  }
})
