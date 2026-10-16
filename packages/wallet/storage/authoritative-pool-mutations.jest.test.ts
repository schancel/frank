import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LevelSubAccountPoolStore } from './level-sub-account-pool-store'
import { MonadSubAccountPool } from '../monad-account-pool'
import { MonadHdKeyring } from '../monad-hd-keyring'

it('a failed eligibility write rejects the mutation and fences selection and repeated flush', async () => {
  const location = mkdtempSync(join(tmpdir(), 'frank-authoritative-pool-'))
  const store = new LevelSubAccountPoolStore(location)
  await store.Open()
  const pool = new MonadSubAccountPool({
    store,
    keyring: MonadHdKeyring.fromMnemonic(
      'test test test test test test test test test test test junk'
    ),
  })
  try {
    await pool.ensureUnfundedSize(1)
    await pool.flush()
    const db = (store as any).openedDb
    db.batch = async () => {
      throw new Error('fault-injected durable failure')
    }
    await expect(
      Promise.resolve().then(() => pool.setStatus(0, 'available'))
    ).rejects.toThrow('fault-injected durable failure')
    expect(() => pool.selectForStamp()).toThrow(/uncertain/i)
    await expect(pool.flush()).rejects.toThrow(/uncertain/i)
    await expect(pool.flush()).rejects.toThrow(/uncertain/i)
  } finally {
    await store.Close().catch(() => undefined)
    rmSync(location, { recursive: true, force: true })
  }
})

import level from 'level'
import { SubAccountLeaseManager } from '../monad-account-lease'
import type { SubAccountRecord } from './sub-account-pool-storage'

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function withOwner(
  run: (store: LevelSubAccountPoolStore, location: string) => Promise<void>
) {
  const location = mkdtempSync(join(tmpdir(), 'frank-pool-authority-'))
  const store = new LevelSubAccountPoolStore(location)
  await store.Open()
  try {
    await run(store, location)
  } finally {
    await store.Close()
    rmSync(location, { recursive: true, force: true })
  }
}
async function write(
  store: LevelSubAccountPoolStore,
  record: SubAccountRecord
) {
  await store.mutate(() => ({
    records: [{ record, expectedRevision: record.revision ?? 0 }],
    result: undefined,
  }))
}

it('publishes success only after the real durable batch, with detached snapshots and idempotent replay', async () => {
  await withOwner(async (store) => {
    await write(store, { index: 0, address: 'owned', status: 'unfunded' })
    const before = store.getByIndex(0)!
    const entered = barrier(),
      release = barrier()
    const db = (store as any).openedDb,
      original = db.batch.bind(db)
    db.batch = async (...args: any[]) => {
      entered.resolve()
      await release.promise
      return original(...args)
    }
    const pending = write(store, { ...before, status: 'available' })
    await entered.promise
    expect(store.getByIndex(0)?.status).toBe('unfunded')
    before.address = 'detached mutation'
    expect(store.getByIndex(0)?.address).toBe('owned')
    release.resolve()
    await pending
    const committed = store.getByIndex(0)!
    expect(committed).toMatchObject({
      status: 'available',
      revision: 2,
      address: 'owned',
    })
    await write(store, committed)
    expect(store.getByIndex(0)?.revision).toBe(2)
  })
})

it('two pool wrappers and lease managers over one actual backend grant exactly one same-row owner', async () => {
  await withOwner(async (store) => {
    const keyring = MonadHdKeyring.fromMnemonic(
      'test test test test test test test test test test test junk'
    )
    const first = new MonadSubAccountPool({ keyring, store }),
      second = new MonadSubAccountPool({ keyring, store })
    await first.ensureSize(2)
    const managers = [
      new SubAccountLeaseManager(first),
      new SubAccountLeaseManager(second),
    ]
    const result = await Promise.allSettled(
      managers.map((manager) => manager.acquireForIndex(0))
    )
    expect(result.filter((row) => row.status === 'fulfilled')).toHaveLength(1)
    expect(store.getByIndex(0)?.status).toBe('in-use')
    expect(first.selectForStamp()?.index).toBe(1)
    const winner = result.findIndex((row) => row.status === 'fulfilled')
    const handle = (result[winner] as PromiseFulfilledResult<any>).value
    await managers[winner].releaseLease(handle, 'confirmed')
    expect(store.getByIndex(0)?.status).toBe('spent')
  })
})

it('rejects A to B to A stale full-row completion while permitting unrelated rows', async () => {
  await withOwner(async (store) => {
    await write(store, { index: 0, address: 'a', status: 'available' })
    await write(store, { index: 1, address: 'b', status: 'available' })
    const captured = store.getByIndex(0)!
    await write(store, { ...captured, status: 'in-use' })
    await write(store, { ...store.getByIndex(0)!, status: 'available' })
    await write(store, { ...store.getByIndex(1)!, status: 'in-use' })
    await expect(
      write(store, { ...captured, status: 'retired' })
    ).rejects.toThrow('Stale pool revision')
    expect(store.getByIndex(0)).toMatchObject({
      status: 'available',
      revision: 3,
    })
    expect(store.getByIndex(1)).toMatchObject({
      status: 'in-use',
      revision: 2,
    })
    await store.flush()
  })
})

it('atomically converts a terminal row without lowering allocation or recreating its index across reopen', async () => {
  await withOwner(async (store, location) => {
    const lifecycle = {
      funding: { rawTx: 'funding', txHash: 'funding-hash', valueWei: '10' },
      spend: { rawTx: 'spend', txHash: 'spend-hash', valueWei: '1' },
      recovery: { kind: 'none' as const, valueWei: '0' as const },
    }
    await write(store, {
      index: 0,
      address: 'owned',
      status: 'spent',
      lifecycle,
    })
    await store.mutate(() => ({
      checkpoints: [
        {
          expectedRevision: 1,
          checkpoint: {
            version: 1,
            index: 0,
            address: 'owned',
            status: 'spent',
            denominationWei: '1',
            lifecycle,
            compactedAt: 1,
          },
        },
      ],
      result: undefined,
    }))
    await store.Close()
    await store.Open()
    expect(store.getByIndex(0)).toBeUndefined()
    expect(store.getCheckpoints()[0]).toMatchObject({ revision: 2, lifecycle })
    expect(store.getNextIndex()).toBe(1)
    await expect(
      write(store, { index: 0, address: 'owned', status: 'available' })
    ).rejects.toThrow('Cannot recreate compacted')
    await write(store, { index: 1, address: 'next', status: 'unfunded' })
    expect(store.getNextIndex()).toBe(2)
  })
})

it('close refuses new work immediately and drains an already pending batch without losing its disk outcome', async () => {
  await withOwner(async (store) => {
    const entered = barrier(),
      release = barrier()
    const db = (store as any).openedDb,
      original = db.batch.bind(db)
    db.batch = async (...args: any[]) => {
      entered.resolve()
      await release.promise
      return original(...args)
    }
    const pending = write(store, {
      index: 0,
      address: 'owned',
      status: 'unfunded',
    })
    await entered.promise
    const close = store.Close()
    expect(() => store.getAll()).toThrow('closing')
    release.resolve()
    await pending
    await close
    await store.Open()
    expect(store.getByIndex(0)?.revision).toBe(1)
  })
})

it('refuses old raw records without changing bytes and opens a genuinely empty store without defaults', async () => {
  const location = mkdtempSync(join(tmpdir(), 'frank-pool-format-'))
  const db = level(join(location, 'sub-account-pool'))
  const original = JSON.stringify({
    index: 0,
    address: 'old-owned',
    status: 'funding',
    fundingAttempt: { rawTx: 'signed-obligation', txHash: 'hash' },
  })
  await db.put('0', original)
  await db.close()
  const store = new LevelSubAccountPoolStore(location)
  try {
    await expect(store.Open()).rejects.toThrow(/Unsupported/)
    const check = level(join(location, 'sub-account-pool'))
    expect(await check.get('0')).toBe(original)
    expect(await Array.fromAsync((check as any).iterator())).toEqual([
      ['0', original],
    ])
    await check.close()
  } finally {
    await store.Close()
    rmSync(location, { recursive: true, force: true })
  }
  await withOwner(async (empty) => {
    expect(await Array.fromAsync((empty as any).openedDb.iterator())).toEqual(
      []
    )
  })
})

it('a batch that commits then rejects stays uncertain until reopen reveals the committed disk outcome', async () => {
  await withOwner(async (store) => {
    await write(store, { index: 0, address: 'owned', status: 'unfunded' })
    const before = store.getByIndex(0)!
    const db = (store as any).openedDb,
      original = db.batch.bind(db)
    db.batch = async (...args: any[]) => {
      await original(...args)
      throw new Error('commit response lost')
    }
    await expect(
      write(store, { ...before, status: 'available' })
    ).rejects.toThrow('commit response lost')
    expect(() => store.getByIndex(0)).toThrow('uncertain')
    await expect(store.flush()).rejects.toThrow('uncertain')
    await expect(store.flush()).rejects.toThrow('uncertain')
    await store.Close()
    await store.Open()
    expect(store.getByIndex(0)).toMatchObject({
      status: 'available',
      revision: 2,
    })
    await write(store, store.getByIndex(0)!)
    expect(store.getByIndex(0)?.revision).toBe(2)
  })
})

it('refuses revision overflow without mutation, while exact replay at the maximum remains idempotent', async () => {
  await withOwner(async (store) => {
    await write(store, { index: 0, address: 'owned', status: 'available' })
    const db = (store as any).openedDb
    await db.put(
      '0',
      JSON.stringify({
        version: 3,
        revision: Number.MAX_SAFE_INTEGER,
        value: { index: 0, address: 'owned', status: 'available' },
      })
    )
    await store.Close()
    await store.Open()
    const maximum = store.getByIndex(0)!
    await write(store, maximum)
    await expect(
      write(store, { ...maximum, status: 'retired' })
    ).rejects.toThrow('overflow')
    expect(store.getByIndex(0)).toEqual(maximum)
  })
})

it('exposes no unrestricted legacy pool-store mutation APIs', async () => {
  await withOwner(async (store) => {
    for (const method of [
      'put',
      'putMany',
      'setNextIndex',
      'replaceWithCheckpoint',
      'clear',
    ]) {
      expect(
        (store as unknown as Record<string, unknown>)[method]
      ).toBeUndefined()
    }
  })
})

it('an actual funding receipt wait does not block another row lease, and its stale completion preserves the original obligation', async () => {
  const { Wallet, Transaction } = await import('ethers')
  await withOwner(async (store) => {
    const keyring = MonadHdKeyring.fromMnemonic(
      'test test test test test test test test test test test junk'
    )
    const pool = new MonadSubAccountPool({ keyring, store })
    await pool.ensureUnfundedSize(2)
    const wallet = new Wallet('0x' + '01'.repeat(32))
    const rawTx = await wallet.signTransaction({
      type: 2,
      chainId: 10143,
      nonce: 0,
      to: pool.getRecord(0)!.address,
      value: 10n,
      gasLimit: 21000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
    })
    const attempt = { rawTx, txHash: Transaction.from(rawTx).hash! }
    await write(store, {
      ...pool.getRecord(0)!,
      status: 'funding',
      fundingAttempt: attempt,
    })
    await pool.setStatus(1, 'available')
    const entered = barrier(),
      release = barrier()
    const signing = jest.fn(() => {
      throw new Error('no replacement funding authorized')
    })
    const signer = {
      getStatus: async () => {
        entered.resolve()
        await release.promise
        return 'confirmed'
      },
      buildAndSignTransfer: signing,
    } as any
    const completing = pool.topUpPool({
      mainAccountSigner: signer,
      burnValue: 1n,
      gasReserve: 1n,
      bufferSize: 1,
      receipt: { maxAttempts: 0 },
    })
    await entered.promise
    const lease = await new SubAccountLeaseManager(pool).acquireForIndex(1)
    expect(lease.index).toBe(1)
    const original = pool.getRecord(0)!
    // Both hashes identify the same signed transfer and the obligation remains nonterminal.
    // Every accepted intervening payload write advances revision, including A to B to A.
    await write(store, {
      ...original,
      status: 'funding',
      fundingAttempt: { ...attempt, txHash: attempt.txHash.toUpperCase() },
    })
    await write(store, {
      ...pool.getRecord(0)!,
      status: 'funding',
      fundingAttempt: attempt,
    })
    release.resolve()
    await expect(completing).rejects.toThrow('Stale pool revision')
    expect(pool.getRecord(0)).toMatchObject({
      status: 'funding',
      fundingAttempt: attempt,
      revision: original.revision! + 2,
    })
    expect(signing).not.toHaveBeenCalled()
  })
})

it('initializes format, binding and high-water in one authorized batch without a partial binding checkpoint', async () => {
  const location = mkdtempSync(join(tmpdir(), 'frank-pool-binding-'))
  const store = new LevelSubAccountPoolStore(location, 'owned-binding')
  await store.Open()
  try {
    const db = (store as any).openedDb
    const batch = jest.spyOn(db, 'batch')
    expect(await Array.fromAsync(db.iterator())).toEqual([])
    await store.Bind()
    expect(batch).toHaveBeenCalledTimes(1)
    expect(batch.mock.calls[0][0]).toEqual(
      expect.arrayContaining([
        {
          type: 'put',
          key: '__pool_format__',
          value: 'sub-account-pool-v3-authoritative',
        },
        { type: 'put', key: '__wallet_binding__', value: 'owned-binding' },
        { type: 'put', key: '__next_index__', value: '0' },
      ])
    )
    await store.Close()
    await store.Open()
    expect(store.bindingId()).toBe('owned-binding')
  } finally {
    await store.Close()
    rmSync(location, { recursive: true, force: true })
  }
})

it('does not adopt a nonempty unbound v3 pool into a different manifest owner', async () => {
  const location = mkdtempSync(join(tmpdir(), 'frank-pool-unbound-'))
  const original = new LevelSubAccountPoolStore(location)
  await original.Open()
  await write(original, {
    index: 0,
    address: 'retained-owned',
    status: 'unfunded',
  })
  const bytes = await Array.fromAsync((original as any).openedDb.iterator())
  await original.Close()
  const bound = new LevelSubAccountPoolStore(location, 'new-manifest-binding')
  try {
    await expect(bound.Open()).rejects.toThrow('binding')
    await original.Open()
    expect(
      await Array.fromAsync((original as any).openedDb.iterator())
    ).toEqual(bytes)
  } finally {
    await bound.Close()
    await original.Close()
    rmSync(location, { recursive: true, force: true })
  }
})

it('a fresh revision cannot resurrect spent or retired rows through either pool or raw store mutation', async () => {
  await withOwner(async (store) => {
    const keyring = MonadHdKeyring.fromMnemonic(
      'test test test test test test test test test test test junk'
    )
    const pool = new MonadSubAccountPool({ keyring, store })
    await pool.ensureSize(2)
    for (const [index, status] of (['spent', 'retired'] as const).entries()) {
      const staleAvailable = pool.getRecord(index)!
      await pool.setStatus(index, status)
      await expect(write(store, { ...staleAvailable, status: 'in-use' })).rejects.toThrow('Stale pool revision')
      const terminal = pool.getRecord(index)!
      await expect(pool.setStatus(index, 'available')).rejects.toThrow(
        'Terminal sub-account'
      )
      await expect(
        write(store, { ...terminal, status: 'unfunded' })
      ).rejects.toThrow('Terminal sub-account')
      expect(pool.getRecord(index)).toEqual(terminal)
      await write(store, terminal)
      expect(pool.getRecord(index)?.revision).toBe(terminal.revision)
      await pool.recordFundingTransaction(index, {
        rawTx: 'retained terminal evidence',
        txHash: 'retained-hash',
        valueWei: '1',
      })
      expect(pool.getRecord(index)).toMatchObject({
        status,
        revision: terminal.revision! + 1,
      })
    }
    expect(pool.selectForStamp()).toBeUndefined()
  })
})
