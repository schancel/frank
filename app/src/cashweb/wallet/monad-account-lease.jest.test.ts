/**
 * Unit tests for `monad-account-lease.ts` (ticket #18), against a real `MonadSubAccountPool` (#14,
 * backed by an in-memory store — no chain access needed for pool state) and a mocked
 * `LeaseTxStatusSource` (standing in for `MonadAccountTxSigner.getStatus`, #11).
 *
 * NOT CURRENTLY RUN: same pre-existing gap `monad-account-tx.jest.test.ts` and
 * `monad-account-pool.jest.test.ts` document — `jest` (and the rest of the
 * `@quasar/quasar-app-extension-testing-unit-jest` package set `jest.config.js` assumes) is not
 * actually installed in this app, confirmed again for this ticket by `ls node_modules/.bin/jest`
 * finding nothing after a clean `yarn install`. Fixing that (tracked separately, ticket #28) is out
 * of this ticket's file-ownership scope (`app/src/cashweb/wallet/` only). This file follows
 * `jest.config.js`'s own `testMatch` convention (`src/**\/*.jest.(spec|test).ts`) so it will be
 * picked up automatically, unmodified, the moment that infra lands. Until then:
 *   - `describe`/`it`/`expect`/`jest` below are untyped/unrun; same `env: { jest: true }` eslint
 *     carve-out the other `*.jest.test.ts` files in this directory rely on applies here.
 *   - Every scenario here is also exercised for real, right now, without jest, by
 *     `monad-account-lease.livecheck.ts` in this same directory (run via `tsc`+`node`) — see that
 *     file's header for how to run it; it was run for this handoff and all assertions passed.
 *
 * All polling in these tests uses an injected fake `sleep`/`now` (see `AcquireLeaseWhenAvailable
 * Options`/`AwaitLeaseSettlementParams`) rather than real timers, so nothing here actually waits
 * wall-clock time.
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

const TEST_MNEMONIC =
  'test test test test test test test test test test test junk'

function makePool(size: number): MonadSubAccountPool {
  const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC)
  const pool = new MonadSubAccountPool({ keyring })
  pool.ensureSize(size)
  return pool
}

/** A fake clock + fake sleep pair that advances instantly (rather than waiting real time) whenever
 * `sleep` is awaited, so timeout-driven tests run in effectively zero wall-clock time. */
function makeFakeClock(stepMs: number) {
  let elapsed = 0
  return {
    now: () => elapsed,
    sleep: async (ms: number) => {
      elapsed += ms > 0 ? ms : stepMs
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

describe('SubAccountLeaseManager', () => {
  describe('acquireLease / acquireForIndex', () => {
    it('leases the next available account and flips it to in-use via pool.setStatus', () => {
      const pool = makePool(2)
      const manager = new SubAccountLeaseManager(pool)

      const handle = manager.acquireLease()

      expect(handle.index).toBe(0)
      expect(pool.getRecord(0)?.status).toBe('in-use')
      expect(manager.isLeased(0)).toBe(true)
    })

    it('rejects (throws) rather than silently granting when no account is available', () => {
      const pool = makePool(1)
      const manager = new SubAccountLeaseManager(pool)
      manager.acquireLease() // leases the only account

      expect(() => manager.acquireLease()).toThrow(NoAvailableSubAccountError)
    })

    it('lease contention: a second acquire on an already-leased index is rejected, not granted', () => {
      const pool = makePool(2)
      const manager = new SubAccountLeaseManager(pool)
      manager.acquireForIndex(0)

      expect(() => manager.acquireForIndex(0)).toThrow(
        SubAccountAlreadyLeasedError,
      )
      // Still exactly one live lease on index 0 — the rejected call didn't double-grant it.
      expect(manager.leasedIndices()).toEqual([0])
    })

    it('rejects acquiring a retired account', () => {
      const pool = makePool(1)
      pool.setStatus(0, 'retired')
      const manager = new SubAccountLeaseManager(pool)

      expect(() => manager.acquireForIndex(0)).toThrow(
        SubAccountAlreadyLeasedError,
      )
    })

    it('throws a plain Error for an index unknown to the pool', () => {
      const pool = makePool(1)
      const manager = new SubAccountLeaseManager(pool)
      expect(() => manager.acquireForIndex(5)).toThrow(
        /No sub-account at index 5/,
      )
    })
  })

  describe('releaseLease', () => {
    it('confirmed happy-path: returns the account to available for reuse', () => {
      const pool = makePool(1)
      const manager = new SubAccountLeaseManager(pool)
      const handle = manager.acquireForIndex(0)

      const record = manager.releaseLease(handle, 'confirmed')

      expect(record.status).toBe('available')
      expect(pool.getRecord(0)?.status).toBe('available')
      expect(manager.isLeased(0)).toBe(false)
    })

    it('failed outcome: retires the account instead of returning it to available', () => {
      const pool = makePool(1)
      const manager = new SubAccountLeaseManager(pool)
      const handle = manager.acquireForIndex(0)

      const record = manager.releaseLease(handle, 'failed')

      expect(record.status).toBe('retired')
      expect(pool.getRecord(0)?.status).toBe('retired')
    })

    it('stuck outcome: also retires the account', () => {
      const pool = makePool(1)
      const manager = new SubAccountLeaseManager(pool)
      const handle = manager.acquireForIndex(0)

      const record = manager.releaseLease(handle, 'stuck')

      expect(record.status).toBe('retired')
    })

    it('a retired account is excluded from future selection', () => {
      const pool = makePool(2)
      const manager = new SubAccountLeaseManager(pool)
      const handle = manager.acquireForIndex(0)
      manager.releaseLease(handle, 'failed')

      const next = manager.acquireLease()
      expect(next.index).toBe(1) // index 0 is retired, skipped
    })

    it('double-release of the same handle throws InvalidLeaseHandleError', () => {
      const pool = makePool(1)
      const manager = new SubAccountLeaseManager(pool)
      const handle = manager.acquireForIndex(0)
      manager.releaseLease(handle, 'confirmed')

      expect(() => manager.releaseLease(handle, 'confirmed')).toThrow(
        InvalidLeaseHandleError,
      )
    })

    it('releasing a handle never issued by this manager throws InvalidLeaseHandleError', () => {
      const pool = makePool(1)
      const manager = new SubAccountLeaseManager(pool)
      const foreignHandle: AccountLeaseHandle = { index: 0, address: '0xabc' }

      expect(() => manager.releaseLease(foreignHandle, 'confirmed')).toThrow(
        InvalidLeaseHandleError,
      )
    })

    it('after release, the account can be leased again (lease is fully cyclable)', () => {
      const pool = makePool(1)
      const manager = new SubAccountLeaseManager(pool)
      const first = manager.acquireForIndex(0)
      manager.releaseLease(first, 'confirmed')

      const second = manager.acquireForIndex(0)
      expect(second.index).toBe(0)
      expect(pool.getRecord(0)?.status).toBe('in-use')
    })
  })
})

describe('acquireLeaseWhenAvailable', () => {
  it('resolves immediately if an account is already available', async () => {
    const pool = makePool(1)
    const manager = new SubAccountLeaseManager(pool)
    const clock = makeFakeClock(10)

    const handle = await acquireLeaseWhenAvailable(manager, {
      sleep: clock.sleep,
      now: clock.now,
    })
    expect(handle.index).toBe(0)
  })

  it('waits (polls) until an account frees up, then acquires it', async () => {
    const pool = makePool(1)
    const manager = new SubAccountLeaseManager(pool)
    const busyHandle = manager.acquireForIndex(0) // no account available yet
    const clock = makeFakeClock(10)

    // `acquireLeaseWhenAvailable`'s retry loop resolves its own injected `sleep()` every
    // ~1 microtask tick, so a single `await Promise.resolve()` in this test does NOT reliably
    // interleave with it — the loop can (and, empirically, reliably does) run to its full
    // `timeoutMs` budget entirely within microtask time before this test's own continuation ever
    // gets a turn. The deterministic fix: release the account from *inside* the injected `sleep`
    // itself (on its first call), since that's the one hook guaranteed to run between retries.
    let released = false
    const releasingSleep = async (ms: number) => {
      if (!released) {
        released = true
        manager.releaseLease(busyHandle, 'confirmed')
      }
      await clock.sleep(ms)
    }

    const handle = await acquireLeaseWhenAvailable(manager, {
      pollIntervalMs: 10,
      timeoutMs: 1000,
      sleep: releasingSleep,
      now: clock.now,
    })
    expect(handle.index).toBe(0)
  })

  it('gives up and throws NoAvailableSubAccountError once timeoutMs elapses', async () => {
    const pool = makePool(1)
    const manager = new SubAccountLeaseManager(pool)
    manager.acquireForIndex(0) // never released within this test
    const clock = makeFakeClock(10)

    await expect(
      acquireLeaseWhenAvailable(manager, {
        pollIntervalMs: 10,
        timeoutMs: 30,
        sleep: clock.sleep,
        now: clock.now,
      }),
    ).rejects.toThrow(NoAvailableSubAccountError)
  })
})

describe('awaitLeaseSettlement', () => {
  it('confirmed happy-path: releases to available once getStatus reports confirmed', async () => {
    const pool = makePool(1)
    const manager = new SubAccountLeaseManager(pool)
    const handle = manager.acquireForIndex(0)
    const statusSource = makeStatusSource(['pending', 'pending', 'confirmed'])
    const clock = makeFakeClock(1000)

    const result = await awaitLeaseSettlement({
      manager,
      handle,
      txHash: '0xdeadbeef',
      statusSource,
      pollIntervalMs: 1000,
      timeoutMs: 60_000,
      sleep: clock.sleep,
      now: clock.now,
    })

    expect(result.outcome).toBe('confirmed')
    expect(result.record.status).toBe('available')
    expect(pool.getRecord(0)?.status).toBe('available')
    expect(statusSource.getStatus).toHaveBeenCalledWith('0xdeadbeef')
  })

  it('failed receipt: retires the account rather than returning it to available', async () => {
    const pool = makePool(1)
    const manager = new SubAccountLeaseManager(pool)
    const handle = manager.acquireForIndex(0)
    const statusSource = makeStatusSource(['pending', 'failed'])
    const clock = makeFakeClock(1000)

    const result = await awaitLeaseSettlement({
      manager,
      handle,
      txHash: '0xdeadbeef',
      statusSource,
      pollIntervalMs: 1000,
      sleep: clock.sleep,
      now: clock.now,
    })

    expect(result.outcome).toBe('failed')
    expect(result.record.status).toBe('retired')
  })

  it('stuck-timeout: a tx that never confirms within timeoutMs is retired, not reused', async () => {
    const pool = makePool(1)
    const manager = new SubAccountLeaseManager(pool)
    const handle = manager.acquireForIndex(0)
    const statusSource = makeStatusSource(['pending']) // always pending
    const clock = makeFakeClock(1000)

    const result = await awaitLeaseSettlement({
      manager,
      handle,
      txHash: '0xdeadbeef',
      statusSource,
      pollIntervalMs: 1000,
      timeoutMs: 3000,
      sleep: clock.sleep,
      now: clock.now,
    })

    expect(result.outcome).toBe('stuck')
    expect(result.record.status).toBe('retired')
    expect(pool.getRecord(0)?.status).toBe('retired')
    // Retired, so it's excluded from future selection.
    pool.ensureSize(2)
    expect(pool.selectForStamp()?.index).toBe(1)
  })
})
