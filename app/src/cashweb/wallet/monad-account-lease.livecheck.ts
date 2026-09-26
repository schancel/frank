/**
 * Standalone, manually-run proof for `monad-account-lease.ts` (ticket #18), in the same spirit as
 * `monad-account-pool.livecheck.ts` / `monad-account-tx.livecheck.ts` (see those files' headers
 * for why this isn't a jest test: `jest` isn't actually an installed dependency in this app despite
 * `jest.config.js`/`package.json` referring to it — confirmed again for this ticket by
 * `ls node_modules/.bin/jest` finding nothing after a clean `yarn install`).
 * `monad-account-lease.jest.test.ts` covers the same scenarios (and more) and will run unmodified
 * once jest is installed for real.
 *
 * No network access at all: the pool is backed by `InMemorySubAccountPoolStore` (no chain reads
 * needed for HD derivation or status bookkeeping), and tx-status is a hand-rolled fake
 * `LeaseTxStatusSource` returning a scripted sequence of statuses. All "waiting" uses a fake
 * clock/sleep pair that advances instantly, so this finishes immediately with no real delays.
 *
 * Usage (from `app/`, after `yarn install` so `node_modules/.bin/tsc` and the runtime deps below
 * actually exist — this worktree had no `node_modules` at all until that was run for this ticket):
 *   node_modules/.bin/tsc --module commonjs --target es2019 --esModuleInterop --resolveJsonModule \
 *     --skipLibCheck \
 *     --outDir /tmp/monad-account-lease-livecheck src/cashweb/wallet/monad-http.ts \
 *     src/cashweb/wallet/monad-account-tx.ts src/cashweb/wallet/monad-hd-keyring.ts \
 *     src/cashweb/wallet/monad-account-pool.ts src/cashweb/wallet/monad-account-lease.ts \
 *     src/cashweb/wallet/storage/sub-account-pool-storage.ts \
 *     src/cashweb/wallet/storage/level-sub-account-pool-store.ts \
 *     src/cashweb/wallet/monad-account-lease.livecheck.ts
 *   NODE_PATH="$(pwd)/node_modules" node /tmp/monad-account-lease-livecheck/monad-account-lease.livecheck.js
 * (`--skipLibCheck` works around a pre-existing, unrelated `@types/eslint` duplicate-identifier
 * conflict in this app's `node_modules`; `NODE_PATH` is needed because the compiled output under
 * `/tmp` has no `node_modules` of its own for its runtime deps like `ethers`/`bip39` to resolve
 * from.)
 */
import { MonadHdKeyring } from './monad-hd-keyring'
import { MonadSubAccountPool } from './monad-account-pool'
import {
  acquireLeaseWhenAvailable,
  AccountLeaseHandle,
  awaitLeaseSettlement,
  InvalidLeaseHandleError,
  LeaseTxStatusSource,
  NoAvailableSubAccountError,
  SubAccountAlreadyLeasedError,
  SubAccountLeaseManager,
} from './monad-account-lease'
import { MonadTxStatus } from './monad-account-tx'

function assertEqual(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(
        actual,
      )}`,
    )
  }
  console.log(`  OK  ${label} = ${JSON.stringify(expected)}`)
}

function assertTrue(condition: boolean, label: string) {
  if (!condition) throw new Error(`${label}: expected true`)
  console.log(`  OK  ${label}`)
}

async function assertThrows(
  fn: () => unknown,
  expectedCtor: new (...args: never[]) => Error,
  label: string,
) {
  try {
    await fn()
  } catch (err) {
    assertTrue(err instanceof expectedCtor, `${label} (correct error type)`)
    return
  }
  throw new Error(`${label}: expected a throw, but none occurred`)
}

const TEST_MNEMONIC =
  'test test test test test test test test test test test junk'

function makePool(size: number): MonadSubAccountPool {
  const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC)
  const pool = new MonadSubAccountPool({ keyring })
  pool.ensureSize(size)
  return pool
}

function makeFakeClock(stepMs: number) {
  let elapsed = 0
  return {
    now: () => elapsed,
    sleep: async (ms: number) => {
      elapsed += ms > 0 ? ms : stepMs
    },
  }
}

function makeStatusSource(statuses: MonadTxStatus[]): LeaseTxStatusSource {
  let call = 0
  return {
    async getStatus() {
      const next = statuses[Math.min(call, statuses.length - 1)]
      call++
      return next
    },
  }
}

async function checkAcquireAndContention() {
  console.log('\n== acquireLease / acquireForIndex + contention ==')
  const pool = makePool(2)
  const manager = new SubAccountLeaseManager(pool)

  const handle = manager.acquireLease()
  assertEqual(handle.index, 0, 'acquireLease() picks index 0 first')
  assertEqual(
    pool.getRecord(0)?.status,
    'in-use',
    'acquire flips status to in-use via pool.setStatus',
  )
  assertTrue(manager.isLeased(0), 'manager tracks the live lease')

  await assertThrows(
    () => manager.acquireForIndex(0),
    SubAccountAlreadyLeasedError,
    'a second acquire on an already-leased index is rejected',
  )
  assertEqual(
    JSON.stringify(manager.leasedIndices()),
    JSON.stringify([0]),
    'still exactly one live lease after the rejected double-acquire',
  )

  const soleAccountPool = makePool(1)
  const soleManager = new SubAccountLeaseManager(soleAccountPool)
  soleManager.acquireLease()
  await assertThrows(
    () => soleManager.acquireLease(),
    NoAvailableSubAccountError,
    'acquireLease() rejects immediately when no account is available',
  )
}

async function checkReleaseOutcomes() {
  console.log('\n== releaseLease outcomes ==')

  // Confirmed happy path.
  const poolA = makePool(1)
  const managerA = new SubAccountLeaseManager(poolA)
  const handleA = managerA.acquireForIndex(0)
  const recordA = managerA.releaseLease(handleA, 'confirmed')
  assertEqual(recordA.status, 'available', 'confirmed -> available')
  assertTrue(!managerA.isLeased(0), 'no longer tracked as live after release')

  // Failed outcome retires.
  const poolB = makePool(1)
  const managerB = new SubAccountLeaseManager(poolB)
  const handleB = managerB.acquireForIndex(0)
  const recordB = managerB.releaseLease(handleB, 'failed')
  assertEqual(recordB.status, 'retired', 'failed -> retired')

  // Stuck outcome retires.
  const poolC = makePool(1)
  const managerC = new SubAccountLeaseManager(poolC)
  const handleC = managerC.acquireForIndex(0)
  const recordC = managerC.releaseLease(handleC, 'stuck')
  assertEqual(recordC.status, 'retired', 'stuck -> retired')

  // Retired accounts are excluded from future selection.
  const poolD = makePool(2)
  const managerD = new SubAccountLeaseManager(poolD)
  const handleD = managerD.acquireForIndex(0)
  managerD.releaseLease(handleD, 'failed')
  const next = managerD.acquireLease()
  assertEqual(next.index, 1, 'retired index 0 skipped by subsequent acquire')

  // Double-release rejected.
  const poolE = makePool(1)
  const managerE = new SubAccountLeaseManager(poolE)
  const handleE = managerE.acquireForIndex(0)
  managerE.releaseLease(handleE, 'confirmed')
  await assertThrows(
    () => managerE.releaseLease(handleE, 'confirmed'),
    InvalidLeaseHandleError,
    'double-release of the same handle throws',
  )

  // Foreign handle rejected.
  const poolF = makePool(1)
  const managerF = new SubAccountLeaseManager(poolF)
  const foreignHandle: AccountLeaseHandle = { index: 0, address: '0xabc' }
  await assertThrows(
    () => managerF.releaseLease(foreignHandle, 'confirmed'),
    InvalidLeaseHandleError,
    'a handle never issued by this manager is rejected',
  )

  // Full cycle: release then re-acquire the same index.
  const poolG = makePool(1)
  const managerG = new SubAccountLeaseManager(poolG)
  const firstHandle = managerG.acquireForIndex(0)
  managerG.releaseLease(firstHandle, 'confirmed')
  const secondHandle = managerG.acquireForIndex(0)
  assertEqual(
    secondHandle.index,
    0,
    'account is cyclable after confirmed release',
  )
  assertEqual(
    poolG.getRecord(0)?.status,
    'in-use',
    'back to in-use on the second acquire',
  )
}

async function checkAcquireLeaseWhenAvailable() {
  console.log('\n== acquireLeaseWhenAvailable ==')

  const poolA = makePool(1)
  const managerA = new SubAccountLeaseManager(poolA)
  const clockA = makeFakeClock(10)
  const immediate = await acquireLeaseWhenAvailable(managerA, {
    sleep: clockA.sleep,
    now: clockA.now,
  })
  assertEqual(immediate.index, 0, 'resolves immediately when already available')

  const poolB = makePool(1)
  const managerB = new SubAccountLeaseManager(poolB)
  const busyHandle = managerB.acquireForIndex(0)
  const clockB = makeFakeClock(10)
  const waiter = acquireLeaseWhenAvailable(managerB, {
    pollIntervalMs: 10,
    timeoutMs: 1000,
    sleep: clockB.sleep,
    now: clockB.now,
  })
  await Promise.resolve()
  managerB.releaseLease(busyHandle, 'confirmed')
  const waited = await waiter
  assertEqual(waited.index, 0, 'waits, then acquires once freed')

  const poolC = makePool(1)
  const managerC = new SubAccountLeaseManager(poolC)
  managerC.acquireForIndex(0)
  const clockC = makeFakeClock(10)
  await assertThrows(
    () =>
      acquireLeaseWhenAvailable(managerC, {
        pollIntervalMs: 10,
        timeoutMs: 30,
        sleep: clockC.sleep,
        now: clockC.now,
      }),
    NoAvailableSubAccountError,
    'gives up once timeoutMs elapses with nothing freed',
  )
}

async function checkAwaitLeaseSettlement() {
  console.log('\n== awaitLeaseSettlement (stuck-nonce detection) ==')

  // Confirmed happy path.
  const poolA = makePool(1)
  const managerA = new SubAccountLeaseManager(poolA)
  const handleA = managerA.acquireForIndex(0)
  const clockA = makeFakeClock(1000)
  const resultA = await awaitLeaseSettlement({
    manager: managerA,
    handle: handleA,
    txHash: '0xdeadbeef',
    statusSource: makeStatusSource(['pending', 'pending', 'confirmed']),
    pollIntervalMs: 1000,
    timeoutMs: 60_000,
    sleep: clockA.sleep,
    now: clockA.now,
  })
  assertEqual(resultA.outcome, 'confirmed', 'settles confirmed')
  assertEqual(
    resultA.record.status,
    'available',
    'confirmed releases to available',
  )

  // Failed receipt.
  const poolB = makePool(1)
  const managerB = new SubAccountLeaseManager(poolB)
  const handleB = managerB.acquireForIndex(0)
  const clockB = makeFakeClock(1000)
  const resultB = await awaitLeaseSettlement({
    manager: managerB,
    handle: handleB,
    txHash: '0xdeadbeef',
    statusSource: makeStatusSource(['pending', 'failed']),
    pollIntervalMs: 1000,
    sleep: clockB.sleep,
    now: clockB.now,
  })
  assertEqual(resultB.outcome, 'failed', 'settles failed')
  assertEqual(resultB.record.status, 'retired', 'failed releases to retired')

  // Stuck timeout — never confirms.
  const poolC = makePool(2)
  const managerC = new SubAccountLeaseManager(poolC)
  const handleC = managerC.acquireForIndex(0)
  const clockC = makeFakeClock(1000)
  const resultC = await awaitLeaseSettlement({
    manager: managerC,
    handle: handleC,
    txHash: '0xdeadbeef',
    statusSource: makeStatusSource(['pending']),
    pollIntervalMs: 1000,
    timeoutMs: 3000,
    sleep: clockC.sleep,
    now: clockC.now,
  })
  assertEqual(resultC.outcome, 'stuck', 'settles stuck after timeout')
  assertEqual(resultC.record.status, 'retired', 'stuck releases to retired')
  assertEqual(
    poolC.selectForStamp()?.index,
    1,
    'retired-by-timeout account excluded from future selection',
  )
}

async function main() {
  await checkAcquireAndContention()
  await checkReleaseOutcomes()
  await checkAcquireLeaseWhenAvailable()
  await checkAwaitLeaseSettlement()
  console.log('\nAll monad-account-lease livecheck assertions passed.')
}

main().catch(err => {
  console.error('\nLIVECHECK FAILED:', err)
  process.exit(1)
})
