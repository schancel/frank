import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import level from 'level'
import { Transaction, Wallet, type Provider } from 'ethers'
import { EvmNativeOperationJournal } from './evm-native-operation-journal'
import { EvmLegacyConsolidator } from '../chain/evm-legacy-consolidator'
import { NativeEvmTransactionBuilder } from '../chain/evm-transaction-builder'
// Independent stale wrappers share real Level bytes; Node allows only one physical opener.
jest.mock('level', () => jest.fn(jest.requireActual('level')))
it('an RPC observation cannot overwrite exposure committed by another wrapper', async () => {
  const root = await mkdtemp(join(tmpdir(), 'frank-observation-verify-'))
  const actual: typeof level = jest.requireActual('level')
  const handles = new Map<string, ReturnType<typeof level>>()
  jest.mocked(level).mockImplementation(location => {
    let db = handles.get(String(location))
    if (!db) {
      db = actual(location)
      handles.set(String(location), db)
    }
    return db
  })
  const binding = {
    chainIdentifier: 'monad-testnet',
    nativeChainId: '10143',
    publicTuple: 'observer verify',
  }
  const a = new EvmNativeOperationJournal({ location: root, binding }),
    b = new EvmNativeOperationJournal({ location: root, binding })
  const signer = new Wallet('0x' + '41'.repeat(32)),
    address = signer.address.toLowerCase()
  let reached!: () => void, resume!: () => void
  const reading = new Promise<void>(r => (reached = r)),
    network = new Promise<void>(r => (resume = r))
  try {
    await a.Open()
    const row = await a.prepare({
      kind: 'native',
      preparationId: 'stealth-payment:observer-race',
      recipient: address,
      intendedValueWei: '1000',
      members: [
        {
          source: { kind: 'main', address },
          dependencies: [],
          unsignedTransaction: Transaction.from({
            type: 2,
            chainId: 10143,
            nonce: 0,
            to: address,
            value: 1000n,
            gasLimit: 21000n,
            maxFeePerGas: 1n,
            maxPriorityFeePerGas: 1n,
          }).unsignedSerialized,
        },
      ],
    })
    await a.checkpointSigned(
      row.operationId,
      0,
      await signer.signTransaction(
        Transaction.from(row.members[0]!.unsignedTransaction),
      ),
    )
    await b.Open()
    const provider = {
      getTransaction: async () => {
        reached()
        await network
        return null
      },
      getTransactionReceipt: async () => null,
      getBlock: async () => ({ hash: '0x' + 'ab'.repeat(32), number: 1 }),
      getBalance: async () => 1000000n,
      getTransactionCount: async () => 0,
    } as unknown as Provider
    const executor = new EvmLegacyConsolidator({
      journal: b,
      provider,
      transactionBuilder: new NativeEvmTransactionBuilder(),
      getSources: async () => [],
      sign: async () => {
        throw Error('must not sign')
      },
    })
    const observed = executor.observe(row.operationId, 0)
    await reading
    await a.markExposed(row.operationId, 0)
    expect(a.get(row.operationId).members[0]!.exposed).toBe(true)
    resume()
    await observed
    await a.refreshPreparation('stealth-payment:observer-race')

    expect(a.get(row.operationId).members[0]!.exposed).toBe(true)
    await expect(a.discardUnexposed(row.operationId)).rejects.toThrow(
      /conflict/,
    )

    const signed = a.get(row.operationId).members[0]!.signed!
    const inclusion = {
      state: 'included-success' as const,
      transactionHash: signed.transactionHash,
      blockHash: '0x' + 'ab'.repeat(32),
      blockNumber: 1,
      transactionIndex: 0,
      feeWei: '21000',
    }
    const account = {
      blockHash: inclusion.blockHash,
      blockNumber: 1,
      nonce: 1,
      balanceWei: '978000',
    }
    await a.recordObservation(
      a.beginCapture(row.operationId, 0),
      inclusion,
      account,
    )
    await b.refreshPreparation('stealth-payment:observer-race')
    const stale = b.beginCapture(row.operationId, 0)
    await a.markSyncApplied(row.operationId, 0)
    expect(await b.recordObservation(stale, inclusion, account)).toBe(true)
    await a.refreshPreparation('stealth-payment:observer-race')
    expect(a.get(row.operationId).members[0]).toMatchObject({
      signed,
      exposed: true,
      syncApplied: true,
    })

    // Reorg evidence is bound to the currently persisted inclusion, even when
    // another wrapper captured its observation before a newer inclusion committed.
    const staleInclusion = b.beginCapture(row.operationId, 0)
    const replacement = {
      ...inclusion,
      blockHash: '0x' + 'cd'.repeat(32),
      blockNumber: 2,
    }
    const replacementAccount = {
      ...account,
      blockHash: replacement.blockHash,
      blockNumber: 2,
    }
    await a.recordObservation(
      a.beginCapture(row.operationId, 0),
      replacement,
      replacementAccount,
    )
    expect(
      await b.recordObservation(staleInclusion, { state: 'unknown' }, null, {
        blockNumber: inclusion.blockNumber,
        orphanedBlockHash: inclusion.blockHash,
        canonicalBlockHash: replacement.blockHash,
      }),
    ).toBe(false)
    await b.refreshPreparation('stealth-payment:observer-race')
    expect(b.get(row.operationId).members[0]!.observation).toEqual(replacement)
    expect(
      await b.recordObservation(
        b.beginCapture(row.operationId, 0),
        { state: 'unknown' },
        null,
        {
          blockNumber: replacement.blockNumber,
          orphanedBlockHash: replacement.blockHash,
          canonicalBlockHash: '0x' + 'ef'.repeat(32),
        },
      ),
    ).toBe(true)
    await a.refreshPreparation('stealth-payment:observer-race')
    expect(a.get(row.operationId).members[0]).toMatchObject({
      signed,
      exposed: true,
      observation: { state: 'unknown' },
    })
    expect(a.canSelect(address, 0)).toBe(false)
    // Restore fresh inclusion for the original's consumed-nonce successor below.
    await a.recordObservation(
      a.beginCapture(row.operationId, 0),
      replacement,
      replacementAccount,
    )

    // A cached unsigned wrapper cannot cancel bytes another wrapper has since signed.
    const next = await a.prepare({
      kind: 'native',
      preparationId: 'stealth-payment:cancel-race',
      recipient: address,
      intendedValueWei: '1000',
      members: [
        {
          source: { kind: 'main', address },
          dependencies: [],
          unsignedTransaction: Transaction.from({
            type: 2,
            chainId: 10143,
            nonce: 1,
            to: address,
            value: 1000n,
            gasLimit: 21000n,
            maxFeePerGas: 1n,
            maxPriorityFeePerGas: 1n,
          }).unsignedSerialized,
        },
      ],
    })
    await b.refreshPreparation('stealth-payment:cancel-race')
    const raw = await signer.signTransaction(
      Transaction.from(next.members[0]!.unsignedTransaction),
    )
    await a.checkpointSigned(next.operationId, 0, raw)
    await expect(b.cancelUnsigned(next.operationId)).rejects.toThrow(/conflict/)
    const late = b.beginCapture(next.operationId, 0)
    await a.discardUnexposed(next.operationId)
    expect(await b.recordObservation(late, { state: 'pending' }, account)).toBe(
      false,
    )
    await expect(b.checkpointSigned(next.operationId, 0, raw)).rejects.toThrow(
      /conflict/,
    )
    await a.refreshPreparation('stealth-payment:cancel-race')
    expect(a.get(next.operationId)).toMatchObject({
      cancelled: true,
      members: [
        { signed: null, exposed: false, observation: { state: 'unknown' } },
      ],
    })
  } finally {
    resume()
    await Promise.all([a.Close(), b.Close()])
    jest.mocked(level).mockImplementation(actual)
    await rm(root, { recursive: true, force: true })
  }
})
