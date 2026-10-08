/**
 * Unit tests for `monad-change-keyring.ts`, `monad-change-pool.ts`, and
 * `storage/{change-pool-storage,level-change-pool-store}.ts` (ticket #36).
 *
 * Every scenario here is also exercised for real, without jest, by
 * `monad-change-pool.livecheck.ts` in this same directory -- see that file's header for how to run
 * it.
 *
 * Two distinct "provider" roles show up throughout, deliberately kept separate the same way
 * `sweepToChange`'s own signature keeps them separate:
 *   - `burnAccountSigner`'s own internal ethers provider (a stubbed `JsonRpcProvider`, same
 *     `makeStubProvider` pattern `monad-account-pool.jest.test.ts` uses) -- drives
 *     `buildAndSignTransfer`'s nonce/gas/fee/chainId reads when actually building the sweep tx.
 *   - the plain mock `Provider`-shaped object passed as `sweepToChange`'s own `provider` param --
 *     only ever used for `getBalance`/`getFeeData` (the dust-threshold + leftover-balance reads),
 *     so it only needs to implement those two methods, not the full ethers `Provider` interface.
 */
import { JsonRpcProvider, Provider, Transaction, Wallet } from 'ethers'

import { changeAccountPath, MonadChangeKeyring } from './monad-change-keyring'
import {
  awaitLeaseSettlementAndSweepChange,
  estimateDustThresholdWei,
  MonadChangePool,
  releaseLeaseAndSweepChange,
} from './monad-change-pool'
import { MonadHdKeyring } from './monad-hd-keyring'
import { MonadSubAccountPool } from './monad-account-pool'
import {
  AccountLeaseHandle,
  LeaseTxStatusSource,
  SubAccountLeaseManager,
} from './monad-account-lease'
import {
  MonadAccountTxSigner,
  MonadTxStatus,
  MonadTxSubmitter,
} from './monad-account-tx'
import { InMemoryChangePoolStore } from './storage/change-pool-storage'
import { LevelChangePoolStore } from './storage/level-change-pool-store'

const TEST_MNEMONIC =
  'test test test test test test test test test test test junk'
const CHAIN_ID = 10143

function makeStubProvider(
  perform: (req: { method: string }) => Promise<unknown>,
) {
  const provider = new JsonRpcProvider('http://127.0.0.1:1', CHAIN_ID, {
    staticNetwork: true,
    cacheTimeout: -1,
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(provider as any)._perform = perform
  return provider
}

function makeMockHttpClient(): jest.Mocked<MonadTxSubmitter> {
  return {
    submitRawTransaction: jest.fn(
      async (rawTxHex: string) => Transaction.from(rawTxHex).hash,
    ),
    getTransactionReceipt: jest.fn().mockResolvedValue({
      status: 'success',
    } as never),
  }
}

/** Builds a burn-account `MonadAccountTxSigner` whose underlying provider answers just enough
 * `_perform` calls (nonce, gas estimate) for `buildAndSignTransfer` to succeed. */
function makeBurnAccountSigner(params: { nonceStart?: number } = {}) {
  let nonce = params.nonceStart ?? 0
  const provider = makeStubProvider(async req => {
    if (req.method === 'getTransactionCount')
      return `0x${(nonce++).toString(16)}`
    if (req.method === 'estimateGas') return '0x5208'
    throw new Error(`unexpected _perform: ${req.method}`)
  })
  const httpClient = makeMockHttpClient()
  const signer = new MonadAccountTxSigner({
    privateKey: Wallet.createRandom().privateKey,
    provider,
    httpClient,
  })
  return { signer, httpClient }
}

/** A minimal mock satisfying only the two `Provider` methods `sweepToChange`/
 * `estimateDustThresholdWei` actually call -- deliberately not a real ethers `Provider`. */
function makeReadProvider(params: {
  balanceWei: bigint
  maxFeePerGas?: bigint | null
  gasPrice?: bigint | null
}): Provider {
  return {
    getBalance: jest.fn(async () => params.balanceWei),
    getFeeData: jest.fn(async () => ({
      maxFeePerGas: params.maxFeePerGas ?? null,
      gasPrice: params.gasPrice ?? null,
      maxPriorityFeePerGas: null,
    })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as Provider
}

describe('MonadChangeKeyring', () => {
  it('uses the same byte domain root while keeping the change branch disjoint', () => {
    const root = new Uint8Array(32).fill(0x42)
    const domainRoot = { purpose: 'evm-wallet' as const, bytes: root }
    const change =
      MonadChangeKeyring.fromDomainRoot(domainRoot).deriveChangeAccount(0)
    const spend = MonadHdKeyring.fromDomainRoot(domainRoot).deriveSubAccount(0)
    expect(change.address).not.toBe(spend.address)
    expect(change.privateKey).not.toBe(spend.privateKey)
  })

  it('derives the same address/private key from the same mnemonic + index (deterministic)', () => {
    const a =
      MonadChangeKeyring.fromMnemonic(TEST_MNEMONIC).deriveChangeAccount(0)
    const b =
      MonadChangeKeyring.fromMnemonic(TEST_MNEMONIC).deriveChangeAccount(0)
    expect(a.address).toBe(b.address)
    expect(a.privateKey).toBe(b.privateKey)
  })

  it('derives different keypairs for different indices', () => {
    const keyring = MonadChangeKeyring.fromMnemonic(TEST_MNEMONIC)
    const a0 = keyring.deriveChangeAccount(0)
    const a1 = keyring.deriveChangeAccount(1)
    expect(a0.address).not.toBe(a1.address)
  })

  it('derives a different address than the burn keyring for the same index/mnemonic (branch 1 vs branch 0)', () => {
    const changeKeyring = MonadChangeKeyring.fromMnemonic(TEST_MNEMONIC)
    const burnKeyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC)
    expect(changeKeyring.deriveChangeAccount(0).address).not.toBe(
      burnKeyring.deriveSubAccount(0).address,
    )
  })

  it('builds the expected BIP-44 branch-1 path for a given index', () => {
    expect(changeAccountPath(0)).toBe("m/44'/60'/0'/1/0")
    expect(changeAccountPath(7)).toBe("m/44'/60'/0'/1/7")
  })

  it('rejects a negative or non-integer index', () => {
    const keyring = MonadChangeKeyring.fromMnemonic(TEST_MNEMONIC)
    expect(() => keyring.deriveChangeAccount(-1)).toThrow()
    expect(() => keyring.deriveChangeAccount(1.5)).toThrow()
  })

  it('generate() produces a fresh, valid mnemonic that round-trips through fromMnemonic', () => {
    const { keyring, mnemonic } = MonadChangeKeyring.generate()
    expect(mnemonic.split(' ')).toHaveLength(12)
    expect(
      MonadChangeKeyring.fromMnemonic(mnemonic).deriveChangeAccount(0).address,
    ).toBe(keyring.deriveChangeAccount(0).address)
  })

  it('rejects an invalid mnemonic', () => {
    expect(() =>
      MonadChangeKeyring.fromMnemonic('not a real mnemonic'),
    ).toThrow(/invalid.*mnemonic/i)
  })
})

describe('InMemoryChangePoolStore', () => {
  it('starts at next index 0 with no records', () => {
    const store = new InMemoryChangePoolStore()
    expect(store.getNextIndex()).toBe(0)
    expect(store.getAll()).toEqual([])
  })

  it('returns records sorted by index', () => {
    const store = new InMemoryChangePoolStore()
    store.putRecord({
      index: 2,
      address: '0xabc',
      sourceBurnIndex: 9,
      sourceBurnAddress: '0xdead',
      sweptValueWei: '1',
      txHash: '0x1',
      createdAt: 1,
    })
    store.putRecord({
      index: 0,
      address: '0xdef',
      sourceBurnIndex: 1,
      sourceBurnAddress: '0xbeef',
      sweptValueWei: '2',
      txHash: '0x2',
      createdAt: 2,
    })
    expect(store.getAll().map(r => r.index)).toEqual([0, 2])
  })
})

describe('LevelChangePoolStore', () => {
  it('persists next index + records across a simulated app restart', async () => {
    const os = await import('os')
    const path = await import('path')
    const fs = await import('fs')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'change-pool-test-'))
    try {
      const storeA = new LevelChangePoolStore(dir)
      await storeA.Open()
      storeA.putRecord({
        index: 0,
        address: '0xaaa',
        sourceBurnIndex: 5,
        sourceBurnAddress: '0xbbb',
        sweptValueWei: '123',
        txHash: '0xhash',
        createdAt: 42,
      })
      storeA.setNextIndex(1)
      storeA.setPendingIntent({
        index: 1,
        address: '0xccc',
        sourceBurnIndex: 6,
        sourceBurnAddress: '0xddd',
        sweptValueWei: '456',
        rawTx: '0xraw',
        txHash: '0xpending',
        createdAt: 43,
      })
      await storeA.Close()

      const storeB = new LevelChangePoolStore(dir)
      await storeB.Open()
      expect(storeB.getNextIndex()).toBe(1)
      expect(storeB.getAll()).toHaveLength(1)
      expect(storeB.getRecord(0)?.sweptValueWei).toBe('123')
      expect(storeB.getPendingIntent()).toMatchObject({
        index: 1,
        txHash: '0xpending',
      })
      await storeB.Close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('estimateDustThresholdWei', () => {
  it('computes 21000 * maxFeePerGas * 2 when EIP-1559 fee data is available', async () => {
    const provider = makeReadProvider({ balanceWei: 0n, maxFeePerGas: 1000n })
    expect(await estimateDustThresholdWei(provider)).toBe(
      BigInt(21000) * 1000n * 2n,
    )
  })

  it('falls back to legacy gasPrice when maxFeePerGas is unavailable', async () => {
    const provider = makeReadProvider({
      balanceWei: 0n,
      maxFeePerGas: null,
      gasPrice: 500n,
    })
    expect(await estimateDustThresholdWei(provider)).toBe(
      BigInt(21000) * 500n * 2n,
    )
  })

  it('throws when the provider reports neither fee field', async () => {
    const provider = makeReadProvider({
      balanceWei: 0n,
      maxFeePerGas: null,
      gasPrice: null,
    })
    await expect(estimateDustThresholdWei(provider)).rejects.toThrow(/neither/)
  })
})

describe('MonadChangePool', () => {
  function makePool() {
    return new MonadChangePool({
      keyring: MonadChangeKeyring.fromMnemonic(TEST_MNEMONIC),
    })
  }

  describe('peekNextChangeAddress / nextUnusedIndex', () => {
    it('starts at index 0, matching direct derivation', () => {
      const pool = makePool()
      const peek = pool.peekNextChangeAddress()
      expect(peek.index).toBe(0)
      expect(peek.address).toBe(
        MonadChangeKeyring.fromMnemonic(TEST_MNEMONIC).deriveChangeAccount(0)
          .address,
      )
      expect(pool.nextUnusedIndex()).toBe(0)
    })
  })

  describe('setNextUnusedIndex', () => {
    it('moves the pointer forward freely', () => {
      const pool = makePool()
      pool.setNextUnusedIndex(5)
      expect(pool.nextUnusedIndex()).toBe(5)
    })

    it('allows moving backward when no records exist locally (the recovery use case)', () => {
      const pool = makePool()
      pool.setNextUnusedIndex(5)
      pool.setNextUnusedIndex(2)
      expect(pool.nextUnusedIndex()).toBe(2)
    })

    it('refuses to rewind past existing records without force', async () => {
      const pool = makePool()
      const { signer } = makeBurnAccountSigner()
      const provider = makeReadProvider({
        balanceWei: BigInt(1_000_000),
        maxFeePerGas: 1n,
      })
      await pool.sweepToChange({
        burnIndex: 0,
        burnAddress: '0xburn',
        burnAccountSigner: signer,
        provider,
        overrides: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
      })
      expect(pool.nextUnusedIndex()).toBe(1)

      expect(() => pool.setNextUnusedIndex(0)).toThrow(/Refusing to rewind/)
      pool.setNextUnusedIndex(0, { force: true })
      expect(pool.nextUnusedIndex()).toBe(0)
    })

    it('rejects a negative or non-integer index', () => {
      const pool = makePool()
      expect(() => pool.setNextUnusedIndex(-1)).toThrow()
      expect(() => pool.setNextUnusedIndex(1.5)).toThrow()
    })
  })

  describe('sweepToChange', () => {
    it('skips the sweep when leftover balance is at or below the dust threshold', async () => {
      const pool = makePool()
      const { signer, httpClient } = makeBurnAccountSigner()
      // dust threshold = 21000 * 1 * 2 = 42000; balance exactly at it -> skipped.
      const provider = makeReadProvider({
        balanceWei: BigInt(42000),
        maxFeePerGas: 1n,
      })

      const outcome = await pool.sweepToChange({
        burnIndex: 3,
        burnAddress: '0xburn3',
        burnAccountSigner: signer,
        provider,
      })

      expect(outcome).toMatchObject({
        swept: false,
        reason: 'below-dust-threshold',
        balanceWei: BigInt(42000),
        dustThresholdWei: BigInt(42000),
      })
      expect(httpClient.submitRawTransaction).not.toHaveBeenCalled()
      expect(pool.nextUnusedIndex()).toBe(0) // pointer never advances on a skip
      expect(pool.records()).toEqual([])
    })

    it('sweeps leftover balance above the dust threshold to change index 0, then advances the pointer', async () => {
      const pool = makePool()
      const { signer, httpClient } = makeBurnAccountSigner()
      const dust = BigInt(21000) * 1n * 2n
      const balance = dust + BigInt(1_000_000)
      const provider = makeReadProvider({
        balanceWei: balance,
        maxFeePerGas: 1n,
      })

      const outcome = await pool.sweepToChange({
        burnIndex: 7,
        burnAddress: '0xburn7',
        burnAccountSigner: signer,
        provider,
        overrides: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
      })

      if (!outcome.swept) throw new Error('expected a successful sweep')
      expect(outcome.sweptValueWei).toBe(balance - dust)
      expect(outcome.record.index).toBe(0)
      expect(outcome.record.sourceBurnIndex).toBe(7)
      expect(outcome.record.sourceBurnAddress).toBe('0xburn7')
      expect(outcome.record.address).toBe(
        MonadChangeKeyring.fromMnemonic(TEST_MNEMONIC).deriveChangeAccount(0)
          .address,
      )
      expect(outcome.record.sweptValueWei).toBe((balance - dust).toString())
      expect(httpClient.submitRawTransaction).toHaveBeenCalledTimes(1)

      expect(pool.nextUnusedIndex()).toBe(1)
      expect(pool.records()).toHaveLength(1)
      expect(pool.getRecord(0)?.txHash).toBe(outcome.record.txHash)
    })

    it('allocates sequential change indices across repeated sweeps, never reusing one', async () => {
      const pool = makePool()
      const dust = BigInt(21000) * 1n * 2n
      const provider = makeReadProvider({
        balanceWei: dust + 100n,
        maxFeePerGas: 1n,
      })

      const overrides = { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }
      const first = await pool.sweepToChange({
        burnIndex: 1,
        burnAddress: '0xburnA',
        burnAccountSigner: makeBurnAccountSigner().signer,
        provider,
        overrides,
      })
      const second = await pool.sweepToChange({
        burnIndex: 2,
        burnAddress: '0xburnB',
        burnAccountSigner: makeBurnAccountSigner().signer,
        provider,
        overrides,
      })

      if (!first.swept || !second.swept)
        throw new Error('expected both sweeps to succeed')
      expect(first.record.index).toBe(0)
      expect(second.record.index).toBe(1)
      expect(second.record.address).not.toBe(first.record.address)
      expect(pool.nextUnusedIndex()).toBe(2)
    })

    it('an explicit dustThresholdWei override skips the fee-data read entirely', async () => {
      const pool = makePool()
      const { signer } = makeBurnAccountSigner()
      const provider = makeReadProvider({ balanceWei: BigInt(1000) })

      const outcome = await pool.sweepToChange({
        burnIndex: 0,
        burnAddress: '0xburn',
        burnAccountSigner: signer,
        provider,
        dustThresholdWei: BigInt(2000), // well above balance -> skip
      })

      expect(outcome).toMatchObject({
        swept: false,
        reason: 'below-dust-threshold',
      })
      expect(provider.getFeeData).not.toHaveBeenCalled()
    })

    it('journals an ambiguous submit without creating a seed-recovery gap', async () => {
      const pool = makePool()
      const { signer, httpClient } = makeBurnAccountSigner()
      httpClient.submitRawTransaction.mockRejectedValueOnce(
        new Error('relay down'),
      )
      const dust = BigInt(21000) * 1n * 2n
      const provider = makeReadProvider({
        balanceWei: dust + 1000n,
        maxFeePerGas: 1n,
      })

      await expect(
        pool.sweepToChange({
          burnIndex: 0,
          burnAddress: '0xburn',
          burnAccountSigner: signer,
          provider,
          overrides: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
        }),
      ).rejects.toThrow('relay down')

      expect(pool.nextUnusedIndex()).toBe(0)
      expect(pool.records()).toEqual([])
      expect(
        (
          pool as unknown as {
            store: InMemoryChangePoolStore
          }
        ).store.getPendingIntent(),
      ).toMatchObject({ index: 0, sourceBurnIndex: 0 })

      httpClient.getTransactionReceipt.mockResolvedValueOnce({
        status: 'success',
      } as never)
      const recovered = await pool.sweepToChange({
        burnIndex: 0,
        burnAddress: '0xburn',
        burnAccountSigner: signer,
        provider,
        overrides: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
      })
      expect(recovered.swept).toBe(true)
      expect(pool.nextUnusedIndex()).toBe(1)
      expect(pool.records()).toHaveLength(1)
      expect(httpClient.submitRawTransaction).toHaveBeenCalledTimes(1)
    })

    it(
      'does not advance the change pointer until the sweep receipt succeeds',
      async () => {
        const pool = makePool()
        const { signer, httpClient } = makeBurnAccountSigner()
        httpClient.getTransactionReceipt.mockResolvedValue(undefined)
        const dust = BigInt(21000) * 1n * 2n
        const provider = makeReadProvider({
          balanceWei: dust + 1000n,
          maxFeePerGas: 1n,
        })

        await expect(
          pool.sweepToChange({
            burnIndex: 0,
            burnAddress: '0xburn',
            burnAccountSigner: signer,
            provider,
            overrides: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
          }),
        ).resolves.toMatchObject({ swept: false, reason: 'sweep-pending' })
        expect(pool.nextUnusedIndex()).toBe(0)
        expect(pool.records()).toEqual([])

        httpClient.getTransactionReceipt.mockResolvedValue({
          status: 'success',
        } as never)
        await expect(
          pool.sweepToChange({
            burnIndex: 0,
            burnAddress: '0xburn',
            burnAccountSigner: signer,
            provider,
            overrides: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
          }),
        ).resolves.toMatchObject({ swept: true })
        expect(pool.nextUnusedIndex()).toBe(1)
        expect(pool.records()).toHaveLength(1)
      },
      15000,
    )
  })
})

describe('releaseLeaseAndSweepChange', () => {
  function makeLeaseSetup() {
    const burnKeyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC)
    const burnPool = new MonadSubAccountPool({ keyring: burnKeyring })
    burnPool.ensureSize(2)
    const manager = new SubAccountLeaseManager(burnPool)
    const changePool = new MonadChangePool({
      keyring: MonadChangeKeyring.fromMnemonic(TEST_MNEMONIC),
    })
    return { burnPool, manager, changePool }
  }

  it("sweeps the burn account's leftover balance to change when the outcome is 'confirmed' (status 'spent')", async () => {
    const { burnPool, manager, changePool } = makeLeaseSetup()
    const handle: AccountLeaseHandle = manager.acquireLease()
    const { signer, httpClient } = makeBurnAccountSigner()
    const dust = BigInt(21000) * 1n * 2n
    const provider = makeReadProvider({
      balanceWei: dust + 500n,
      maxFeePerGas: 1n,
    })

    const result = await releaseLeaseAndSweepChange({
      manager,
      handle,
      outcome: 'confirmed',
      sweep: {
        changePool,
        burnAccountSigner: signer,
        provider,
        overrides: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
      },
    })

    expect(result.record.status).toBe('spent')
    expect(result.sweep).toMatchObject({ swept: true, sweptValueWei: 500n })
    expect(httpClient.submitRawTransaction).toHaveBeenCalledTimes(1)
    expect(changePool.nextUnusedIndex()).toBe(1)
    expect(burnPool.getRecord(handle.index)?.status).toBe('spent')
  })

  it("does not attempt a sweep when the outcome is 'failed' (status 'retired')", async () => {
    const { manager, changePool } = makeLeaseSetup()
    const handle = manager.acquireLease()
    const { signer } = makeBurnAccountSigner()
    const provider = makeReadProvider({
      balanceWei: BigInt(1_000_000),
      maxFeePerGas: 1n,
    })

    const result = await releaseLeaseAndSweepChange({
      manager,
      handle,
      outcome: 'failed',
      sweep: { changePool, burnAccountSigner: signer, provider },
    })

    expect(result.record.status).toBe('retired')
    expect(result.sweep).toBeUndefined()
    expect(changePool.nextUnusedIndex()).toBe(0)
  })

  it('skips sweeping entirely (still releases the lease) when no sweep params are given', async () => {
    const { manager } = makeLeaseSetup()
    const handle = manager.acquireLease()

    const result = await releaseLeaseAndSweepChange({
      manager,
      handle,
      outcome: 'confirmed',
    })

    expect(result.record.status).toBe('spent')
    expect(result.sweep).toBeUndefined()
  })

  it('reports a sweep failure as { swept: false, reason: "sweep-error" } without throwing, leaving the already-successful release intact', async () => {
    const { burnPool, manager, changePool } = makeLeaseSetup()
    const handle = manager.acquireLease()
    const { signer, httpClient } = makeBurnAccountSigner()
    httpClient.submitRawTransaction.mockRejectedValueOnce(
      new Error('rpc exploded'),
    )
    const dust = BigInt(21000) * 1n * 2n
    const provider = makeReadProvider({
      balanceWei: dust + 500n,
      maxFeePerGas: 1n,
    })

    const result = await releaseLeaseAndSweepChange({
      manager,
      handle,
      outcome: 'confirmed',
      sweep: {
        changePool,
        burnAccountSigner: signer,
        provider,
        overrides: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
      },
    })

    expect(result.record.status).toBe('spent') // the release itself is unaffected
    expect(result.sweep).toMatchObject({ swept: false, reason: 'sweep-error' })
    expect((result.sweep as { error: unknown }).error).toBeInstanceOf(Error)
    expect(burnPool.getRecord(handle.index)?.status).toBe('spent')
  })
})

describe('awaitLeaseSettlementAndSweepChange', () => {
  function makeFakeClock() {
    let elapsed = 0
    return {
      now: () => elapsed,
      sleep: async (ms: number) => {
        elapsed += ms
      },
    }
  }

  function makeStatusSource(
    statuses: MonadTxStatus[],
  ): jest.Mocked<LeaseTxStatusSource> {
    let call = 0
    return {
      getStatus: jest.fn(async () => {
        const next = statuses[Math.min(call, statuses.length - 1)]
        call++
        return next
      }),
    }
  }

  it('sweeps once the polled settlement confirms', async () => {
    const burnKeyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC)
    const burnPool = new MonadSubAccountPool({ keyring: burnKeyring })
    burnPool.ensureSize(1)
    const manager = new SubAccountLeaseManager(burnPool)
    const handle = manager.acquireLease()
    const changePool = new MonadChangePool({
      keyring: MonadChangeKeyring.fromMnemonic(TEST_MNEMONIC),
    })
    const { signer, httpClient: sweepHttpClient } = makeBurnAccountSigner()
    const dust = BigInt(21000) * 1n * 2n
    const readProvider = makeReadProvider({
      balanceWei: dust + 999n,
      maxFeePerGas: 1n,
    })
    const { now, sleep } = makeFakeClock()

    const result = await awaitLeaseSettlementAndSweepChange({
      manager,
      handle,
      txHash: '0xsomehash',
      statusSource: makeStatusSource(['confirmed']),
      sweep: {
        changePool,
        burnAccountSigner: signer,
        provider: readProvider,
        overrides: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
      },
      now,
      sleep,
    })

    expect(result.outcome).toBe('confirmed')
    expect(result.record.status).toBe('spent')
    expect(result.sweep).toMatchObject({ swept: true, sweptValueWei: 999n })
    expect(sweepHttpClient.submitRawTransaction).toHaveBeenCalledTimes(1)
  })

  it("does not sweep on a 'stuck' settlement", async () => {
    const burnKeyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC)
    const burnPool = new MonadSubAccountPool({ keyring: burnKeyring })
    burnPool.ensureSize(1)
    const manager = new SubAccountLeaseManager(burnPool)
    const handle = manager.acquireLease()
    const changePool = new MonadChangePool({
      keyring: MonadChangeKeyring.fromMnemonic(TEST_MNEMONIC),
    })
    const { signer } = makeBurnAccountSigner()
    const readProvider = makeReadProvider({
      balanceWei: BigInt(1_000_000),
      maxFeePerGas: 1n,
    })
    const { now, sleep } = makeFakeClock()

    const result = await awaitLeaseSettlementAndSweepChange({
      manager,
      handle,
      txHash: '0xsomehash',
      statusSource: makeStatusSource(['pending']),
      sweep: { changePool, burnAccountSigner: signer, provider: readProvider },
      timeoutMs: 1,
      now,
      sleep,
    })

    expect(result.outcome).toBe('stuck')
    expect(result.record.status).toBe('retired')
    expect(result.sweep).toBeUndefined()
  })
})
