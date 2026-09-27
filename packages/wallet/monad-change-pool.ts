/**
 * HD change-account pool + burn-account leftover-balance sweeping for Monad (ticket #36).
 *
 * Ticket #34 made burn sub-accounts single-use: each is funded with `burnValue + gasReserve`,
 * spent once, then permanently `'spent'` (see `monad-account-lease.ts`'s `releaseLease`). Actual
 * gas used is almost always less than the reserved `gasReserve`, so a just-spent burn account
 * typically has real leftover balance with nowhere to go -- previously just stranded forever in a
 * dead account. This module gives it somewhere to go: a dedicated BIP-44 **change** branch
 * (`m/44'/60'/0'/1/i`, `./monad-change-keyring.ts`), allocated strictly sequentially (never reused,
 * same single-use philosophy as #34's burn accounts), one index per swept-out burn account.
 *
 * `MonadChangePool` mirrors `MonadSubAccountPool` (`./monad-account-pool.ts`)'s shape -- a keyring
 * + a persisted store -- but is deliberately much smaller: a change account is purely a sweep
 * *destination*, never leased/selected/spent itself, so there's no `SubAccountStatus`-style
 * lifecycle here, just a monotonically-advancing "next unused index" pointer
 * (`storage/change-pool-storage.ts`) and an audit trail of what got swept where.
 *
 * Wiring into `releaseLease`'s `'spent'` outcome, without editing `monad-account-lease.ts`
 * --------------------------------------------------------------------------------------------
 * This ticket's ownership rules forbid editing `monad-account-lease.ts`. That file already
 * exports everything needed to compose this from the outside: `SubAccountLeaseManager.
 * releaseLease` and the `awaitLeaseSettlement` function both already return the resulting
 * `SubAccountRecord` (whose `status` becomes `'spent'` exactly on the `'confirmed'` outcome -- see
 * that file's `LeaseOutcome` -> `SubAccountStatus` mapping). `releaseLeaseAndSweepChange` /
 * `awaitLeaseSettlementAndSweepChange` (below) simply call straight through to those exports and,
 * only when the resulting record is `'spent'`, additionally call `sweepToChange` on this pool --
 * zero changes to `monad-account-lease.ts`'s own code or public shape were needed.
 *
 * Dust threshold (ticket #36 acceptance criterion 3)
 * ---------------------------------------------------
 * A sweep transaction costs gas itself, so leftover balance below that cost isn't worth moving.
 * `estimateDustThresholdWei` (below) reads the provider's current fee data and computes
 * `21000 gas (a plain EOA-to-EOA transfer, no calldata) * effective fee-per-gas * 2` (a 2x safety
 * margin -- see that function's doc comment for why). If a burn account's leftover balance is at
 * or below this threshold, `sweepToChange` skips the sweep entirely (`{ swept: false, reason:
 * 'below-dust-threshold' }`) rather than attempting (and likely failing, or leaving ~nothing after
 * gas) a doomed transfer. Callers may override this with an explicit `dustThresholdWei`.
 *
 * What happens to accumulated change balance over time? (ticket #36 acceptance criterion 5)
 * --------------------------------------------------------------------------------------------
 * Not solved here (an explicit non-goal: "Automatic/scheduled consolidation of change balances...
 * a manual or simple periodic trigger is fine"). What's true today: change balance accumulates
 * across an ever-growing set of one-time-funded `m/44'/60'/0'/1/i` addresses -- each individually
 * small (usually just the unused sliver of a burn account's `gasReserve`), each already recorded
 * with enough bookkeeping (`ChangeAccountRecord.sourceBurnIndex`/`address`, `records()`) to drive
 * a future consolidation pass. Two plausible directions for that follow-up, neither implemented
 * here:
 *   (a) **Sweep-to-main**: periodically (a cron-style background task, or a manually-triggered
 *       "consolidate now" action) iterate `records()`, re-derive each change account's signer via
 *       `MonadChangeKeyring.deriveChangeAccount(index)`, and transfer each one's current balance
 *       (again gated by the same dust-threshold logic as here) back into the main funding account
 *       that originally fan-out-funds burn accounts (`monad-account-pool.ts`'s
 *       `fanOutFundSubAccounts`) -- closing the loop.
 *   (b) **Promote directly to a fresh burn account**: since a change account and a burn account
 *       are both just derived EOAs, a sufficiently-funded change account could itself be
 *       "promoted" -- have its balance topped up (if short of `burnValue + gasReserve`) or trimmed
 *       and handed to `MonadSubAccountPool` as a pre-funded `'available'` record, skipping a
 *       redundant fan-out transfer through the main account. This blurs the branch-0/branch-1
 *       distinction somewhat (a byte of "spend" history predates it being an "available" burn
 *       account) and is flagged, not attempted, here.
 * Either way, consolidation batches are themselves a correlation point on-chain (same caveat
 * `monad-account-pool.ts`'s file header already flags for fan-out funding) -- not solved here,
 * consistent with this ticket's non-goals.
 */
import { Provider } from 'ethers'

import { MonadChangeKeyring } from './monad-change-keyring'
import { MonadAccountTxSigner, MonadTxOverrides } from './monad-account-tx'
import {
  AccountLeaseHandle,
  AwaitLeaseSettlementParams,
  LeaseOutcome,
  LeaseSettlementResult,
  SubAccountLeaseManager,
  awaitLeaseSettlement,
} from './monad-account-lease'
import { SubAccountRecord } from './storage/sub-account-pool-storage'
import {
  ChangeAccountRecord,
  ChangePoolStore,
  InMemoryChangePoolStore,
} from './storage/change-pool-storage'

export {
  ChangeAccountRecord,
  ChangePoolStore,
} from './storage/change-pool-storage'

/** Standard EVM plain-value-transfer gas cost (no calldata, EOA recipient) -- the same figure this
 * codebase already assumes elsewhere for gas budgeting of a bare transfer (e.g.
 * `monad-account-pool.livecheck.ts`'s `estimateGas` stub returns `0x5208` == 21000 for exactly
 * this shape of transaction). A sweep-to-change transfer is exactly this shape. */
const PLAIN_TRANSFER_GAS_LIMIT = BigInt(21000)

/** Safety multiplier applied to the plain estimated gas cost before treating a leftover balance
 * as "dust" (see this file's header). `2` rather than `1` because fee data is read once, here, but
 * the sweep's actual fee is only pinned down moments later inside `buildAndSignTransfer`'s own
 * `populateTransaction` call -- doubling the estimate absorbs ordinary fee movement between those
 * two reads without risking an `insufficient-funds` failure on submit. This is a documented,
 * easily-overridden default (`dustThresholdWei` param on `sweepToChange`), not derived from any
 * protocol constant. */
const DUST_SAFETY_MULTIPLIER = BigInt(2)

/** Computes the default dust threshold (see this file's header) from the provider's current fee
 * data. Throws if the provider reports neither `maxFeePerGas` nor `gasPrice` -- there's no sane
 * default to fall back to, and silently sweeping with an unknown gas cost risks losing the whole
 * leftover balance to fees (or failing outright). */
export async function estimateDustThresholdWei(
  provider: Provider,
): Promise<bigint> {
  const feeData = await provider.getFeeData()
  const feePerGas = feeData.maxFeePerGas ?? feeData.gasPrice
  if (feePerGas === null || feePerGas === undefined) {
    throw new Error(
      'Unable to estimate a sweep dust threshold: provider returned neither maxFeePerGas nor gasPrice',
    )
  }
  return PLAIN_TRANSFER_GAS_LIMIT * feePerGas * DUST_SAFETY_MULTIPLIER
}

/** Result of `MonadChangePool.sweepToChange`. */
export type ChangeSweepOutcome =
  | {
      swept: true
      record: ChangeAccountRecord
      /** Same value as `record.sweptValueWei`, but as a `bigint` for callers doing arithmetic on
       * it without re-parsing the stored decimal string. */
      sweptValueWei: bigint
    }
  | {
      swept: false
      reason: 'below-dust-threshold' | 'sweep-error'
      balanceWei?: bigint
      dustThresholdWei?: bigint
      /** Present only when `reason === 'sweep-error'` (see `releaseLeaseAndSweepChange`, which is
       * the only caller that produces this reason -- `sweepToChange` itself never swallows a
       * build/submit failure, it always propagates). */
      error?: unknown
    }

/**
 * Tracks the change-account pool's persisted "next unused index" pointer and the audit trail of
 * change outputs actually swept into existence, mirroring `MonadSubAccountPool`'s
 * keyring-plus-store shape (see this file's header for what's deliberately *not* mirrored -- no
 * per-account status/lifecycle).
 */
export class MonadChangePool {
  private readonly keyring: MonadChangeKeyring
  private readonly store: ChangePoolStore

  constructor(params: {
    keyring: MonadChangeKeyring
    store?: ChangePoolStore
  }) {
    this.keyring = params.keyring
    this.store = params.store ?? new InMemoryChangePoolStore()
  }

  /** The next change index that has never had a sweep land on it. */
  nextUnusedIndex(): number {
    return this.store.getNextIndex()
  }

  /** Every change record actually swept into existence so far, sorted by index. */
  records(): ChangeAccountRecord[] {
    return this.store.getAll()
  }

  getRecord(index: number): ChangeAccountRecord | undefined {
    return this.store.getRecord(index)
  }

  /** Derives (without persisting or mutating anything) the index/address a sweep would currently
   * land on -- i.e. `deriveChangeAccount(nextUnusedIndex())`. Read-only; safe to call any number
   * of times without side effects. */
  peekNextChangeAddress(): { index: number; address: string } {
    const index = this.store.getNextIndex()
    return { index, address: this.keyring.deriveChangeAccount(index).address }
  }

  /**
   * Explicitly (re)seeds the "next unused index" pointer -- the write path `./monad-change-
   * recovery.ts`'s bisection recovery is expected to call after reconstructing the pointer from
   * chain data alone. Guarded: refuses to move the pointer *backward* while any change record
   * already exists locally, unless `force` is set, since rewinding past real records risks a
   * future sweep re-deriving (and reusing) an index that's already funded on-chain -- the one
   * thing strict sequential allocation is supposed to prevent. The intended use case (restoring a
   * wallet from seed alone, no local state) always has zero local records, so this guard never
   * fires in practice for that path.
   */
  setNextUnusedIndex(index: number, opts: { force?: boolean } = {}): void {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(
        `Next change index must be a non-negative integer, got ${index}`,
      )
    }
    const current = this.store.getNextIndex()
    const existingRecords = this.store.getAll()
    if (index < current && existingRecords.length > 0 && !opts.force) {
      throw new Error(
        `Refusing to rewind next-change-index pointer from ${current} to ${index} while ` +
          `${existingRecords.length} change record(s) already exist locally -- this would risk ` +
          're-deriving/reusing an already-swept-to index. Pass { force: true } if you are certain ' +
          "this store's records are stale/wrong.",
      )
    }
    this.store.setNextIndex(index)
  }

  /**
   * Core sweep operation (ticket #36 acceptance criterion 2): queries `burnAddress`'s actual
   * on-chain leftover balance via `provider.getBalance` (real balance, not the amount originally
   * funded minus a guessed gas cost), and if it clears the dust threshold (see this file's
   * header), builds/signs/submits a transfer of `balance - dustThreshold` to the next unused
   * change address, then persists the record and advances the pointer -- in that order, and only
   * after the transfer actually submits successfully, mirroring `MonadSubAccountPool.topUpPool`'s
   * "persist only after the on-chain send succeeds" ordering for the same partial-failure-safety
   * reason: if this throws partway through (e.g. the submit fails), nothing is persisted, so a
   * retry safely re-attempts against the same still-next index rather than skipping one.
   *
   * Returns `{ swept: false, reason: 'below-dust-threshold' }` (never throws) when the leftover
   * balance doesn't clear the threshold. Any build/submit failure propagates as a thrown error to
   * this method's own caller -- see `releaseLeaseAndSweepChange`/`awaitLeaseSettlementAndSweepChange`
   * below for the composed lease-release path, which *does* catch it (as `reason: 'sweep-error'`)
   * so a transient sweep failure never undoes an already-successful lease release.
   */
  async sweepToChange(params: {
    /** The just-spent burn sub-account's index, recorded on the resulting `ChangeAccountRecord`
     * purely for audit/observability (see that interface's doc comment). */
    burnIndex: number
    burnAddress: string
    /** Signer for the burn account at `burnAddress` -- e.g. `MonadSubAccountPool.getSigner
     * (burnIndex, { provider, httpClient })`. Used to build/sign/submit the sweep transfer. */
    burnAccountSigner: MonadAccountTxSigner
    /** ethers `Provider` used to read `burnAddress`'s real on-chain balance and (unless
     * `dustThresholdWei` is given) current fee data. Same "separate `Provider` handle" pattern
     * `monad-account-tx.ts`/`monad-account-pool.ts` already use for chain reads
     * `MonadHttpClient` doesn't expose. */
    provider: Provider
    /** Overrides `estimateDustThresholdWei`'s computed value -- mainly for tests/determinism, or
     * a caller with its own fee-cost model. */
    dustThresholdWei?: bigint
    overrides?: MonadTxOverrides
  }): Promise<ChangeSweepOutcome> {
    const balanceWei = await params.provider.getBalance(params.burnAddress)
    const dustThresholdWei =
      params.dustThresholdWei ??
      (await estimateDustThresholdWei(params.provider))

    if (balanceWei <= dustThresholdWei) {
      return {
        swept: false,
        reason: 'below-dust-threshold',
        balanceWei,
        dustThresholdWei,
      }
    }

    const sweptValueWei = balanceWei - dustThresholdWei
    const { index, address } = this.peekNextChangeAddress()

    const signedTx = await params.burnAccountSigner.buildAndSignTransfer(
      address,
      sweptValueWei,
      params.overrides,
    )
    const txHash = await params.burnAccountSigner.submit(signedTx)

    const record: ChangeAccountRecord = {
      index,
      address,
      sourceBurnIndex: params.burnIndex,
      sourceBurnAddress: params.burnAddress,
      sweptValueWei: sweptValueWei.toString(),
      txHash,
      createdAt: Date.now(),
    }
    this.store.putRecord(record)
    this.store.setNextIndex(index + 1)

    return { swept: true, record, sweptValueWei }
  }
}

/** Shared params for the "sweep whatever a lease release just spent" helpers below. */
interface SweepAfterReleaseParams {
  changePool: MonadChangePool
  /** Signer for the burn account that was just released -- callers already have this in hand,
   * since it's the same signer used to build/submit the tx whose settlement triggered the release
   * (e.g. `pool.getSigner(handle.index, { provider, httpClient })`). */
  burnAccountSigner: MonadAccountTxSigner
  provider: Provider
  dustThresholdWei?: bigint
  overrides?: MonadTxOverrides
}

/** Attempts a sweep for a just-released burn account record, but only if it actually became
 * `'spent'` (the `'confirmed'` outcome) -- `'retired'` accounts (failed/stuck) are left alone, per
 * this ticket's non-goal of sweeping/reclaiming a `'retired'` account's balance (that's #34's
 * already-flagged, still-open sub-problem, not this ticket's). Never throws: a sweep failure is
 * reported as `{ swept: false, reason: 'sweep-error', error }` rather than propagating, so it can
 * never undo or mask the lease release that already succeeded by the time this runs. */
async function sweepIfSpent(
  record: SubAccountRecord,
  params: SweepAfterReleaseParams,
): Promise<ChangeSweepOutcome | undefined> {
  if (record.status !== 'spent') return undefined
  try {
    return await params.changePool.sweepToChange({
      burnIndex: record.index,
      burnAddress: record.address,
      burnAccountSigner: params.burnAccountSigner,
      provider: params.provider,
      dustThresholdWei: params.dustThresholdWei,
      overrides: params.overrides,
    })
  } catch (error) {
    return { swept: false, reason: 'sweep-error', error }
  }
}

/** Result of `releaseLeaseAndSweepChange`. `sweep` is `undefined` when the release's outcome
 * wasn't `'confirmed'` (nothing to sweep -- see `sweepIfSpent`). */
export interface ReleaseLeaseAndSweepResult {
  record: SubAccountRecord
  sweep: ChangeSweepOutcome | undefined
}

/**
 * Composes `SubAccountLeaseManager.releaseLease` (`monad-account-lease.ts`, ticket #18/#34,
 * untouched by this ticket) with this module's change-sweep logic: release the lease exactly as
 * that method already does, then -- only if the resulting status is `'spent'` -- sweep the burn
 * account's actual leftover balance to the next unused change index and advance the pointer (see
 * `MonadChangePool.sweepToChange`). This is how ticket #36's acceptance criterion 2 ("on releasing
 * a spent burn account, sweep its actual leftover balance") is wired up *without* editing
 * `monad-account-lease.ts` -- see this file's header for why that's possible (both the manual
 * `releaseLease` path here and the polling `awaitLeaseSettlement` path below already return
 * everything needed).
 */
export async function releaseLeaseAndSweepChange(params: {
  manager: SubAccountLeaseManager
  handle: AccountLeaseHandle
  outcome: LeaseOutcome
  /** Omit entirely to just release the lease with no sweep attempt at all (e.g. a caller that
   * doesn't have a change pool wired up yet, or wants to release without sweeping this time). */
  sweep?: SweepAfterReleaseParams
}): Promise<ReleaseLeaseAndSweepResult> {
  const record = params.manager.releaseLease(params.handle, params.outcome)
  if (params.sweep === undefined) {
    return { record, sweep: undefined }
  }
  const sweep = await sweepIfSpent(record, params.sweep)
  return { record, sweep }
}

/** Result of `awaitLeaseSettlementAndSweepChange`: `awaitLeaseSettlement`'s own result, plus the
 * sweep outcome (`undefined` when the settlement outcome wasn't `'confirmed'`). */
export interface AwaitLeaseSettlementAndSweepResult
  extends LeaseSettlementResult {
  sweep: ChangeSweepOutcome | undefined
}

/**
 * Composes `awaitLeaseSettlement` (`monad-account-lease.ts`) with this module's change-sweep
 * logic, the same way `releaseLeaseAndSweepChange` composes with the manual `releaseLease` path --
 * this is the version most real callers want, since `awaitLeaseSettlement` (not a direct
 * `releaseLease` call) is the ticket #18 mechanism that actually detects `'confirmed'` and drives
 * the release in the first place.
 */
export async function awaitLeaseSettlementAndSweepChange(
  params: AwaitLeaseSettlementParams & {
    /** Omit entirely to just await settlement with no sweep attempt at all. */
    sweep?: SweepAfterReleaseParams
  },
): Promise<AwaitLeaseSettlementAndSweepResult> {
  const settlement = await awaitLeaseSettlement(params)
  if (params.sweep === undefined) {
    return { ...settlement, sweep: undefined }
  }
  const sweep = await sweepIfSpent(settlement.record, params.sweep)
  return { ...settlement, sweep }
}
