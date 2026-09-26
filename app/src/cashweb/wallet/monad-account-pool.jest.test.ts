/**
 * Unit tests for `monad-hd-keyring.ts` and `monad-account-pool.ts`, against a mocked ethers
 * `Provider` (for the fan-out funding scenarios' nonce/gas reads) and a mocked `MonadTxSubmitter`.
 *
 * NOT CURRENTLY RUN: same pre-existing gap `monad-account-tx.jest.test.ts` documents — this repo's
 * `jest.config.js`/`package.json` reference `jest`, but `jest` (and `ts-jest`, `@types/jest`, and
 * in fact the whole `@quasar/quasar-app-extension-testing-unit-jest` set of packages
 * `jest.config.js` assumes — `vue-jest`, `jest-serializer-vue`, `jest-transform-stub`, ... — none
 * of it) are not actually installed, confirmed again for this ticket by `ls node_modules/.bin/jest`
 * finding nothing after a clean `yarn install`. Fixing that properly means running the Quasar CLI's
 * `quasar ext add @quasar/testing-unit-jest` (or manually adding the whole package set) and
 * touching `app/package.json` — both out of this ticket's file-ownership scope (edits restricted to
 * `app/src/cashweb/wallet/`). This file follows `jest.config.js`'s own `testMatch` convention
 * (`src/**\/*.jest.(spec|test).ts`) so it will be picked up automatically, unmodified, the moment
 * that infra is fixed (tracked as a real follow-up per `PLAN.md`'s relaxed-timeline note, not a
 * stretch goal). Until then:
 *   - `describe`/`it`/`expect`/`jest` below are untyped/unrun; same `env: { jest: true }`
 *     eslint carve-out `monad-account-tx.jest.test.ts` relies on applies here.
 *   - Every scenario here is also exercised for real, right now, without jest, by
 *     `monad-account-pool.livecheck.ts` in this same directory (run via `tsc`+`node`) — see that
 *     file's header for how to run it; it was run for this handoff and all assertions passed.
 */
import { JsonRpcProvider, Transaction, Wallet } from 'ethers'

import { MonadHdKeyring, subAccountPath } from './monad-hd-keyring'
import {
  fanOutFundSubAccounts,
  MonadSubAccountPool,
} from './monad-account-pool'
import { MonadAccountTxSigner, MonadTxSubmitter } from './monad-account-tx'
import { LevelSubAccountPoolStore } from './storage/level-sub-account-pool-store'
import { InMemorySubAccountPoolStore } from './storage/sub-account-pool-storage'

const TEST_MNEMONIC =
  'test test test test test test test test test test test junk'
const CHAIN_ID = 10143 // Monad testnet's chain ID; only a realistic stand-in here.

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
    getTransactionReceipt: jest.fn(),
  }
}

describe('MonadHdKeyring', () => {
  it('derives the same address/private key from the same mnemonic + index (deterministic)', () => {
    const a = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC).deriveSubAccount(0)
    const b = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC).deriveSubAccount(0)
    expect(a.address).toBe(b.address)
    expect(a.privateKey).toBe(b.privateKey)
  })

  it('derives different keypairs for different indices from the same mnemonic', () => {
    const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC)
    const a0 = keyring.deriveSubAccount(0)
    const a1 = keyring.deriveSubAccount(1)
    expect(a0.address).not.toBe(a1.address)
    expect(a0.privateKey).not.toBe(a1.privateKey)
  })

  it('builds the expected BIP-44 path for a given index', () => {
    expect(subAccountPath(0)).toBe("m/44'/60'/0'/0/0")
    expect(subAccountPath(7)).toBe("m/44'/60'/0'/0/7")
  })

  it('rejects a negative or non-integer index', () => {
    const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC)
    expect(() => keyring.deriveSubAccount(-1)).toThrow()
    expect(() => keyring.deriveSubAccount(1.5)).toThrow()
  })

  it('generate() produces a fresh, valid mnemonic that round-trips through fromMnemonic', () => {
    const { keyring, mnemonic } = MonadHdKeyring.generate()
    expect(mnemonic.split(' ')).toHaveLength(12)
    const rebuilt = MonadHdKeyring.fromMnemonic(mnemonic)
    expect(keyring.deriveSubAccount(0).address).toBe(
      rebuilt.deriveSubAccount(0).address,
    )
  })

  it('rejects an invalid mnemonic', () => {
    expect(() => MonadHdKeyring.fromMnemonic('not a real mnemonic')).toThrow(
      /invalid.*mnemonic/i,
    )
  })
})

describe('MonadSubAccountPool', () => {
  describe('ensureSize', () => {
    it('derives and persists sub-accounts as "available" up to the requested size', () => {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC)
      const pool = new MonadSubAccountPool({ keyring })
      const records = pool.ensureSize(3)

      expect(records).toHaveLength(3)
      expect(records.map(r => r.index)).toEqual([0, 1, 2])
      expect(records.every(r => r.status === 'available')).toBe(true)
      expect(records[1].address).toBe(keyring.deriveSubAccount(1).address)
    })

    it('is idempotent: re-calling with the same size does not reset existing status', () => {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC)
      const pool = new MonadSubAccountPool({ keyring })
      pool.ensureSize(2)
      pool.setStatus(0, 'in-use')
      pool.setStatus(1, 'retired')

      pool.ensureSize(2)

      expect(pool.getRecord(0)?.status).toBe('in-use')
      expect(pool.getRecord(1)?.status).toBe('retired')
    })

    it('growing the pool leaves existing records untouched and adds new "available" ones', () => {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC)
      const pool = new MonadSubAccountPool({ keyring })
      pool.ensureSize(2)
      pool.setStatus(0, 'in-use')

      const records = pool.ensureSize(4)

      expect(records).toHaveLength(4)
      expect(pool.getRecord(0)?.status).toBe('in-use')
      expect(pool.getRecord(3)?.status).toBe('available')
    })

    it('rejects a negative size', () => {
      const pool = new MonadSubAccountPool({
        keyring: MonadHdKeyring.fromMnemonic(TEST_MNEMONIC),
      })
      expect(() => pool.ensureSize(-1)).toThrow()
    })
  })

  describe('selectForStamp (per-stamp rotation)', () => {
    it('round-robins over available accounts, skipping in-use and retired ones', () => {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC)
      const pool = new MonadSubAccountPool({ keyring })
      pool.ensureSize(4)
      pool.setStatus(1, 'in-use')
      pool.setStatus(2, 'retired')
      // Available: 0, 3

      const selections = Array.from(
        { length: 5 },
        () => pool.selectForStamp()?.index,
      )

      expect(selections).toEqual([0, 3, 0, 3, 0])
    })

    it('never mutates the selected record’s status', () => {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC)
      const pool = new MonadSubAccountPool({ keyring })
      pool.ensureSize(2)

      pool.selectForStamp()

      expect(pool.records().every(r => r.status === 'available')).toBe(true)
    })

    it('returns undefined when no account is available', () => {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC)
      const pool = new MonadSubAccountPool({ keyring })
      pool.ensureSize(2)
      pool.setStatus(0, 'retired')
      pool.setStatus(1, 'retired')

      expect(pool.selectForStamp()).toBeUndefined()
    })

    it('returns undefined for an empty pool', () => {
      const pool = new MonadSubAccountPool({
        keyring: MonadHdKeyring.fromMnemonic(TEST_MNEMONIC),
      })
      expect(pool.selectForStamp()).toBeUndefined()
    })

    it('resumes rotation after the previously-selected index rather than restarting at 0', () => {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC)
      const pool = new MonadSubAccountPool({ keyring })
      pool.ensureSize(3)

      expect(pool.selectForStamp()?.index).toBe(0)
      expect(pool.selectForStamp()?.index).toBe(1)
      // Newly retiring index 2 after it's already been passed shouldn't affect 0/1 rotation order.
      pool.setStatus(2, 'retired')
      expect(pool.selectForStamp()?.index).toBe(0)
    })
  })

  describe('getSigner', () => {
    it('returns a MonadAccountTxSigner for the re-derived private key at that index', () => {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC)
      const pool = new MonadSubAccountPool({ keyring })
      pool.ensureSize(1)

      const provider = makeStubProvider(async () => {
        throw new Error('no chain reads expected')
      })
      const signer = pool.getSigner(0, {
        provider,
        httpClient: makeMockHttpClient(),
      })

      expect(signer.address.toLowerCase()).toBe(
        keyring.deriveSubAccount(0).address.toLowerCase(),
      )
    })

    it('throws for an index the pool was never sized to include', () => {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC)
      const pool = new MonadSubAccountPool({ keyring })
      pool.ensureSize(1)

      expect(() =>
        pool.getSigner(5, {
          provider: makeStubProvider(async () => {
            throw new Error('unused')
          }),
          httpClient: makeMockHttpClient(),
        }),
      ).toThrow(/No sub-account at index 5/)
    })
  })

  describe('setStatus', () => {
    it('throws for an unknown index', () => {
      const pool = new MonadSubAccountPool({
        keyring: MonadHdKeyring.fromMnemonic(TEST_MNEMONIC),
      })
      pool.ensureSize(1)
      expect(() => pool.setStatus(9, 'retired')).toThrow(
        /No sub-account at index 9/,
      )
    })
  })
})

describe('fanOutFundSubAccounts', () => {
  async function makeMainAccountSigner(nonceStart = 0) {
    let nonce = nonceStart
    const httpClient = makeMockHttpClient()
    const provider = makeStubProvider(async req => {
      if (req.method === 'getTransactionCount')
        return `0x${(nonce++).toString(16)}`
      if (req.method === 'estimateGas') return '0x5208'
      throw new Error(`unexpected _perform: ${req.method}`)
    })
    const signer = new MonadAccountTxSigner({
      privateKey: Wallet.createRandom().privateKey,
      provider,
      httpClient,
    })
    return { signer, httpClient }
  }

  it('funds each target with burnValue + gasReserve, kept separate as explicit parameters', async () => {
    const { signer } = await makeMainAccountSigner()
    const targets = [
      { index: 0, address: '0x000000000000000000000000000000000000dEa0' },
      { index: 1, address: '0x000000000000000000000000000000000000dEa1' },
    ]
    const burnValue = 1_000_000_000_000_000n
    const gasReserve = 250_000_000_000_000n

    const results = await fanOutFundSubAccounts({
      mainAccountSigner: signer,
      targets,
      burnValue,
      gasReserve,
      overrides: {
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      },
    })

    expect(results).toHaveLength(2)
    for (const [i, result] of results.entries()) {
      expect(result.address).toBe(targets[i].address)
      expect(result.fundedValue).toBe(burnValue + gasReserve)
      expect(result.signedTx.value).toBe(burnValue + gasReserve)
      expect(result.signedTx.to.toLowerCase()).toBe(
        targets[i].address.toLowerCase(),
      )
    }
  })

  it('uses distinct, sequential nonces across the fan-out (no racing the same main account)', async () => {
    const { signer } = await makeMainAccountSigner(5)
    const targets = [
      { index: 0, address: '0x000000000000000000000000000000000000dEa0' },
      { index: 1, address: '0x000000000000000000000000000000000000dEa1' },
      { index: 2, address: '0x000000000000000000000000000000000000dEa2' },
    ]

    const results = await fanOutFundSubAccounts({
      mainAccountSigner: signer,
      targets,
      burnValue: 1n,
      gasReserve: 1n,
      overrides: {
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
      },
    })

    expect(results.map(r => r.signedTx.nonce)).toEqual([5, 6, 7])
  })

  it('submits every built transaction through the main account signer', async () => {
    const { signer, httpClient } = await makeMainAccountSigner()
    const targets = [
      { index: 0, address: '0x000000000000000000000000000000000000dEa0' },
    ]

    await fanOutFundSubAccounts({
      mainAccountSigner: signer,
      targets,
      burnValue: 10n,
      gasReserve: 5n,
      overrides: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
    })

    expect(httpClient.submitRawTransaction).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['burnValue', { burnValue: -1n, gasReserve: 0n }],
    ['gasReserve', { burnValue: 0n, gasReserve: -1n }],
  ])('rejects a negative %s', async (_label, amounts) => {
    const { signer } = await makeMainAccountSigner()
    await expect(
      fanOutFundSubAccounts({
        mainAccountSigner: signer,
        targets: [
          { index: 0, address: '0x000000000000000000000000000000000000dEa0' },
        ],
        ...amounts,
      }),
    ).rejects.toThrow(/must be >= 0/)
  })

  it('funds zero targets without error when given an empty list', async () => {
    const { signer } = await makeMainAccountSigner()
    const results = await fanOutFundSubAccounts({
      mainAccountSigner: signer,
      targets: [],
      burnValue: 1n,
      gasReserve: 1n,
    })
    expect(results).toEqual([])
  })
})

describe('MonadSubAccountPool.fundAll', () => {
  it('funds only the "available" records by default, using fanOutFundSubAccounts under the hood', async () => {
    const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC)
    const pool = new MonadSubAccountPool({ keyring })
    pool.ensureSize(3)
    pool.setStatus(1, 'in-use')

    let nonce = 0
    const httpClient = makeMockHttpClient()
    const provider = makeStubProvider(async req => {
      if (req.method === 'getTransactionCount')
        return `0x${(nonce++).toString(16)}`
      if (req.method === 'estimateGas') return '0x5208'
      throw new Error(`unexpected _perform: ${req.method}`)
    })
    const mainAccountSigner = new MonadAccountTxSigner({
      privateKey: Wallet.createRandom().privateKey,
      provider,
      httpClient,
    })

    const results = await pool.fundAll({
      mainAccountSigner,
      burnValue: 100n,
      gasReserve: 20n,
      overrides: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
    })

    expect(results.map(r => r.index)).toEqual([0, 2]) // index 1 is in-use, skipped
    expect(results.every(r => r.fundedValue === 120n)).toBe(true)
  })
})

describe('InMemorySubAccountPoolStore / LevelSubAccountPoolStore', () => {
  it('InMemorySubAccountPoolStore returns records sorted by index', () => {
    const store = new InMemorySubAccountPoolStore()
    store.put({ index: 2, address: '0xabc', status: 'available' })
    store.put({ index: 0, address: '0xdef', status: 'available' })
    expect(store.getAll().map(r => r.index)).toEqual([0, 2])
  })

  it('LevelSubAccountPoolStore persists pool state across a simulated app restart', async () => {
    const os = await import('os')
    const path = await import('path')
    const fs = await import('fs')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-account-pool-test-'))
    try {
      const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC)

      const storeA = new LevelSubAccountPoolStore(dir)
      await storeA.Open()
      const poolA = new MonadSubAccountPool({ keyring, store: storeA })
      poolA.ensureSize(2)
      poolA.setStatus(1, 'in-use')
      await storeA.Close()

      const storeB = new LevelSubAccountPoolStore(dir)
      await storeB.Open()
      const poolB = new MonadSubAccountPool({ keyring, store: storeB })

      expect(poolB.records()).toHaveLength(2)
      expect(poolB.getRecord(1)?.status).toBe('in-use')
      expect(poolB.getRecord(0)?.address).toBe(
        keyring.deriveSubAccount(0).address,
      )
      await storeB.Close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
