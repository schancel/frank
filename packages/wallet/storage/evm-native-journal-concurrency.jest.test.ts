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
it.each([
  'missing',
  'pending',
  'reincluded',
  'reincluded-revert',
  'account-only',
] as const)('rejects stale %s evidence', async kind => {
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
  let observed: Promise<void> | undefined
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
    observed = executor.observe(row.operationId, 0)
    await reading
    await a.markExposed(row.operationId, 0)
    expect(a.get(row.operationId).members[0]!.exposed).toBe(true)
    const latestSigned = a.get(row.operationId).members[0]!.signed!
    const newest = {
      state: 'included-success' as const,
      transactionHash: latestSigned.transactionHash,
      blockHash: '0x' + 'cd'.repeat(32),
      blockNumber: 2,
      transactionIndex: 0,
      feeWei: '21000',
    }
    const newestAccount = {
      blockHash: newest.blockHash,
      blockNumber: 2,
      nonce: 1,
      balanceWei: '978000',
    }
    const delayed =
      kind === 'missing' ? undefined : b.beginCapture(row.operationId, 0)
    await a.recordObservation(
      a.beginCapture(row.operationId, 0),
      kind === 'account-only' ? { state: 'unknown' } : newest,
      newestAccount,
    )
    if (kind !== 'account-only') await a.markSyncApplied(row.operationId, 0)
    if (delayed) {
      const answer =
        kind === 'pending'
          ? { state: 'pending' as const }
          : {
              ...newest,
              state:
                kind === 'reincluded-revert'
                  ? ('included-revert' as const)
                  : ('included-success' as const),
              blockHash: '0x' + 'ab'.repeat(32),
              blockNumber: 1,
            }
      const accepted = await b.recordObservation(delayed, answer, {
        blockHash: '0x' + 'ab'.repeat(32),
        blockNumber: 1,
        nonce: 0,
        balanceWei: '1000000',
      })
      await a.refreshPreparation('stealth-payment:observer-race')
      expect({
        accepted,
        persisted: a.get(row.operationId).members[0],
      }).toMatchObject({
        accepted: false,
        persisted: {
          observation: kind === 'account-only' ? { state: 'unknown' } : newest,
          account: newestAccount,
          syncApplied: kind !== 'account-only',
        },
      })
    }
    resume()
    await observed
    await a.refreshPreparation('stealth-payment:observer-race')
    expect(a.get(row.operationId).members[0]).toMatchObject({
      observation: kind === 'account-only' ? { state: 'unknown' } : newest,
      account: newestAccount,
      syncApplied: kind !== 'account-only',
    })

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
    // A fresh capture can accept genuine canonical evidence at a lower height.
    expect(
      await a.recordObservation(
        a.beginCapture(row.operationId, 0),
        inclusion,
        account,
      ),
    ).toBe(true)
    await b.refreshPreparation('stealth-payment:observer-race')
    const stale = b.beginCapture(row.operationId, 0)
    const stableGeneration = a.get(row.operationId).members[0]!
      .observationGeneration
    // Equivalent evidence with a different property order remains the same basis.
    await a.recordObservation(
      a.beginCapture(row.operationId, 0),
      {
        feeWei: inclusion.feeWei,
        transactionIndex: inclusion.transactionIndex,
        blockNumber: inclusion.blockNumber,
        blockHash: inclusion.blockHash,
        transactionHash: inclusion.transactionHash,
        state: inclusion.state,
      },
      {
        balanceWei: account.balanceWei,
        nonce: account.nonce,
        blockNumber: account.blockNumber,
        blockHash: account.blockHash,
      },
    )
    await a.markSyncApplied(row.operationId, 0)
    expect(await b.recordObservation(stale, inclusion, account)).toBe(true)
    expect(b.get(row.operationId).members[0]!.observationGeneration).toBe(
      stableGeneration,
    )
    await a.refreshPreparation('stealth-payment:observer-race')
    expect(a.get(row.operationId).members[0]).toMatchObject({
      signed,
      exposed: true,
      syncApplied: true,
    })

    // A durable A -> B -> exact A must invalidate evidence captured before B.
    // Reopen the changing wrapper while the other wrapper keeps its capture.
    await b.refreshPreparation('stealth-payment:observer-race')
    const beforeAba = b.beginCapture(row.operationId, 0)
    await a.recordObservation(
      a.beginCapture(row.operationId, 0),
      { state: 'pending' },
      account,
    )
    await a.Close()
    await a.Open()
    await a.recordObservation(
      a.beginCapture(row.operationId, 0),
      inclusion,
      account,
    )
    await a.markSyncApplied(row.operationId, 0)
    const beforeStale = a.get(row.operationId)
    expect(beforeStale.members[0]!.observationGeneration).toBe(
      stableGeneration + 2,
    )
    expect(
      await b.recordObservation(beforeAba, { state: 'missing' }, account),
    ).toBe(false)
    await a.refreshPreparation('stealth-payment:observer-race')
    expect(a.get(row.operationId)).toEqual(beforeStale)

    // The real observer must discard its answer, without refreshing its capture and
    // reusing that answer, when another wrapper completes ABA during its RPC reads.
    await b.refreshPreparation('stealth-payment:observer-race')
    let observerReading!: () => void, observerResume!: () => void
    const observerStarted = new Promise<void>(r => (observerReading = r))
    const observerNetwork = new Promise<void>(r => (observerResume = r))
    const delayedRead = jest
      .spyOn(provider, 'getTransaction')
      .mockImplementationOnce(async () => {
        observerReading()
        await observerNetwork
        return null
      })
    const duringAba = executor.observe(row.operationId, 0)
    try {
      await observerStarted
      await a.recordObservation(
        a.beginCapture(row.operationId, 0),
        { state: 'pending' },
        account,
      )
      await a.Close()
      await a.Open()
      await a.recordObservation(
        a.beginCapture(row.operationId, 0),
        inclusion,
        account,
      )
      await a.markSyncApplied(row.operationId, 0)
      const durableAfterAba = a.get(row.operationId)
      observerResume()
      await duringAba
      await a.refreshPreparation('stealth-payment:observer-race')
      expect(a.get(row.operationId)).toEqual(durableAfterAba)
    } finally {
      observerResume()
      await duringAba
      delayedRead.mockRestore()
    }

    // Two wrappers that captured one generation can commit only one changing answer.
    const contenderA = a.beginCapture(row.operationId, 0)
    const contenderB = b.beginCapture(row.operationId, 0)
    expect(
      await Promise.all([
        a.recordObservation(contenderA, { state: 'pending' }, account),
        b.recordObservation(contenderB, { state: 'missing' }, account),
      ]),
    ).toEqual([true, false])
    // Reusing the losing evidence cannot succeed; fresh capture requires fresh RPC at its caller.
    expect(
      await b.recordObservation(contenderB, { state: 'missing' }, account),
    ).toBe(false)
    await a.recordObservation(
      a.beginCapture(row.operationId, 0),
      inclusion,
      account,
    )
    await b.refreshPreparation('stealth-payment:observer-race')

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
    await observed
    await Promise.all([a.Close(), b.Close()])
    jest.mocked(level).mockImplementation(actual)
    await rm(root, { recursive: true, force: true })
  }
})
