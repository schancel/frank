/** Retained HD funding provenance verification suite (inverted from base-loss probes + full contract coverage). */
import { createHash } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import level from 'level'
import { JsonRpcProvider, Transaction, Wallet } from 'ethers'
import { MonadSubAccountPool } from '../../packages/wallet/monad-account-pool'
import { MonadHdKeyring } from '../../packages/wallet/monad-hd-keyring'
import { MonadAccountTxSigner } from '../../packages/wallet/monad-account-tx'
import { MonadChangeKeyring } from '../../packages/wallet/monad-change-keyring'
import { MonadChangePool } from '../../packages/wallet/monad-change-pool'
import { SubAccountLeaseManager } from '../../packages/wallet/monad-account-lease'
import { createEvmInputAdmission } from '../../packages/wallet/evm-input-admission'
import { EvmNativeOperationJournal } from '../../packages/wallet/storage/evm-native-operation-journal'
import { InMemoryTopicOperationJournal } from '../../packages/wallet/storage/topic-operation-journal'
import { validateMonadWalletState } from '../../packages/wallet/storage/monad-wallet-state-validator'
import { LevelSubAccountPoolStore } from '../../packages/wallet/storage/level-sub-account-pool-store'
import { openMonadWalletBundle } from '../../packages/wallet/storage/monad-wallet-bundle'

const mnemonic = 'test test test test test test test test test test test junk'
const overrides = {
  gasLimit: 21_000n,
  maxFeePerGas: 1n,
  maxPriorityFeePerGas: 1n,
  chainId: 10143n,
}
const BLOCK_HASH = '0x' + '11'.repeat(32)

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'frank-hd-provenance-probe-'))
  let store = new LevelSubAccountPoolStore(directory)
  await store.Open()
  const keyring = MonadHdKeyring.fromMnemonic(mnemonic)
  let pool = new MonadSubAccountPool({
    keyring,
    store,
    expectedChainId: 10143n,
  })
  await pool.ensureUnfundedSize(2)
  await pool.flush()
  const balances = new Map<string, bigint>()
  const submitted: string[] = []
  const controls = {
    secondBuildFailure: false,
    secondSubmitFailure: false,
    receiptPending: false,
    receiptStatus: 'success' as 'success' | 'failure' | 'unknown',
    receiptBlockHash: BLOCK_HASH,
    canonicalBlockHash: BLOCK_HASH,
  }
  const provider = new JsonRpcProvider('http://127.0.0.1:1', 10143, {
    staticNetwork: true,
    cacheTimeout: -1,
  })
  const nonces = new Map<string, number>()
  ;(provider as any)._perform = async (request: any) => {
    const address = (request.address ?? '').toLowerCase()
    if (request.method === 'getBalance') return balances.get(address) ?? 0n
    if (request.method === 'getTransactionCount')
      return nonces.get(address) ?? 0
    if (request.method === 'getBlock')
      return {
        hash: controls.canonicalBlockHash,
        parentHash: '0x' + '22'.repeat(32),
        number: '0x1',
        timestamp: '0x64',
        nonce: '0x0000000000000000',
        difficulty: '0x0',
        gasLimit: '0x1c9c380',
        gasUsed: '0x0',
        miner: '0x' + '00'.repeat(20),
        extraData: '0x',
        baseFeePerGas: '0x1',
        transactions: [],
      }
    throw new Error(`Offline probe rejected ${request.method}`)
  }
  const httpClient = {
    submitRawTransaction: jest.fn(async (raw: string) => {
      const tx = Transaction.from(raw)
      submitted.push(raw)
      if (controls.secondSubmitFailure && submitted.length === 2)
        throw new Error('second submission interrupted')
      if (!controls.receiptPending) {
        if (controls.receiptStatus === 'success') {
          balances.set(
            tx.to!.toLowerCase(),
            (balances.get(tx.to!.toLowerCase()) ?? 0n) + tx.value
          )
        }
        nonces.set(tx.from!.toLowerCase(), tx.nonce + 1)
      }
      return tx.hash!
    }),
    getTransactionReceipt: jest.fn(async (txHash: string) =>
      controls.receiptPending
        ? undefined
        : {
            txHash,
            blockNumber: 1,
            blockHash: controls.receiptBlockHash,
            status: controls.receiptStatus,
            gasUsed: 21_000n,
            effectiveGasPrice: 1n,
            logs: [],
          }
    ),
  }
  const signers = [1, 2].map((n) => {
    const wallet = new Wallet('0x' + n.toString(16).padStart(64, '0'))
    balances.set(wallet.address.toLowerCase(), 1_000_000n)
    return new MonadAccountTxSigner({
      privateKey: wallet.privateKey,
      provider,
      httpClient,
    })
  })
  const originalBuild = signers[1].buildAndSignTransfer.bind(signers[1])
  jest
    .spyOn(signers[1], 'buildAndSignTransfer')
    .mockImplementation((...args) => {
      if (controls.secondBuildFailure)
        throw new Error('second signing interrupted')
      return originalBuild(...args)
    })
  return {
    directory,
    keyring,
    balances,
    nonces,
    submitted,
    controls,
    signers,
    provider,
    httpClient,
    get pool() {
      return pool
    },
    get store() {
      return store
    },
    prepare: () =>
      pool.prepareBurnAccount({
        mainAccountSigner: signers[0],
        provider,
        burnValueWei: 1_000n,
        gasReserveWei: 10n,
        funders: [
          { signer: signers[0], amountWei: 505n },
          { signer: signers[1], amountWei: 505n },
        ],
        fundingOverrides: overrides,
        receipt: { maxAttempts: 0 },
        claimFor: 'authorized-burn',
      }),
    reopen: async () => {
      await store.Close()
      store = new LevelSubAccountPoolStore(directory)
      await store.Open()
      pool = new MonadSubAccountPool({
        keyring,
        store,
        expectedChainId: 10143n,
      })
    },
    close: async () => {
      await store.Close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

it('two-funder completion retains BOTH signed artifacts and anchored observations through repeated Level reopen and terminal compaction', async () => {
  const f = await fixture()
  try {
    const result = await f.prepare()
    expect(f.submitted).toHaveLength(2)
    expect(new Set(f.submitted.map((raw) => Transaction.from(raw).from)).size).toBe(2)
    for (let i = 0; i < 2; i++) {
      await f.reopen()
      const row = f.pool.getRecord(result.index)!
      expect(row.status).toBe('available')
      expect(row.funding?.hold).toBeUndefined()
      expect(row.funding?.attempts.map((a) => a.rawTx)).toEqual(f.submitted)
      for (const attempt of row.funding!.attempts) {
        expect(attempt.generation).toBe(2)
        expect(attempt.observation).toMatchObject({
          kind: 'included',
          execution: 'success',
          receiptBlock: { number: 1, hash: BLOCK_HASH },
        })
      }
    }
    const childSigner = f.pool.getSigner(result.index, {
      provider: f.provider,
      httpClient: f.httpClient,
    })
    const spendTx = await childSigner.buildAndSignTransfer(
      '0x' + '33'.repeat(20),
      1_000n,
      overrides
    )
    await f.pool.commitSpend(result.index, spendTx.rawTx)
    await f.pool.recordRecoveryDisposition(result.index, {
      kind: 'none',
      valueWei: '0',
    })
    expect(await f.pool.compactTerminalAccounts({ limit: 10 })).toBe(1)
    await f.reopen()
    const [checkpoint] = f.pool.terminalCheckpoints()
    expect(checkpoint.index).toBe(result.index)
    expect(checkpoint.funding.attempts.map((a) => a.rawTx)).toEqual(f.submitted)
  } finally {
    await f.close()
  }
})

it('interruption BEFORE second signature retains first contributor and preparation hold in funding across reopen while unrelated accounts stay usable', async () => {
  const f = await fixture()
  try {
    f.controls.secondBuildFailure = true
    await expect(f.prepare()).rejects.toThrow('second signing interrupted')
    expect(f.submitted).toHaveLength(1)
    expect(f.pool.claimedBy(0)).toBeUndefined()
    await f.reopen()
    const heldRow = f.pool.getRecord(0)!
    expect(heldRow.status).toBe('funding')
    expect(heldRow.funding?.hold).toEqual({
      operationId: 'authorized-burn',
      expectedContributors: 2,
    })
    expect(heldRow.funding?.attempts).toHaveLength(1)
    expect(heldRow.funding?.attempts[0].rawTx).toBe(f.submitted[0])
    expect(heldRow.funding?.attempts[0].observation.kind).toBe('included')
    expect(f.pool.selectForStamp()).toBeUndefined()

    // Unrelated account (index 1) can be funded and used without repeating contributor 0 or releasing index 0's hold
    const topUp = await f.pool.topUpPool({
      mainAccountSigner: f.signers[0],
      burnValue: 100n,
      gasReserve: 10n,
      bufferSize: 1,
      overrides,
      receipt: { maxAttempts: 0 },
    })
    expect(topUp).toHaveLength(1)
    expect(topUp[0].index).toBe(1)
    expect(f.submitted).toHaveLength(2)
    expect(f.pool.getRecord(0)?.status).toBe('funding')
    expect(f.pool.selectForStamp()?.index).toBe(1)
  } finally {
    await f.close()
  }
})

it('interruption AFTER second contributor registration retains BOTH contributors across reopen', async () => {
  const f = await fixture()
  try {
    f.controls.secondSubmitFailure = true
    await expect(f.prepare()).rejects.toThrow('second submission interrupted')
    expect(f.submitted).toHaveLength(2)
    await f.reopen()
    const row = f.pool.getRecord(0)!
    expect(row.status).toBe('funding')
    expect(row.funding?.hold).toEqual({
      operationId: 'authorized-burn',
      expectedContributors: 2,
    })
    expect(row.funding?.attempts.map((a) => a.rawTx)).toEqual(f.submitted)
    expect(row.funding?.attempts[0].observation.kind).toBe('included')
    expect(row.funding?.attempts[1].observation).toEqual({
      kind: 'unresolved',
      reason: 'pending',
    })
    expect(f.pool.selectForStamp()).toBeUndefined()
  } finally {
    await f.close()
  }
})

it('a failed Level write fences the store as uncertain, refusing selection and further reads until reopen recovers committed state', async () => {
  const f = await fixture()
  try {
    const db = (f.store as any).openedDb
    const original = db.batch.bind(db)
    db.batch = async () => {
      throw new Error('offline durability failure')
    }
    await expect(f.pool.setStatus(0, 'available')).rejects.toThrow(
      'offline durability failure'
    )
    expect(() => f.pool.selectForStamp()).toThrow('Pool store is uncertain')
    await expect(f.pool.setStatus(0, 'available')).rejects.toThrow(
      'Pool store is uncertain'
    )
    db.batch = original
    await f.reopen()
    expect(f.pool.getRecord(0)?.status).toBe('unfunded')
  } finally {
    await f.close()
  }
})

it('missing funding receipt plus positive balance OR unknown receipt execution keeps the obligation unresolved and non-selectable', async () => {
  const f = await fixture()
  try {
    f.controls.receiptPending = true
    const target = f.pool.getRecord(0)!
    const signed = await f.signers[0].buildAndSignTransfer(
      target.address,
      505n,
      overrides
    )
    await f.pool.registerFundingAttempt({
      index: 0,
      rawTx: signed.rawTx,
      txHash: signed.txHash,
      funder: f.signers[0].address,
    })
    await f.pool.flush()
    f.balances.set(target.address.toLowerCase(), 505n)
    await expect(
      f.pool.topUpPool({
        mainAccountSigner: f.signers[0],
        burnValue: 1n,
        gasReserve: 1n,
        bufferSize: 1,
        overrides,
        receipt: { maxAttempts: 0 },
      })
    ).rejects.toThrow('still pending')
    expect(f.pool.getRecord(0)?.status).toBe('funding')
    expect(f.pool.getRecord(0)?.funding?.attempts[0].observation).toEqual({
      kind: 'unresolved',
      reason: 'pending',
    })
    expect(f.pool.selectForStamp()).toBeUndefined()

    // Unknown receipt execution also remains unresolved in funding
    f.controls.receiptPending = false
    f.controls.receiptStatus = 'unknown'
    f.nonces.set(f.signers[0].address.toLowerCase(), 1)
    await expect(
      f.pool.topUpPool({
        mainAccountSigner: f.signers[0],
        burnValue: 1n,
        gasReserve: 1n,
        bufferSize: 1,
        overrides,
        receipt: { maxAttempts: 0 },
      })
    ).rejects.toThrow('unknown-execution')
    expect(f.pool.getRecord(0)?.status).toBe('funding')
    expect(f.pool.getRecord(0)?.funding?.attempts[0].observation).toEqual({
      kind: 'unresolved',
      reason: 'unknown-execution',
    })
    expect(f.pool.selectForStamp()).toBeUndefined()
  } finally {
    await f.close()
  }
})

it('reverted and superseded funding attempts retire the row while retaining signed artifacts and anchored evidence across reopen', async () => {
  const f = await fixture()
  try {
    // 1. Reverted funding attempt on index 0
    f.controls.receiptStatus = 'failure'
    await expect(
      f.pool.topUpPool({
        mainAccountSigner: f.signers[0],
        burnValue: 100n,
        gasReserve: 10n,
        bufferSize: 1,
        overrides,
        receipt: { maxAttempts: 0 },
      })
    ).rejects.toThrow('failed')
    // 2. Superseded funding attempt on index 1
    f.controls.receiptPending = true
    const target1 = f.pool.getRecord(1)!
    const supersededTx = await f.signers[1].buildAndSignTransfer(
      target1.address,
      200n,
      overrides
    )
    await f.pool.registerFundingAttempt({
      index: 1,
      rawTx: supersededTx.rawTx,
      txHash: supersededTx.txHash,
      funder: f.signers[1].address,
    })
    await f.pool.flush()
    f.nonces.set(f.signers[1].address.toLowerCase(), 5)
    await expect(
      f.pool.topUpPool({
        mainAccountSigner: f.signers[1],
        burnValue: 100n,
        gasReserve: 10n,
        bufferSize: 1,
        overrides,
        receipt: { maxAttempts: 0 },
      })
    ).rejects.toThrow('superceded by a later nonce')

    await f.reopen()
    const row0 = f.pool.getRecord(0)!
    expect(row0.status).toBe('retired')
    expect(row0.funding?.attempts).toHaveLength(1)
    expect(row0.funding?.attempts[0].observation).toMatchObject({
      kind: 'included',
      execution: 'failure',
      receiptBlock: { number: 1, hash: BLOCK_HASH },
    })

    const row1 = f.pool.getRecord(1)!
    expect(row1.status).toBe('retired')
    expect(row1.funding?.attempts).toHaveLength(1)
    expect(row1.funding?.attempts[0].rawTx).toBe(supersededTx.rawTx)
    expect(row1.funding?.attempts[0].observation).toMatchObject({
      kind: 'superseded',
      accounts: {
        block: { number: 1, hash: BLOCK_HASH },
        senderNonce: '5',
      },
    })
  } finally {
    await f.close()
  }
})

it('installed input admission holds the partially funded target after reopen and refuses unrelated native spends on it while permitting unrelated accounts', async () => {
  const f = await fixture()
  const binding = {
    chainIdentifier: 'monad-testnet',
    nativeChainId: '10143',
    publicTuple: 'offline-probe',
  }
  const native = new EvmNativeOperationJournal({
    location: f.directory,
    binding,
  })
  try {
    f.controls.secondBuildFailure = true
    await expect(f.prepare()).rejects.toThrow('second signing interrupted')
    await f.reopen()
    await f.pool.setStatus(1, 'available')
    await native.Open()
    const changeKeyring = MonadChangeKeyring.fromMnemonic(mnemonic)
    const change = new MonadChangePool({ keyring: changeKeyring })
    const lifetime = Object.freeze({ walletBindingId: 'offline-probe' })
    const admission = createEvmInputAdmission({
      binding,
      native,
      pool: f.pool,
      change,
      topic: new InMemoryTopicOperationJournal(),
      leases: new SubAccountLeaseManager(f.pool),
      assertLifetime: (token) => {
        if (token !== lifetime) throw new Error('foreign lifetime')
      },
      validate: () =>
        validateMonadWalletState({
          pool: f.pool,
          changePool: change,
          subKeyring: f.keyring,
          changeKeyring,
          expectedChainId: 10143n,
        }),
    })
    const snapshot = admission.inspect(lifetime)
    expect(snapshot.status).toBe('ready')
    if (snapshot.status !== 'ready') throw new Error('admission not ready')
    expect(snapshot.obligations).toHaveLength(1)
    expect(snapshot.obligations[0]).toMatchObject({
      provenance: {
        kind: 'pool-funding',
        poolIndex: 0,
        role: 'funding',
      },
    })
    const recipient = '0x' + '12'.repeat(20)
    await expect(
      admission.prepareNative(lifetime, snapshot.epoch, {
        kind: 'native',
        recipient,
        intendedValueWei: '1',
        members: [
          {
            source: {
              kind: 'spend',
              index: 0,
              address: f.pool.getRecord(0)!.address.toLowerCase(),
            },
            dependencies: [],
            unsignedTransaction: Transaction.from({
              type: 2,
              chainId: 10143,
              nonce: 0,
              to: recipient,
              value: 1n,
              gasLimit: 21_000n,
              maxFeePerGas: 0n,
              maxPriorityFeePerGas: 0n,
            }).unsignedSerialized,
          },
        ],
      })
    ).rejects.toThrow()
    expect(native.referencesSpendIndex(0)).toBe(false)

    // Unrelated available sub-account 1 remains admissible
    const freshSnapshot = admission.inspect(lifetime)
    if (freshSnapshot.status !== 'ready') throw new Error('admission not ready')
    const operation = await admission.prepareNative(
      lifetime,
      freshSnapshot.epoch,
      {
        kind: 'native',
        recipient,
        intendedValueWei: '1',
        members: [
          {
            source: {
              kind: 'spend',
              index: 1,
              address: f.pool.getRecord(1)!.address.toLowerCase(),
            },
            dependencies: [],
            unsignedTransaction: Transaction.from({
              type: 2,
              chainId: 10143,
              nonce: 0,
              to: recipient,
              value: 1n,
              gasLimit: 21_000n,
              maxFeePerGas: 0n,
              maxPriorityFeePerGas: 0n,
            }).unsignedSerialized,
          },
        ],
      }
    )
    expect(operation.members[0].source).toMatchObject({
      kind: 'spend',
      index: 1,
    })
    expect(native.referencesSpendIndex(1)).toBe(true)
  } finally {
    await native.Close()
    await f.close()
  }
})

it('refuses wrong hash/sender/recipient/chainId, keeps same-height replacement unresolved, enforces A->B->A generation CAS while preserving concurrent contributors, and refuses v3 stores without writes', async () => {
  const f = await fixture()
  try {
    const target0 = f.pool.getRecord(0)!
    const validSigned = await f.signers[0].buildAndSignTransfer(
      target0.address,
      100n,
      overrides
    )

    // Wrong hash, wrong sender, wrong recipient, wrong chainId
    await expect(
      f.pool.registerFundingAttempt({
        index: 0,
        rawTx: validSigned.rawTx,
        txHash: '0x' + 'ab'.repeat(32),
        funder: f.signers[0].address,
      })
    ).rejects.toThrow('txHash mismatch')
    await expect(
      f.pool.registerFundingAttempt({
        index: 0,
        rawTx: validSigned.rawTx,
        txHash: validSigned.txHash,
        funder: f.signers[1].address,
      })
    ).rejects.toThrow('sender mismatch')
    await expect(
      f.pool.registerFundingAttempt({
        index: 1,
        rawTx: validSigned.rawTx,
        txHash: validSigned.txHash,
        funder: f.signers[0].address,
      })
    ).rejects.toThrow('recipient mismatch')
    const wrongChainRaw = await new Wallet(
      '0x' + (1).toString(16).padStart(64, '0')
    ).signTransaction({
      type: 2,
      chainId: 1n,
      nonce: 0,
      to: target0.address,
      value: 100n,
      gasLimit: 21_000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
    })
    await expect(
      f.pool.registerFundingAttempt({
        index: 0,
        rawTx: wrongChainRaw,
        txHash: Transaction.from(wrongChainRaw).hash!,
        funder: f.signers[0].address,
      })
    ).rejects.toThrow('chainId mismatch')

    // Register valid attempt 0 under multi-funder hold
    const hold = { operationId: 'cas-test', expectedContributors: 2 }
    await f.pool.registerFundingAttempt({
      index: 0,
      rawTx: validSigned.rawTx,
      txHash: validSigned.txHash,
      funder: f.signers[0].address,
      hold,
    })
    // Exact replay is idempotent and does not increment generation
    const replayed = await f.pool.registerFundingAttempt({
      index: 0,
      rawTx: validSigned.rawTx,
      txHash: validSigned.txHash,
      funder: f.signers[0].address,
      hold,
    })
    expect(replayed.funding?.attempts[0].generation).toBe(1)

    // Same-height replacement (receipt block hash != canonical block hash) remains unresolved(inconsistent)
    f.controls.receiptBlockHash = '0x' + '99'.repeat(32)
    f.nonces.set(f.signers[0].address.toLowerCase(), 1)
    await expect(
      f.pool.topUpPool({
        mainAccountSigner: f.signers[0],
        burnValue: 1n,
        gasReserve: 1n,
        bufferSize: 1,
        overrides,
        receipt: { maxAttempts: 0 },
      })
    ).rejects.toThrow('inconsistent')
    expect(f.pool.getRecord(0)?.funding?.attempts[0]).toMatchObject({
      generation: 2,
      observation: { kind: 'unresolved', reason: 'inconsistent' },
    })

    // A -> B -> A generation transitions refuse stale completion (expectedGeneration: 1 or 2)
    await f.pool.recordFundingObservation({
      index: 0,
      txHash: validSigned.txHash,
      rawTx: validSigned.rawTx,
      expectedGeneration: 2,
      observation: { kind: 'unresolved', reason: 'pending' },
    })
    expect(f.pool.getRecord(0)?.funding?.attempts[0].generation).toBe(3)
    await expect(
      f.pool.recordFundingObservation({
        index: 0,
        txHash: validSigned.txHash,
        rawTx: validSigned.rawTx,
        expectedGeneration: 1,
        observation: {
          kind: 'included',
          execution: 'success',
          receiptBlock: { number: 1, hash: BLOCK_HASH },
          accounts: {
            block: { number: 1, hash: BLOCK_HASH },
            senderNonce: '1',
            recipientNonce: '0',
            recipientBalance: '100',
          },
        },
      })
    ).rejects.toThrow('Stale funding attempt generation')

    // Concurrent second contributor registration on the same row is preserved when completing attempt 0
    const secondSigned = await f.signers[1].buildAndSignTransfer(
      target0.address,
      200n,
      overrides
    )
    await f.pool.registerFundingAttempt({
      index: 0,
      rawTx: secondSigned.rawTx,
      txHash: secondSigned.txHash,
      funder: f.signers[1].address,
      hold,
    })
    await f.pool.recordFundingObservation({
      index: 0,
      txHash: validSigned.txHash,
      rawTx: validSigned.rawTx,
      expectedGeneration: 3,
      observation: {
        kind: 'included',
        execution: 'success',
        receiptBlock: { number: 1, hash: BLOCK_HASH },
        accounts: {
          block: { number: 1, hash: BLOCK_HASH },
          senderNonce: '1',
          recipientNonce: '0',
          recipientBalance: '100',
        },
      },
    })
    const preserved = f.pool.getRecord(0)!
    expect(preserved.status).toBe('funding')
    expect(preserved.funding?.attempts).toHaveLength(2)
    expect(preserved.funding?.attempts[0].observation.kind).toBe('included')
    expect(preserved.funding?.attempts[1].rawTx).toBe(secondSigned.rawTx)

    // Incompatible v3 format is refused without mutating any bytes
    const legacyDir = mkdtempSync(join(tmpdir(), 'frank-legacy-v3-refusal-'))
    try {
      const db = level(join(legacyDir, 'wallet-manifest'))
      await db.put(
        'manifest',
        JSON.stringify({
          schema: 'frank-monad-wallet-state',
          version: 3,
          bindingId: 'a'.repeat(64),
          seedFingerprint: '0x' + 'b'.repeat(64),
          intents: [
            'sub-account-pool-v3-authoritative',
            'change-pool-v2',
          ],
        })
      )
      await db.close()
      const poolDb = level(join(legacyDir, 'sub-account-pool'))
      await poolDb.put('__pool_format__', 'sub-account-pool-v3-authoritative')
      await poolDb.put('__next_index__', '1')
      await poolDb.close()

      const digestOf = async (component: string) => {
        const handle = level(join(legacyDir, component))
        try {
          const entries = await Array.fromAsync((handle as any).iterator())
          return createHash('sha256')
            .update(JSON.stringify(entries))
            .digest('hex')
        } finally {
          await handle.close()
        }
      }
      const beforeManifest = await digestOf('wallet-manifest')
      const beforePool = await digestOf('sub-account-pool')

      await expect(
        openMonadWalletBundle({
          location: legacyDir,
          expectedChainId: 10143n,
        })
      ).rejects.toThrow(/Unsupported.*manifest|owner disposition required/i)

      await expect(
        openMonadWalletBundle({
          location: legacyDir,
          mode: 'restore',
          seed: { mnemonic },
          expectedChainId: 10143n,
        })
      ).rejects.toThrow(/Unsupported.*manifest|owner disposition required/i)

      const directPool = new LevelSubAccountPoolStore(legacyDir)
      await expect(directPool.Open()).rejects.toThrow(
        /Unsupported pool baseline.*owner disposition required/i
      )

      expect(await digestOf('wallet-manifest')).toBe(beforeManifest)
      expect(await digestOf('sub-account-pool')).toBe(beforePool)
    } finally {
      rmSync(legacyDir, { recursive: true, force: true })
    }
  } finally {
    await f.close()
  }
})
