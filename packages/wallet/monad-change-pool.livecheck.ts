/**
 * Standalone, manually-run proof for `monad-change-keyring.ts` / `monad-change-pool.ts` /
 * `storage/*-change-pool-*.ts` (ticket #36), in the same spirit as
 * `monad-account-pool.livecheck.ts` (see that file's header for the convention this follows).
 * `monad-change-pool.jest.test.ts` covers the same scenarios
 * (and more, with proper mocking) via jest, which -- unlike when the #14/#34 livechecks were first
 * written -- is now actually installed and passing in this repo (`yarn test:unit:ci`); this
 * livecheck is kept anyway, matching the established convention, as an independent, jest-free
 * proof that doesn't depend on the test runner's own mocking machinery being right.
 *
 * No network access: sweeps are driven by a `MonadAccountTxSigner` against a stubbed
 * `JsonRpcProvider._perform` (same technique `monad-account-pool.livecheck.ts` uses), and the
 * `level` store checks use a real temp directory on disk (proving cross-"restart" persistence,
 * never touching the network).
 *
 * Usage (from `app/`):
 *   node_modules/.bin/tsc --module commonjs --target es2020 --esModuleInterop --resolveJsonModule \
 *     --outDir /tmp/monad-change-pool-livecheck src/cashweb/wallet/monad-http.ts \
 *     src/cashweb/wallet/monad-account-tx.ts src/cashweb/wallet/monad-hd-keyring.ts \
 *     src/cashweb/wallet/monad-account-pool.ts src/cashweb/wallet/monad-account-lease.ts \
 *     src/cashweb/wallet/monad-change-keyring.ts src/cashweb/wallet/monad-change-pool.ts \
 *     src/cashweb/wallet/storage/sub-account-pool-storage.ts \
 *     src/cashweb/wallet/storage/level-sub-account-pool-store.ts \
 *     src/cashweb/wallet/storage/change-pool-storage.ts \
 *     src/cashweb/wallet/storage/level-change-pool-store.ts \
 *     src/cashweb/wallet/monad-change-pool.livecheck.ts
 *   NODE_PATH="$(pwd)/node_modules" node /tmp/monad-change-pool-livecheck/monad-change-pool.livecheck.js
 * (`--target es2020` rather than the `es2019` this app's own `tsconfig.json` uses: this file's
 * bigint literals need ES2020, the same reason `tsconfig.jest.json` overrides the target for
 * jest -- see that file's own comment. `NODE_PATH` is needed since the compiled output lands
 * outside `app/`, where plain `node`'s module resolution wouldn't otherwise find `node_modules`.)
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { JsonRpcProvider, Provider, Transaction, Wallet } from 'ethers'

import { changeAccountPath, MonadChangeKeyring } from './monad-change-keyring'
import {
  estimateDustThresholdWei,
  MonadChangePool,
  releaseLeaseAndSweepChange,
} from './monad-change-pool'
import { MonadHdKeyring } from './monad-hd-keyring'
import { MonadSubAccountPool } from './monad-account-pool'
import { SubAccountLeaseManager } from './monad-account-lease'
import { MonadAccountTxSigner, MonadTxSubmitter } from './monad-account-tx'
import { LevelChangePoolStore } from './storage/level-change-pool-store'
import { InMemoryChangePoolStore } from './storage/change-pool-storage'

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
const TEST_MNEMONIC =
  'test test test test test test test test test test test junk'

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
  return {
    async submitRawTransaction(rawTxHex: string) {
      return Transaction.from(rawTxHex).hash
    },
    async getTransactionReceipt() {
      return undefined
    },
  }
}

function makeBurnAccountSigner() {
  let nonce = 0
  const provider = makeStubProvider(async req => {
    if (req.method === 'getTransactionCount')
      return `0x${(nonce++).toString(16)}`
    if (req.method === 'estimateGas') return '0x5208'
    throw new Error(`unexpected _perform: ${req.method}`)
  })
  return new MonadAccountTxSigner({
    privateKey: Wallet.createRandom().privateKey,
    provider,
    httpClient: makeNoopHttpClient(),
  })
}

function makeReadProvider(balanceWei: bigint, maxFeePerGas = 1n): Provider {
  return {
    async getBalance() {
      return balanceWei
    },
    async getFeeData() {
      return { maxFeePerGas, gasPrice: null, maxPriorityFeePerGas: null }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as Provider
}

async function checkDerivationDeterminismAndBranchSeparation() {
  console.log(
    '\n== Change-keyring derivation: deterministic, branch-1, distinct from burn branch-0 ==',
  )
  const changeA = MonadChangeKeyring.fromMnemonic(TEST_MNEMONIC)
  const changeB = MonadChangeKeyring.fromMnemonic(TEST_MNEMONIC)
  const burn = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC)

  assertEqual(
    changeA.deriveChangeAccount(0).address,
    changeB.deriveChangeAccount(0).address,
    'same mnemonic + index 0 -> same change address',
  )
  assertTrue(
    changeA.deriveChangeAccount(0).address !== burn.deriveSubAccount(0).address,
    'change branch-1 index 0 differs from burn branch-0 index 0',
  )
  assertEqual(changeAccountPath(3), "m/44'/60'/0'/1/3", 'changeAccountPath(3)')
}

async function checkDustThreshold() {
  console.log('\n== Dust threshold estimation ==')
  const provider = makeReadProvider(0n, 1000n)
  const threshold = await estimateDustThresholdWei(provider)
  assertEqual(
    threshold,
    BigInt(21000) * 1000n * 2n,
    'estimateDustThresholdWei (EIP-1559 path)',
  )
}

async function checkSweepAndSequentialAllocation() {
  console.log(
    '\n== sweepToChange: dust skip, real sweep, sequential allocation ==',
  )
  const pool = new MonadChangePool({
    keyring: MonadChangeKeyring.fromMnemonic(TEST_MNEMONIC),
  })
  const dust = BigInt(21000) * 1n * 2n

  const skipped = await pool.sweepToChange({
    burnIndex: 0,
    burnAddress: '0xdeadbeef',
    burnAccountSigner: makeBurnAccountSigner(),
    provider: makeReadProvider(dust), // exactly at threshold -> skip
  })
  assertTrue(!skipped.swept, 'balance at dust threshold is skipped, not swept')
  assertEqual(
    pool.nextUnusedIndex(),
    0,
    'pointer unchanged after a skipped sweep',
  )

  const overrides = { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }
  const first = await pool.sweepToChange({
    burnIndex: 5,
    burnAddress: '0xburn5',
    burnAccountSigner: makeBurnAccountSigner(),
    provider: makeReadProvider(dust + 1_000_000n),
    overrides,
  })
  if (!first.swept) throw new Error('expected first sweep to succeed')
  assertEqual(first.record.index, 0, 'first real sweep lands on change index 0')
  assertEqual(
    first.sweptValueWei,
    1_000_000n,
    'swept value = balance - dust threshold',
  )
  assertEqual(
    pool.nextUnusedIndex(),
    1,
    'pointer advances to 1 after first sweep',
  )

  const second = await pool.sweepToChange({
    burnIndex: 6,
    burnAddress: '0xburn6',
    burnAccountSigner: makeBurnAccountSigner(),
    provider: makeReadProvider(dust + 2_000_000n),
    overrides,
  })
  if (!second.swept) throw new Error('expected second sweep to succeed')
  assertEqual(
    second.record.index,
    1,
    'second real sweep lands on change index 1 (never reuses 0)',
  )
  assertEqual(pool.records().length, 2, 'both sweeps recorded')
}

async function checkLeaseReleaseWiring() {
  console.log(
    '\n== releaseLeaseAndSweepChange: wired to the burn pool lease-release "spent" outcome ==',
  )
  const burnKeyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC)
  const burnPool = new MonadSubAccountPool({ keyring: burnKeyring })
  burnPool.ensureSize(2)
  const manager = new SubAccountLeaseManager(burnPool)
  const changePool = new MonadChangePool({
    keyring: MonadChangeKeyring.fromMnemonic(TEST_MNEMONIC),
  })
  const dust = BigInt(21000) * 1n * 2n

  const confirmedHandle = manager.acquireLease()
  const confirmedResult = await releaseLeaseAndSweepChange({
    manager,
    handle: confirmedHandle,
    outcome: 'confirmed',
    sweep: {
      changePool,
      burnAccountSigner: makeBurnAccountSigner(),
      provider: makeReadProvider(dust + 42n),
      overrides: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
    },
  })
  assertEqual(
    confirmedResult.record.status,
    'spent',
    "'confirmed' outcome -> burn account 'spent'",
  )
  assertTrue(
    confirmedResult.sweep !== undefined && confirmedResult.sweep.swept === true,
    "'spent' burn account triggers a real sweep",
  )
  assertEqual(
    changePool.nextUnusedIndex(),
    1,
    'change pointer advanced by the wired sweep',
  )

  const failedHandle = manager.acquireLease()
  const failedResult = await releaseLeaseAndSweepChange({
    manager,
    handle: failedHandle,
    outcome: 'failed',
    sweep: {
      changePool,
      burnAccountSigner: makeBurnAccountSigner(),
      provider: makeReadProvider(dust + 42n),
    },
  })
  assertEqual(
    failedResult.record.status,
    'retired',
    "'failed' outcome -> burn account 'retired'",
  )
  assertTrue(
    failedResult.sweep === undefined,
    "'retired' burn account is never swept",
  )
  assertEqual(
    changePool.nextUnusedIndex(),
    1,
    "pointer untouched by a 'retired' release",
  )
}

async function checkLevelStorePersistsAcrossRestart() {
  console.log(
    '\n== LevelChangePoolStore persists across a simulated restart ==',
  )
  const dir = mkdtempSync(join(tmpdir(), 'change-pool-'))
  try {
    const storeA = new LevelChangePoolStore(dir)
    await storeA.Open()
    const poolA = new MonadChangePool({
      keyring: MonadChangeKeyring.fromMnemonic(TEST_MNEMONIC),
      store: storeA,
    })
    await poolA.sweepToChange({
      burnIndex: 1,
      burnAddress: '0xburn1',
      burnAccountSigner: makeBurnAccountSigner(),
      provider: makeReadProvider(BigInt(21000) * 1n * 2n + 555n),
      overrides: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
    })
    await storeA.Close()

    const storeB = new LevelChangePoolStore(dir)
    await storeB.Open()
    const poolB = new MonadChangePool({
      keyring: MonadChangeKeyring.fromMnemonic(TEST_MNEMONIC),
      store: storeB,
    })
    assertEqual(
      poolB.nextUnusedIndex(),
      1,
      'reopened store keeps the advanced pointer',
    )
    assertEqual(
      poolB.records().length,
      1,
      'reopened store keeps the swept record',
    )
    assertEqual(
      poolB.getRecord(0)?.sweptValueWei,
      '555',
      'reopened record has the right amount',
    )
    await storeB.Close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function checkSetNextUnusedIndexGuard() {
  console.log('\n== MonadChangePool.setNextUnusedIndex rewind guard ==')
  const pool = new MonadChangePool({
    keyring: MonadChangeKeyring.fromMnemonic(TEST_MNEMONIC),
    store: new InMemoryChangePoolStore(),
  })
  await pool.sweepToChange({
    burnIndex: 0,
    burnAddress: '0xburn',
    burnAccountSigner: makeBurnAccountSigner(),
    provider: makeReadProvider(BigInt(21000) * 1n * 2n + 1n),
    overrides: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
  })
  let threw = false
  try {
    pool.setNextUnusedIndex(0)
  } catch {
    threw = true
  }
  assertTrue(threw, 'rewinding past an existing record without force throws')
  pool.setNextUnusedIndex(0, { force: true })
  assertEqual(pool.nextUnusedIndex(), 0, 'force allows the rewind')
}

async function main() {
  await checkDerivationDeterminismAndBranchSeparation()
  await checkDustThreshold()
  await checkSweepAndSequentialAllocation()
  await checkLeaseReleaseWiring()
  await checkLevelStorePersistsAcrossRestart()
  await checkSetNextUnusedIndexGuard()
  console.log(
    '\nAll monad-change-pool livecheck assertions passed.',
  )
}

main().catch(err => {
  console.error('\nLIVECHECK FAILED:', err)
  process.exit(1)
})
