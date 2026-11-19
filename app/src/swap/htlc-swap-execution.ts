/**
 * Session composition of the HTLC swap runner (docs/plans/htlc-swaps/README.md, "Ownership").
 *
 * Started by `utils/identity-session.ts` when an account's messaging session activates and
 * stopped when it ends, whatever is on screen: the runner watches every accepted negotiation of
 * the session and takes each step itself (A's XEC lock once the accept arrives, B's MON lock,
 * the claims and the refunds). The swap card only reads its snapshot (`swap-execution-state`).
 *
 * It is bound to the session it was started for: the session's EVM wallet (`monad-testnet`),
 * the same account's `xec-testnet` `EcashWallet` (Chronik through the relay's proxy), the
 * account's swap secrets and offer-swapId key, and the session's negotiation journals. A swap in
 * progress is never redirected to another wallet or network; another account or revision starts
 * its own runner.
 *
 * Ownership: the negotiation journal owns the terms, the swap record store
 * (`frank-swap-htlc-v1-<namespace>`) what only this device knows, the wallets their keys and
 * operations, and the chains the outcome. Only the account's active device acts
 * (`stores/leader.ts`); the others observe.
 */
import { ChronikClient } from 'chronik-client'
import { hmacSha256 } from '@frank/crypto-box'
import { toHex } from '@frank/codec'
import { activeChain, type NativeWalletHandle } from '@frank/wallet/chain'
import {
  conversationIdSaltOf,
  swapSecretCapabilityOf,
} from '@frank/wallet/chain/evm-chain'
import {
  evmHtlcSwapCapabilityOf,
  xecHtlcSwapCapabilityOf,
} from '@frank/wallet/swap/htlc-swap-capabilities'
import { appNegotiationIncarnation } from '@frank/swap-protocol/src/host-identity'
import { TESTNET_NEGOTIATION_POLICY } from '@frank/swap-protocol/src/negotiation'
import type { NegotiationJournalInspection } from '@frank/swap-protocol/src/negotiation-journal'
import type {
  EvmHtlcCapability,
  OfferSwapIdKeyedHash,
  SwapSecretCapability,
  XecHtlcCapability,
} from '@frank/swap-protocol/src/htlc-swap'
import {
  HtlcSwapRunner,
  type HtlcSwapRecordStore,
} from '@frank/swap-protocol/src/htlc-swap-runner'
import { BrowserHtlcSwapRecordStore } from '@frank/swap-protocol/src/storage/htlc-swap-browser'
import type { PublicAccount } from '../accounts/custody'
import { openUtxoWallet } from '../accounts/utxo-wallets'
import { useLeaderStore } from '../stores/leader'
import {
  publishSwapExecutionViews,
  resetSwapExecutionState,
  swapExecutionState,
  type SwapExecutionFailure,
} from './swap-execution-state'

/** Runner cadence (plan: ~15 s); a new negotiation event or the page coming back pokes it. */
export const SWAP_RUNNER_INTERVAL_MS = 15_000
/** Pause before opening the wallets again when one could not be opened (relay unreachable). */
export const SWAP_CAPABILITY_RETRY_MS = 30_000
/** Monad: a lock read counts as final this many blocks below the latest (plan, M_evm). */
export const MONAD_HTLC_FINALITY_DEPTH = 10

/** The session's negotiation journals, as its recovery (`utils/negotiation-recovery`) holds them. */
export interface SwapNegotiationSource {
  journals(): readonly NegotiationJournalInspection[]
  /** Called after each recovery pass; optional (the runner also ticks on its own). */
  subscribe?(listener: () => void): () => void
}

export interface SwapRunnerCapabilities {
  readonly xec: XecHtlcCapability
  readonly evm: EvmHtlcCapability
  readonly secrets: SwapSecretCapability
  readonly offerSwapId: OfferSwapIdKeyedHash
}

export interface AppSwapExecutionInput {
  wallet: NativeWalletHandle
  revision: number
  account: unknown
  /** The relay this session uses (its Chronik proxy serves the eCash reads). */
  relayBaseUrl: string
  negotiations: SwapNegotiationSource
  /**
   * Settles once the session has read the account's mailbox for the first time (its device
   * claims included): before that, which device is active is not known, so this device starts
   * no new swap work. It still finishes its own exposed work (`nextAction`).
   */
  activeDeviceKnown?: Promise<unknown>
}

export interface AppSwapExecutionDeps {
  openCapabilities(
    input: AppSwapExecutionInput,
  ): Promise<SwapRunnerCapabilities>
  openStore(
    namespace: string,
  ): HtlcSwapRecordStore & { close?(): Promise<void> }
  /** Names of this origin's IndexedDB databases, or `undefined` where they cannot be listed. */
  listDatabases(): Promise<readonly string[] | undefined>
  isActiveDevice(): boolean
  now(): number
  intervalMs: number
  retryMs: number
}

export interface AppSwapExecution {
  stop(): Promise<void>
  /** A tick soon (tests and hosts; the runner also ticks on its own). */
  poke(): void
}

/** The session's wallets composed into the runner's capabilities. */
export async function openAppSwapCapabilities(
  input: AppSwapExecutionInput,
): Promise<SwapRunnerCapabilities> {
  const { wallet } = input
  if (!activeChain.getHtlcAddress)
    throw new Error('No GenericHTLC on this network')
  const evm = evmHtlcSwapCapabilityOf({
    wallet,
    contract: activeChain.getHtlcAddress(),
    finalityDepth: MONAD_HTLC_FINALITY_DEPTH,
  })
  const secrets = swapSecretCapabilityOf(wallet)
  if (!evm || !secrets) throw new Error('The EVM wallet has no HTLC capability')
  const xecChain = TESTNET_NEGOTIATION_POLICY.xecChainIdentifier
  const { wallet: xecWallet } = await openUtxoWallet(xecChain)
  const relay = input.relayBaseUrl.replace(/\/+$/, '')
  const xec = xecHtlcSwapCapabilityOf({
    wallet: xecWallet,
    chronik: new ChronikClient([`${relay}/chain-rpc/${xecChain}/chronik`]),
    finality: { kind: 'avalanche' },
  })
  if (!xec) throw new Error('The eCash wallet has no HTLC capability')
  return {
    xec,
    evm,
    secrets,
    // Keyed by the account's private salt, read from the live wallet on each use: the same
    // swapId every device of the account derives for its own offers (PR 5 notes).
    offerSwapId: transcript => {
      const salt = conversationIdSaltOf(wallet)
      if (!salt) throw new Error('The account salt is unavailable')
      try {
        return hmacSha256(transcript, salt)
      } finally {
        salt.fill(0)
      }
    },
  }
}

/**
 * Whether this device acts for the account's swaps, once the session's first mailbox read has
 * brought the device claims (`activeDeviceKnown`): when the latest claim names it, or when no
 * device of the account holds a claim at all (nobody else acts, and a background tab nobody
 * touched must still claim and refund in time). A claim naming another device keeps this one
 * observing, even if that device is gone, until the user acts here (which claims).
 */
export function activeForSwaps(leader: {
  masterInstanceId: string | null
  myInstanceId: string
}): boolean {
  return (
    leader.masterInstanceId === null ||
    leader.masterInstanceId === leader.myInstanceId
  )
}

const defaultDeps: AppSwapExecutionDeps = {
  openCapabilities: openAppSwapCapabilities,
  openStore: namespace => {
    if (typeof indexedDB === 'undefined') throw new Error('No IndexedDB')
    return new BrowserHtlcSwapRecordStore(namespace)
  },
  listDatabases: async () => {
    if (typeof indexedDB === 'undefined' || !indexedDB.databases)
      return undefined
    return (await indexedDB.databases()).flatMap(db =>
      db.name ? [db.name] : [],
    )
  },
  isActiveDevice: () => activeForSwaps(useLeaderStore()),
  now: () => Math.floor(Date.now() / 1000),
  intervalMs: SWAP_RUNNER_INTERVAL_MS,
  retryMs: SWAP_CAPABILITY_RETRY_MS,
}

/** The IndexedDB namespace of a wallet's swap records on the active chain. */
export function swapRecordNamespace(input: {
  wallet: NativeWalletHandle
  revision: number
}): string {
  const rawAddress = input.wallet.identity.address?.raw ?? 'default'
  return (
    `${input.wallet.chainIdentifier}:${rawAddress}:${input.revision}`
      .replace(/[^a-zA-Z0-9_:-]/g, '_')
      .slice(0, 128) || 'default'
  )
}

/** The retired execution database of the same namespace (fails start-up clearly; plan §Wire). */
export const retiredExecutionDatabase = (namespace: string) =>
  `frank-swap-execution-v1-${namespace}`

/** The owner every swap record of the session is written under. */
export function appSwapRecordOwner(input: {
  wallet: NativeWalletHandle
  revision: number
  account: unknown
}): { accountIncarnation: string; localPublicKey: Uint8Array } {
  const accountIncarnation = appNegotiationIncarnation(
    input.revision,
    (input.account as PublicAccount).receipt,
  )
  const identity = input.wallet.identity as unknown as {
    compressedPubKey?: Uint8Array
  }
  if (!(identity.compressedPubKey instanceof Uint8Array))
    throw new TypeError('The wallet has no compressed public key')
  return {
    accountIncarnation,
    localPublicKey: new Uint8Array(identity.compressedPubKey),
  }
}

/** A fingerprint of what the journals hold, so a recovery pass that changed nothing does not
 * tick the runner (it scans every few seconds while a negotiation is open). */
function journalsFingerprint(
  journals: readonly NegotiationJournalInspection[],
): string {
  return journals
    .map(
      j =>
        `${toHex(j.context.swapId)}:${j.entries.length}:${
          j.reduction.history.decision ?? ''
        }`,
    )
    .join(',')
}

let current: object | undefined

export function startAppSwapExecution(
  input: AppSwapExecutionInput,
  deps: AppSwapExecutionDeps = defaultDeps,
): AppSwapExecution {
  const mine = {}
  current = mine
  resetSwapExecutionState()
  const live = () => current === mine && !stopped
  let stopped = false
  let runner: HtlcSwapRunner | undefined
  let store: ReturnType<AppSwapExecutionDeps['openStore']> | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  /** Ends a retry wait at once (stop). */
  let wake: (() => void) | undefined
  const cleanups: (() => void)[] = []
  let claimKnown = input.activeDeviceKnown === undefined
  void input.activeDeviceKnown
    ?.catch(() => undefined)
    .then(() => {
      claimKnown = true
      if (live()) runner?.poke()
    })
  const fail = (failure: SwapExecutionFailure, oldDatabase = '') => {
    if (!live()) return
    swapExecutionState.status = 'failed'
    swapExecutionState.failure = failure
    swapExecutionState.oldDatabase = oldDatabase
  }

  const stop = async () => {
    stopped = true
    if (retry !== undefined) clearTimeout(retry)
    wake?.()
    for (const cleanup of cleanups.splice(0)) cleanup()
    // Not awaiting the start: it may be waiting on a wallet that never opens. Everything after
    // each of its waits re-checks `live()`, so no runner is created once stopped; a runner that
    // exists was created synchronously before this stop.
    await runner?.stop()
    await store?.close?.().catch(() => undefined)
    if (current === mine) {
      current = undefined
      resetSwapExecutionState()
    }
  }

  if (
    activeChain.chainIdentifier !==
      TESTNET_NEGOTIATION_POLICY.evmChainIdentifier ||
    input.wallet.chainIdentifier !==
      TESTNET_NEGOTIATION_POLICY.evmChainIdentifier
  )
    return {
      stop: async () => {
        stopped = true
        if (current === mine) current = undefined
      },
      poke: () => undefined,
    }

  swapExecutionState.status = 'starting'
  void (async () => {
    let owner: ReturnType<typeof appSwapRecordOwner>
    try {
      owner = appSwapRecordOwner(input)
    } catch (error) {
      console.error('[swapExecution] swap record owner unavailable:', error)
      return fail('account-unavailable')
    }
    const namespace = swapRecordNamespace(input)
    const old = retiredExecutionDatabase(namespace)
    const databases = await deps.listDatabases().catch(() => undefined)
    if (!live()) return
    if (databases?.includes(old)) {
      console.error(
        `[swapExecution] Retired swap execution records found. Delete the IndexedDB database "${old}" (developer tools → Application → IndexedDB) and reload; HTLC swaps do not run until then.`,
      )
      return fail('old-execution-records', old)
    }
    let records: HtlcSwapRecordStore
    try {
      records = store = deps.openStore(namespace)
    } catch (error) {
      console.error('[swapExecution] swap records unavailable:', error)
      return fail('storage-unavailable')
    }
    let capabilities: SwapRunnerCapabilities | undefined
    while (live()) {
      try {
        capabilities = await deps.openCapabilities(input)
        break
      } catch (error) {
        if (!live()) return
        console.warn('[swapExecution] swap wallets unavailable:', error)
        swapExecutionState.failure = 'wallet-unavailable'
        await new Promise<void>(resolve => {
          wake = resolve
          retry = setTimeout(resolve, deps.retryMs)
        })
        retry = undefined
        wake = undefined
      }
    }
    if (!capabilities || !live()) return
    const isActiveDevice = () => {
      const active = claimKnown && deps.isActiveDevice()
      swapExecutionState.activeDevice = active
      return active
    }
    runner = new HtlcSwapRunner({
      owner,
      negotiations: {
        list: async () =>
          input.negotiations
            .journals()
            .map(j => ({ context: j.context, reduction: j.reduction })),
      },
      store: records,
      ...capabilities,
      clock: { now: deps.now },
      isActiveDevice,
      onError: (swapId, error) =>
        console.warn(`[swapExecution] swap ${swapId}:`, error),
    })
    const started = runner
    cleanups.push(
      started.subscribe(views => {
        if (live()) publishSwapExecutionViews(views)
      }),
    )
    let fingerprint = journalsFingerprint(input.negotiations.journals())
    const off = input.negotiations.subscribe?.(() => {
      const next = journalsFingerprint(input.negotiations.journals())
      if (next === fingerprint) return
      fingerprint = next
      started.poke()
    })
    if (off) cleanups.push(off)
    if (typeof document !== 'undefined' && document.addEventListener) {
      const visible = () => {
        if (document.visibilityState !== 'hidden') started.poke()
      }
      document.addEventListener('visibilitychange', visible)
      cleanups.push(() =>
        document.removeEventListener('visibilitychange', visible),
      )
    }
    swapExecutionState.status = 'ready'
    swapExecutionState.failure = null
    started.start(deps.intervalMs)
  })().catch(error =>
    console.error('[swapExecution] swap runner did not start:', error),
  )

  return {
    stop,
    poke: () => runner?.poke(),
  }
}
