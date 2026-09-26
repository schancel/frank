/**
 * Standalone, manually-run proof for `monad-hd-keyring.ts` / `monad-account-pool.ts` /
 * `storage/*-sub-account-pool-*.ts`, in the same spirit as `monad-account-tx.livecheck.ts` (see
 * that file's header for why this isn't a jest test: `jest` isn't actually an installed dependency
 * in this app despite `jest.config.js`/`package.json` referring to it — same pre-existing gap,
 * confirmed again for this ticket by `ls node_modules/.bin/jest` finding nothing after a clean
 * `yarn install`). `monad-account-pool.jest.test.ts` covers the same scenarios (and more, with
 * proper mocking) and will run unmodified once jest is installed for real.
 *
 * No network access: `fanOutFundSubAccounts` here is driven by a `MonadAccountTxSigner` against a
 * stubbed `JsonRpcProvider._perform` (same technique as `monad-account-tx.jest.test.ts`), and the
 * `level` store checks use a real temp directory on disk (that's the whole point — proving
 * cross-"restart" persistence) but never touch the network.
 *
 * Usage (from `app/`):
 *   node_modules/.bin/tsc --module commonjs --target es2019 --esModuleInterop --resolveJsonModule \
 *     --outDir /tmp/monad-account-pool-livecheck src/cashweb/wallet/monad-http.ts \
 *     src/cashweb/wallet/monad-account-tx.ts src/cashweb/wallet/monad-hd-keyring.ts \
 *     src/cashweb/wallet/monad-account-pool.ts \
 *     src/cashweb/wallet/storage/sub-account-pool-storage.ts \
 *     src/cashweb/wallet/storage/level-sub-account-pool-store.ts \
 *     src/cashweb/wallet/monad-account-pool.livecheck.ts
 *   node /tmp/monad-account-pool-livecheck/monad-account-pool.livecheck.js
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { JsonRpcProvider, Wallet } from 'ethers'

import { MonadHdKeyring, subAccountPath } from './monad-hd-keyring'
import {
  fanOutFundSubAccounts,
  MonadSubAccountPool,
} from './monad-account-pool'
import { MonadAccountTxSigner, MonadTxSubmitter } from './monad-account-tx'
import { LevelSubAccountPoolStore } from './storage/level-sub-account-pool-store'
import { InMemorySubAccountPoolStore } from './storage/sub-account-pool-storage'

function assertEqual(actual: unknown, expected: unknown, label: string) {
  const a = typeof actual === 'bigint' ? actual.toString() : actual
  const e = typeof expected === 'bigint' ? expected.toString() : expected
  if (a !== e) {
    throw new Error(
      `${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`,
    )
  }
  console.log(`  OK  ${label} = ${JSON.stringify(e)}`)
}

function assertTrue(condition: boolean, label: string) {
  if (!condition) throw new Error(`${label}: expected true`)
  console.log(`  OK  ${label}`)
}

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

function makeNoopHttpClient(): MonadTxSubmitter {
  const submitted: string[] = []
  return {
    async submitRawTransaction(rawTxHex: string) {
      submitted.push(rawTxHex)
      // Echo back the hash the caller expects (see monad-account-tx.ts's submit() cross-check) —
      // computed the same way MonadAccountTxSigner.submit expects: the caller compares to its own
      // pre-computed hash, so simplest correct stub is to reflect it back. We don't have it here
      // without re-parsing, so just re-derive via ethers.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Transaction } = require('ethers')
      return Transaction.from(rawTxHex).hash
    },
    async getTransactionReceipt() {
      return undefined
    },
  }
}

async function checkDerivationDeterminism() {
  console.log('\n== Derivation determinism ==')
  const mnemonic = 'test test test test test test test test test test test junk'
  const keyringA = MonadHdKeyring.fromMnemonic(mnemonic)
  const keyringB = MonadHdKeyring.fromMnemonic(mnemonic)

  const a0 = keyringA.deriveSubAccount(0)
  const b0 = keyringB.deriveSubAccount(0)
  assertEqual(a0.address, b0.address, 'same mnemonic + index 0 -> same address')
  assertEqual(
    a0.privateKey,
    b0.privateKey,
    'same mnemonic + index 0 -> same private key',
  )

  const a1 = keyringA.deriveSubAccount(1)
  assertTrue(
    a1.address !== a0.address,
    'index 0 vs index 1 -> different address',
  )

  assertEqual(subAccountPath(3), "m/44'/60'/0'/0/3", 'subAccountPath(3)')

  const { keyring: randomKeyring, mnemonic: generated } =
    MonadHdKeyring.generate()
  assertTrue(
    generated.split(' ').length === 12,
    'generate() -> 12-word mnemonic',
  )
  const g0a = randomKeyring.deriveSubAccount(0)
  const g0b = MonadHdKeyring.fromMnemonic(generated).deriveSubAccount(0)
  assertEqual(
    g0a.address,
    g0b.address,
    'generated mnemonic round-trips through fromMnemonic',
  )

  let threw = false
  try {
    MonadHdKeyring.fromMnemonic('not a valid mnemonic at all')
  } catch {
    threw = true
  }
  assertTrue(threw, 'fromMnemonic rejects an invalid mnemonic')
}

async function checkPoolSizingAndSelection() {
  console.log('\n== Pool sizing + per-stamp selection/rotation ==')
  const mnemonic = 'test test test test test test test test test test test junk'
  const keyring = MonadHdKeyring.fromMnemonic(mnemonic)
  const pool = new MonadSubAccountPool({
    keyring,
    store: new InMemorySubAccountPoolStore(),
  })

  const records = pool.ensureSize(4)
  assertEqual(records.length, 4, 'ensureSize(4) -> 4 records')
  assertTrue(
    records.every(r => r.status === 'available'),
    'all newly-derived records start "available"',
  )
  assertEqual(
    records[2].address,
    keyring.deriveSubAccount(2).address,
    'pool record address matches direct derivation for the same index',
  )

  // Idempotent: calling again with the same size doesn't disturb existing records' status.
  pool.setStatus(1, 'in-use')
  pool.setStatus(2, 'retired')
  pool.ensureSize(4)
  assertEqual(
    pool.getRecord(1)?.status,
    'in-use',
    'ensureSize does not reset an in-use record',
  )
  assertEqual(
    pool.getRecord(2)?.status,
    'retired',
    'ensureSize does not reset a retired record',
  )

  // Growing the pool leaves existing records alone and adds new ones.
  pool.ensureSize(6)
  assertEqual(pool.records().length, 6, 'ensureSize(6) grows the pool to 6')
  assertEqual(
    pool.getRecord(5)?.status,
    'available',
    'newly-added index 5 is available',
  )

  // Selection: only indices 0, 3, 4, 5 are 'available' (1 is in-use, 2 is retired). Rotation
  // should visit exactly that set, in order, indefinitely wrapping, and never mutate status.
  const selections: number[] = []
  for (let i = 0; i < 8; i++) {
    const chosen = pool.selectForStamp()
    if (chosen === undefined) throw new Error('expected a selection')
    selections.push(chosen.index)
  }
  assertEqual(
    JSON.stringify(selections),
    JSON.stringify([0, 3, 4, 5, 0, 3, 4, 5]),
    'selectForStamp() round-robins over available accounts only, skipping in-use/retired',
  )
  assertEqual(
    pool.getRecord(1)?.status,
    'in-use',
    'selectForStamp never mutates status (in-use)',
  )
  assertEqual(
    pool.getRecord(2)?.status,
    'retired',
    'selectForStamp never mutates status (retired)',
  )

  // Exhaustion: if nothing is available, selection returns undefined rather than throwing.
  const emptyPool = new MonadSubAccountPool({ keyring })
  emptyPool.ensureSize(2)
  emptyPool.setStatus(0, 'retired')
  emptyPool.setStatus(1, 'retired')
  assertEqual(
    emptyPool.selectForStamp(),
    undefined,
    'selectForStamp() returns undefined when nothing is available',
  )
}

async function checkFanOutFunding() {
  console.log('\n== Fan-out funding: burnValue/gasReserve kept separate ==')
  // Real, randomly-generated key, never funded, never used anywhere else — generated fresh here
  // (rather than a hardcoded literal) to sidestep any risk of an accidentally-mistyped/truncated
  // hex literal going unnoticed, the way `monad-account-tx.jest.test.ts`'s own `TEST_PRIVATE_KEY`
  // constant turned out to be truncated to 63 hex chars (discovered while writing this livecheck,
  // since that jest file has never actually been executed — see this file's header) — flagged in
  // this ticket's handoff for ticket #11 to fix, not fixed here (out of this ticket's scope).
  const mainPrivateKey = Wallet.createRandom().privateKey
  let nonce = 100
  const provider = makeStubProvider(async req => {
    if (req.method === 'getTransactionCount')
      return `0x${(nonce++).toString(16)}`
    if (req.method === 'estimateGas') return '0x5208'
    throw new Error(`unexpected _perform: ${req.method}`)
  })
  const mainAccountSigner = new MonadAccountTxSigner({
    privateKey: mainPrivateKey,
    provider,
    httpClient: makeNoopHttpClient(),
  })

  const mnemonic = 'test test test test test test test test test test test junk'
  const keyring = MonadHdKeyring.fromMnemonic(mnemonic)
  const pool = new MonadSubAccountPool({ keyring })
  const records = pool.ensureSize(3)

  const burnValue = 1_000_000_000_000_000n // 0.001 MON
  const gasReserve = 200_000_000_000_000n // 0.0002 MON
  const results = await fanOutFundSubAccounts({
    mainAccountSigner,
    targets: records,
    burnValue,
    gasReserve,
    overrides: {
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    },
  })

  assertEqual(results.length, 3, 'fanOutFundSubAccounts funds every target')
  for (const [i, result] of results.entries()) {
    assertEqual(
      result.address,
      records[i].address,
      `result[${i}].address matches target`,
    )
    assertEqual(
      result.fundedValue,
      burnValue + gasReserve,
      `result[${i}].fundedValue == burnValue + gasReserve`,
    )
    assertEqual(
      result.signedTx.value,
      burnValue + gasReserve,
      `result[${i}] signed tx's on-chain value == burnValue + gasReserve`,
    )
  }
  // Distinct, monotonically-increasing nonces prove the sends were sequenced (not raced) against
  // the fresh-nonce-per-call chain read.
  const nonces = results.map(r => r.signedTx.nonce)
  assertEqual(
    JSON.stringify(nonces),
    JSON.stringify([100, 101, 102]),
    'sequential distinct nonces across the fan-out',
  )

  let threw = false
  try {
    await fanOutFundSubAccounts({
      mainAccountSigner,
      targets: records,
      burnValue: -1n,
      gasReserve: 0n,
    })
  } catch {
    threw = true
  }
  assertTrue(threw, 'fanOutFundSubAccounts rejects a negative burnValue')
}

async function checkLevelStorePersistsAcrossRestart() {
  console.log(
    '\n== LevelSubAccountPoolStore persists across a simulated restart ==',
  )
  const dir = mkdtempSync(join(tmpdir(), 'sub-account-pool-'))
  try {
    const mnemonic =
      'test test test test test test test test test test test junk'
    const keyring = MonadHdKeyring.fromMnemonic(mnemonic)

    const storeA = new LevelSubAccountPoolStore(dir)
    await storeA.Open()
    const poolA = new MonadSubAccountPool({ keyring, store: storeA })
    poolA.ensureSize(3)
    poolA.setStatus(1, 'in-use')
    await storeA.Close()

    // Simulate an app restart: fresh store instance pointed at the same directory.
    const storeB = new LevelSubAccountPoolStore(dir)
    await storeB.Open()
    const poolB = new MonadSubAccountPool({ keyring, store: storeB })
    const recordsB = poolB.records()
    assertEqual(
      recordsB.length,
      3,
      'reopened store has all 3 previously-derived records',
    )
    assertEqual(
      poolB.getRecord(1)?.status,
      'in-use',
      'reopened store preserves status set before "restart"',
    )
    assertEqual(
      poolB.getRecord(0)?.address,
      keyring.deriveSubAccount(0).address,
      'reopened store address still matches deterministic re-derivation',
    )
    await storeB.Close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function main() {
  await checkDerivationDeterminism()
  await checkPoolSizingAndSelection()
  await checkFanOutFunding()
  await checkLevelStorePersistsAcrossRestart()
  console.log('\nAll monad-account-pool livecheck assertions passed.')
}

main().catch(err => {
  console.error('\nLIVECHECK FAILED:', err)
  process.exit(1)
})
