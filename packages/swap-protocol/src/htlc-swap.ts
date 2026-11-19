/**
 * The HTLC swap's pure core (docs/plans/htlc-swaps/README.md): the capability contracts the
 * runner composes, the terms both parties execute (from the signed negotiation), the swap
 * record format, and `nextAction`, which decides from (journal, record, chain observations,
 * now) what the runner does next. No clock, storage, network or wallet here.
 *
 * Neither party sends anything after the accept: both compute the lock identities from the
 * signed terms (XEC: the P2SH script of the terms; EVM: `lockIdOf(B, terms)`) and find the
 * locks on chain. The chain is re-read every tick and never persisted as authority.
 */
import { sha256 } from '@noble/hashes/sha256.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import type { SwapResult } from './index'
import {
  deriveOfferSwapId,
  negotiationDeadlineRules,
  negotiationTermsHash,
  type AcceptTerms,
  type NegotiationContext,
  type NegotiationDeadlineRules,
  type NegotiationPairPolicy,
  type NegotiationReduction,
  type OfferTerms,
} from './negotiation'

/** The fixed fee of an eCash HTLC claim or refund (packages/wallet/ecash-htlc.ts). */
export const XEC_HTLC_SPEND_FEE_SATS = 1000n

// ---------------------------------------------------------------------------------------------
// Capabilities. Declared here, implemented by the wallet and composed by the host; this package
// never imports @frank/wallet (runtime-boundary.jest.test.ts).
// ---------------------------------------------------------------------------------------------

/** Unix seconds of this device's clock. */
export interface Clock {
  now(): number
}

/** A's swap secret: `frank/swap-htlc-preimage/v1` (PR 4); the same shape the wallet exports. */
export interface SwapSecretCapability {
  swapPreimage(input: {
    readonly policyName: string
    readonly swapId: Uint8Array
  }): Uint8Array
}

/** The 32-byte keyed hash of an offer swapId transcript under the account's private salt. */
export type OfferSwapIdKeyedHash = (transcript: Uint8Array) => Uint8Array

export type XecHtlcBranch = 'claim' | 'refund'

/** The eCash HTLC's terms: what its redeem script commits to. */
export interface XecHtlcTerms {
  readonly hashLock: Uint8Array
  readonly claimPublicKey: Uint8Array
  readonly refundPublicKey: Uint8Array
  /** T_A (Unix seconds); refund is valid once the tip's median-time-past exceeds it. */
  readonly refundTime: number
}

/** One output paying the HTLC's P2SH script, as the eCash indexer reports it. */
export interface XecHtlcOutputObservation {
  readonly txid: string
  readonly vout: number
  readonly valueSats: bigint
  /** Final under the network's finality rule (Avalanche on testnet). */
  readonly final: boolean
  readonly spentBy?: {
    readonly txid: string
    /** `claim` when the spend reveals the preimage of these terms, otherwise `refund`. */
    readonly branch: XecHtlcBranch
    readonly final: boolean
  }
}

export interface XecHtlcObservation {
  /** Median-time-past of the tip block. */
  readonly tipMedianTime: number
  /** Every output (mempool and mined) paying the HTLC script. */
  readonly outputs: readonly XecHtlcOutputObservation[]
}

/** A's funding operation `swap:<swapId>:xec-lock` in the eCash wallet's ledger. */
export type XecLockOperationState =
  | 'prepared'
  | 'exposed'
  | 'submitted'
  | 'confirmed'
  | 'released'
  /** A final transaction spent one of its inputs: its bytes can never land. Funding again
   * signs the same lock from fresh inputs, under the same id and cutoff. */
  | 'conflicted'

export interface XecHtlcCapability {
  readonly chainIdentifier: string
  /** This account's per-swap key ("claim" for B, "refund" for A); public only. */
  htlcPublicKey(swapId: string, role: XecHtlcBranch): Uint8Array
  observe(terms: XecHtlcTerms): Promise<XecHtlcObservation>
  /** The state of `swap:<swapId>:xec-lock` in this wallet; undefined when there is none. */
  lockOperation(swapId: string): Promise<XecLockOperationState | undefined>
  /**
   * Funds the HTLC with exactly `principalSats + XEC_HTLC_SPEND_FEE_SATS` through the native
   * operation `swap:<swapId>:xec-lock`. Idempotent: an existing operation is resumed (its same
   * bytes re-submitted), never a second funding; a released one is refused. A conflicted one
   * (its bytes can never land) is signed again from fresh inputs, unless the transaction that
   * took its input itself pays the HTLC script: then nothing is signed and the result says
   * `fundedElsewhere` with that transaction's id.
   */
  fund(input: {
    readonly swapId: string
    readonly terms: XecHtlcTerms
    readonly principalSats: bigint
  }): Promise<{ readonly txid: string; readonly fundedElsewhere?: true }>
  /** Releases a `prepared` lock operation that was never exposed. */
  releaseLock(swapId: string): Promise<void>
  /** Signs the claim or refund spend: deterministic bytes, nothing broadcast. */
  signSpend(input: {
    readonly swapId: string
    readonly terms: XecHtlcTerms
    readonly funding: { readonly txid: string; readonly vout: number }
    readonly principalSats: bigint
    readonly branch: XecHtlcBranch
    readonly preimage?: Uint8Array
  }): Promise<{ readonly rawTx: string; readonly txid: string }>
  /** Hands signed bytes to the network; a transaction it already has is success. */
  broadcast(rawTx: string): Promise<void>
}

/** The EVM lock as `locks(lockId)` reports it. */
export interface EvmHtlcLockView {
  readonly state: 'open' | 'withdrawn' | 'refunded'
  /** The preimage the lock was withdrawn with. */
  readonly preimage: Uint8Array | null
}

export interface EvmHtlcObservation {
  /** At the latest block; null when there is no such lock. */
  readonly latest: EvmHtlcLockView | null
  /** At the network's final block (latest − depth, or `finalized`). */
  readonly final: EvmHtlcLockView | null
  /** block.timestamp of the latest block. */
  readonly blockTimestamp: number
  /** GenericHTLC `owed(mainAccount, native)`. */
  readonly owedWei: bigint
  /** The main account's balance and the cost of one HTLC call, for the claim-gas warning. */
  readonly mainBalanceWei: bigint
  readonly callCostWei: bigint
}

export type EvmHtlcCallState = 'pending' | 'landed' | 'reverted' | 'ended'
/** An HTLC call this wallet made (the native journal's `htlc` record is the authority). */
export interface EvmHtlcOwnCall {
  readonly action: 'lock' | 'withdraw' | 'refund'
  readonly operationId: string
  readonly state: EvmHtlcCallState
  /** Whether the call was ever signed: a call journaled but never signed (a crash before
   * signing, a cancelled plan) cannot have shown its calldata to anyone. */
  readonly signed: boolean
}

export interface EvmHtlcLockTerms {
  readonly recipient: string
  readonly refundAddress: string
  readonly amount: bigint
  readonly hashLock: string
  readonly expiresAt: number
}

export interface EvmHtlcCapability {
  readonly chainIdentifier: string
  /** The account GenericHTLC calls are sent from (lowercase 0x hex). */
  mainAccount(): string
  /** This network's GenericHTLC (registry deployment, or the regtest run's injected one). */
  htlcContract(): string
  observe(lockId: string): Promise<EvmHtlcObservation>
  /** This wallet's HTLC calls for the swap, from its native journal. */
  ownCalls(swapId: string): Promise<readonly EvmHtlcOwnCall[]>
  /** `deadline` (block-time seconds, the runner's cutoff): the wallet gives the call up once the
   * chain passes it rather than landing it late. */
  lock(input: {
    readonly swapId: string
    readonly lockId: string
    readonly terms: EvmHtlcLockTerms
    readonly deadline: number
  }): Promise<{ readonly operationId: string }>
  withdraw(input: {
    readonly swapId: string
    readonly lockId: string
    readonly preimage: Uint8Array
    readonly deadline: number
  }): Promise<{ readonly operationId: string }>
  refund(input: {
    readonly swapId: string
    readonly lockId: string
  }): Promise<{ readonly operationId: string }>
  claimOwed(): Promise<void>
}

// ---------------------------------------------------------------------------------------------
// Terms.
// ---------------------------------------------------------------------------------------------

export type HtlcSwapRole = 'A' | 'B'

/** What both parties execute, read from the signed offer and accept. */
export interface HtlcSwapTerms {
  readonly policy: NegotiationPairPolicy
  readonly rules: NegotiationDeadlineRules
  /** Lowercase hex. */
  readonly swapId: string
  readonly conversationId: string
  readonly termsHash: string
  /** E, T_B, T_A (Unix seconds). */
  readonly acceptBy: number
  readonly evmExpiry: number
  readonly xecRefundTime: number
  readonly xec: {
    readonly principalSats: bigint
    readonly fundingValueSats: bigint
    readonly terms: XecHtlcTerms
  }
  readonly evm: {
    readonly contract: string
    readonly lockId: string
    readonly sender: string
    readonly terms: EvmHtlcLockTerms
  }
}

const hex = bytesToHex
const address = (value: Uint8Array) => `0x${hex(value)}`
const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i])

function word(value: Uint8Array | bigint): Uint8Array {
  const out = new Uint8Array(32)
  if (typeof value === 'bigint') {
    let rest = value
    for (let i = 31; i >= 0; i--) {
      out[i] = Number(rest & 0xffn)
      rest >>= 8n
    }
  } else out.set(value, 32 - value.length)
  return out
}

/** GenericHTLC `lockIdOf`: keccak256(abi.encode(sender, recipient, refund, token, amount,
 * hashLock, expiresAt)), the token being the native coin (zero address). */
export function htlcLockIdOf(sender: string, terms: EvmHtlcLockTerms): string {
  const addr = (value: string) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(value))
      throw new Error('EVM address must be 20 bytes of 0x hex')
    return hexToBytes(value.slice(2))
  }
  if (!/^0x[0-9a-f]{64}$/.test(terms.hashLock))
    throw new Error('EVM hash lock must be 32 bytes of lowercase 0x hex')
  const encoded = new Uint8Array(32 * 7)
  ;[
    word(addr(sender)),
    word(addr(terms.recipient)),
    word(addr(terms.refundAddress)),
    word(new Uint8Array(20)),
    word(terms.amount),
    hexToBytes(terms.hashLock.slice(2)),
    word(BigInt(terms.expiresAt)),
  ].forEach((part, i) => encoded.set(part, 32 * i))
  return `0x${hex(keccak_256(encoded))}`
}

function unwrap<T>(value: SwapResult<T>): T {
  if (!value.ok) throw new Error(value.error.detail ?? value.error.code)
  return value.value
}

/** The executable terms of an accepted swap. */
export function htlcSwapTermsOf(input: {
  readonly context: NegotiationContext
  readonly reduction: NegotiationReduction
}): HtlcSwapTerms {
  const { context, reduction } = input
  const acceptance = reduction.usableAcceptance
  const offerEvent = reduction.history.offer
  if (!acceptance || !offerEvent) throw new Error('Swap is not accepted')
  const offer: OfferTerms = acceptance.offer
  const accept: AcceptTerms = acceptance.accept
  const sender = address(accept.evmSender)
  const evmTerms: EvmHtlcLockTerms = {
    recipient: address(offer.evmRecipient),
    refundAddress: sender,
    amount: offer.evmPrincipal,
    hashLock: `0x${hex(offer.hashLock)}`,
    expiresAt: Number(offer.evmExpiry),
  }
  return Object.freeze({
    policy: context.policy,
    rules: unwrap(negotiationDeadlineRules(context.policy)),
    swapId: hex(context.swapId),
    conversationId: hex(context.conversationId),
    termsHash: hex(unwrap(negotiationTermsHash(offerEvent))),
    acceptBy: Number(offer.expiry),
    evmExpiry: Number(offer.evmExpiry),
    xecRefundTime: Number(offer.xecRefundTime),
    xec: Object.freeze({
      principalSats: offer.xecPrincipal,
      fundingValueSats: offer.xecPrincipal + XEC_HTLC_SPEND_FEE_SATS,
      terms: Object.freeze({
        hashLock: new Uint8Array(offer.hashLock),
        claimPublicKey: new Uint8Array(accept.xecClaimPublicKey),
        refundPublicKey: new Uint8Array(offer.xecRefundPublicKey),
        refundTime: Number(offer.xecRefundTime),
      }),
    }),
    evm: Object.freeze({
      contract: address(offer.evmHtlcContract),
      lockId: htlcLockIdOf(sender, evmTerms),
      sender,
      terms: Object.freeze(evmTerms),
    }),
  })
}

/**
 * This account's role in a negotiation, or why it has none. Party 0 is A only when the swapId
 * re-derives from the offer's own facts under this account's keyed hash (PR 4/5): being party 0
 * of a journal is not proof of authorship, and the swap secret is asked for no other swapId.
 */
export function resolveHtlcSwapRole(input: {
  readonly context: NegotiationContext
  readonly offer: OfferTerms
  readonly localPublicKey: Uint8Array
  readonly offerSwapId: OfferSwapIdKeyedHash
}):
  | { readonly role: HtlcSwapRole }
  | { readonly role: null; readonly reason: string } {
  const { context, offer } = input
  if (equalBytes(context.parties[1], input.localPublicKey)) return { role: 'B' }
  if (!equalBytes(context.parties[0], input.localPublicKey))
    return { role: null, reason: 'This account is not a party' }
  const derived = deriveOfferSwapId(
    {
      policy: context.policy,
      conversationId: context.conversationId,
      parties: context.parties,
      xecPrincipal: offer.xecPrincipal,
      evmPrincipal: offer.evmPrincipal,
      expiry: offer.expiry,
      xecRefundTime: offer.xecRefundTime,
      evmExpiry: offer.evmExpiry,
      evmRecipient: offer.evmRecipient,
      evmHtlcContract: offer.evmHtlcContract,
    },
    input.offerSwapId,
  )
  if (!derived.ok || !equalBytes(derived.value, context.swapId))
    return {
      role: null,
      reason: 'The swapId is not the one this account derives from the offer',
    }
  return { role: 'A' }
}

// ---------------------------------------------------------------------------------------------
// Swap record (store `frank-swap-htlc-v1-<ns>`): the local facts the chain cannot give back.
// ---------------------------------------------------------------------------------------------

export interface HtlcSwapRecord {
  readonly version: 1
  readonly swapId: string
  readonly conversationId: string
  readonly owner: {
    readonly accountIncarnation: string
    readonly localPublicKey: string
  }
  readonly role: HtlcSwapRole
  readonly termsHash: string
  /** When this device first acted on the swap's funding authorization (A's offer, B's accept). */
  readonly fundingAuthorizedAt?: number
  /** A only: `swap:<swapId>:xec-lock`, written before the funding is prepared. */
  readonly xecLockOperationId?: string
  /** The signed eCash claims (B) or refunds (A), one per funding output, each written before it
   * is broadcast; sorted by outpoint. */
  readonly xecSpends?: readonly HtlcSwapXecSpend[]
}

export interface HtlcSwapXecSpend {
  readonly funding: { readonly txid: string; readonly vout: number }
  readonly branch: XecHtlcBranch
  readonly rawTx: string
  readonly txid: string
}

/** At most this many funding outputs of one swap get a signed spend in its record. */
export const HTLC_SWAP_MAX_XEC_SPENDS = 16

export const outpointKey = (funding: { txid: string; vout: number }) =>
  `${funding.txid}:${String(funding.vout).padStart(10, '0')}`

/** The record's signed spend of `funding`, if there is one. */
export function storedXecSpendOf(
  record: HtlcSwapRecord | undefined,
  funding: { txid: string; vout: number },
): HtlcSwapXecSpend | undefined {
  return record?.xecSpends?.find(
    s => s.funding.txid === funding.txid && s.funding.vout === funding.vout,
  )
}

export const HTLC_SWAP_RECORD_MAX_BYTES = 16384
const RECORD_KEYS = new Set([
  'version',
  'swapId',
  'conversationId',
  'owner',
  'role',
  'termsHash',
  'fundingAuthorizedAt',
  'xecLockOperationId',
  'xecSpends',
])

function fail(detail: string): never {
  throw new Error(`Invalid HTLC swap record: ${detail}`)
}
const isHex = (value: unknown, bytes: number) =>
  typeof value === 'string' &&
  value.length === bytes * 2 &&
  /^[0-9a-f]*$/.test(value)

/** Strict parse: unknown keys, versions or malformed fields fail (no compatibility reader). */
export function parseHtlcSwapRecord(raw: string): HtlcSwapRecord {
  if (typeof raw !== 'string' || raw.length > HTLC_SWAP_RECORD_MAX_BYTES)
    fail('size')
  let value: Record<string, unknown>
  try {
    value = JSON.parse(raw)
  } catch {
    fail('not JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail('not an object')
  for (const key of Object.keys(value))
    if (!RECORD_KEYS.has(key)) fail(`unknown field ${key}`)
  if (value.version !== 1) fail('version')
  if (!isHex(value.swapId, 32)) fail('swapId')
  if (!isHex(value.conversationId, 16)) fail('conversationId')
  if (!isHex(value.termsHash, 32)) fail('termsHash')
  if (value.role !== 'A' && value.role !== 'B') fail('role')
  const owner = value.owner as Record<string, unknown> | null
  if (
    typeof owner !== 'object' ||
    owner === null ||
    Object.keys(owner).length !== 2 ||
    typeof owner.accountIncarnation !== 'string' ||
    owner.accountIncarnation.length === 0 ||
    owner.accountIncarnation.length > 256 ||
    !isHex(owner.localPublicKey, 33)
  )
    fail('owner')
  if (
    value.fundingAuthorizedAt !== undefined &&
    (!Number.isSafeInteger(value.fundingAuthorizedAt) ||
      (value.fundingAuthorizedAt as number) < 0)
  )
    fail('fundingAuthorizedAt')
  if (
    value.xecLockOperationId !== undefined &&
    (value.role !== 'A' ||
      value.xecLockOperationId !== `swap:${value.swapId}:xec-lock`)
  )
    fail('xecLockOperationId')
  if (value.xecSpends !== undefined) {
    const spends = value.xecSpends as unknown
    if (
      !Array.isArray(spends) ||
      spends.length === 0 ||
      spends.length > HTLC_SWAP_MAX_XEC_SPENDS
    )
      fail('xecSpends')
    let previous = ''
    for (const entry of spends as unknown[]) {
      const spend = entry as Record<string, unknown> | null
      const funding = spend?.funding as Record<string, unknown> | undefined
      if (
        typeof spend !== 'object' ||
        spend === null ||
        Object.keys(spend).length !== 4 ||
        typeof funding !== 'object' ||
        funding === null ||
        Object.keys(funding).length !== 2 ||
        !isHex(funding.txid, 32) ||
        !Number.isSafeInteger(funding.vout) ||
        (funding.vout as number) < 0 ||
        (funding.vout as number) > 0xffffffff ||
        spend.branch !== (value.role === 'A' ? 'refund' : 'claim') ||
        typeof spend.rawTx !== 'string' ||
        !/^(?:[0-9a-f]{2})+$/.test(spend.rawTx) ||
        !isHex(spend.txid, 32)
      )
        fail('xecSpends')
      const key = outpointKey(funding as { txid: string; vout: number })
      if (key <= previous) fail('xecSpends order')
      previous = key
    }
  }
  return value as unknown as HtlcSwapRecord
}

/** Canonical bytes of a record (fixed key order). */
export function serializeHtlcSwapRecord(record: HtlcSwapRecord): string {
  const ordered: Record<string, unknown> = {
    version: 1,
    swapId: record.swapId,
    conversationId: record.conversationId,
    owner: {
      accountIncarnation: record.owner.accountIncarnation,
      localPublicKey: record.owner.localPublicKey,
    },
    role: record.role,
    termsHash: record.termsHash,
  }
  if (record.fundingAuthorizedAt !== undefined)
    ordered.fundingAuthorizedAt = record.fundingAuthorizedAt
  if (record.xecLockOperationId !== undefined)
    ordered.xecLockOperationId = record.xecLockOperationId
  if (record.xecSpends !== undefined)
    ordered.xecSpends = record.xecSpends
      .slice()
      .sort((a, b) =>
        outpointKey(a.funding) < outpointKey(b.funding) ? -1 : 1,
      )
      .map(spend => ({
        funding: { txid: spend.funding.txid, vout: spend.funding.vout },
        branch: spend.branch,
        rawTx: spend.rawTx,
        txid: spend.txid,
      }))
  const raw = JSON.stringify(ordered)
  parseHtlcSwapRecord(raw)
  return raw
}

export const xecLockOperationIdOf = (swapId: string) =>
  `swap:${swapId}:xec-lock`

// ---------------------------------------------------------------------------------------------
// nextAction.
// ---------------------------------------------------------------------------------------------

export type HtlcSwapPhase =
  // Before or without an accept (both roles).
  | 'offered'
  | 'offerReceived'
  | 'rejected'
  | 'expired'
  // A.
  | 'accepted'
  | 'xecLockPending'
  | 'xecLocked'
  | 'claiming'
  | 'claimed'
  | 'claimedByPeer'
  | 'awaitRefund'
  // B.
  | 'awaitXecLock'
  | 'locking'
  | 'evmLocked'
  | 'claimingXec'
  | 'complete'
  | 'lostToRefund'
  // Both.
  | 'abandoned'
  | 'refunding'
  | 'refunded'

export type HtlcSwapAction =
  | { readonly kind: 'none' }
  /** A: write the authorization and `xecLockOperationId`, then fund the lock. `resume`: the
   * lock's bytes were already exposed; they are re-submitted whatever the clock says. */
  | { readonly kind: 'fund-xec'; readonly resume: boolean }
  /** A: the lock was prepared but never exposed, and the funding cutoff has passed. */
  | { readonly kind: 'release-xec-lock' }
  /** B: write the authorization, then lock MON; the call is given up after `deadline`. */
  | { readonly kind: 'lock-evm'; readonly deadline: number }
  /** A: withdraw MON with the preimage; the call is given up after `deadline`. */
  | { readonly kind: 'withdraw-evm'; readonly deadline: number }
  /** B: refund MON after T_B. */
  | { readonly kind: 'refund-evm' }
  /** Sign the eCash claim (B, with the preimage read from the EVM lock) or refund (A), write
   * it to the record, then broadcast it. */
  | {
      readonly kind: 'sign-xec-spend'
      readonly branch: XecHtlcBranch
      readonly funding: { readonly txid: string; readonly vout: number }
      readonly preimage?: Uint8Array
    }
  /** Hand the record's signed spend of `funding` to the network again. */
  | {
      readonly kind: 'broadcast-xec-spend'
      readonly funding: { readonly txid: string; readonly vout: number }
    }
  | { readonly kind: 'claim-owed' }

export type HtlcSwapWarning =
  /** A: the EVM main account holds less than one HTLC call's gas, for the withdraw. */
  | 'claim-gas-low'
  /** B: the EVM main account holds less than the lock amount plus one HTLC call's gas while the
   * MON lock is still to be sent (`lockFunds` says how much more, and by when). */
  | 'lock-funds-low'
  | 'xec-double-funded'
  /** Something other than an exact funding already pays the HTLC script: A does not fund. */
  | 'xec-foreign-output'

export interface HtlcSwapDecision {
  readonly phase: HtlcSwapPhase
  readonly action: HtlcSwapAction
  readonly warnings: readonly HtlcSwapWarning[]
  /** The funding output the decision is about, when there is one. */
  readonly funding?: { readonly txid: string; readonly vout: number }
  /** With `lock-funds-low`: what the main account lacks for B's lock (amount plus gas), and the
   * lock cutoff it must be there by. A precheck only: nothing is moved there automatically. */
  readonly lockFunds?: {
    readonly shortfallWei: bigint
    readonly lockBy: number
  }
}

export interface HtlcSwapObservations {
  readonly xec: XecHtlcObservation
  readonly evm: EvmHtlcObservation
  /** A only: this wallet's `swap:<swapId>:xec-lock`. */
  readonly xecLockOperation?: XecLockOperationState
  readonly evmCalls: readonly EvmHtlcOwnCall[]
}

export type HtlcSwapDecisionInput = {
  readonly role: HtlcSwapRole
  /** Unix seconds of this device's clock. */
  readonly now: number
  readonly record?: HtlcSwapRecord
  /** Only the account's active device starts new work. Another device still finishes what it
   * already authorized and exposed itself: it resumes its own exposed lock operation and
   * re-broadcasts the spends in its own record (`stores/leader.ts`: finishing authorized work is
   * never gated); everything else it only observes. */
  readonly activeDevice: boolean
} & (
  | { readonly negotiation: 'offered'; readonly acceptBy: number }
  | { readonly negotiation: 'rejected' }
  | {
      readonly negotiation: 'accepted'
      readonly terms: HtlcSwapTerms
      readonly observations: HtlcSwapObservations
    }
)

/** Cutoffs, seconds before T_B (plan "Deadline rules"). */
export function htlcSwapCutoffs(terms: HtlcSwapTerms) {
  const r = terms.rules
  return {
    /** A funds XEC only while now ≤ this. */
    xecFundBy:
      terms.evmExpiry - (r.xecFinality + r.xecTimeSkew + r.watcherDowntime),
    /** B locks MON only while now ≤ this. */
    evmLockBy: terms.evmExpiry - r.evmLockMargin,
    /** A withdraws only while now ≤ this. */
    evmWithdrawBy: terms.evmExpiry - r.evmFinality,
  }
}

/** Calls that reverted this many times are not sent again automatically. */
export const HTLC_CALL_MAX_REVERTS = 2

const NONE: HtlcSwapAction = Object.freeze({ kind: 'none' })

/** The exact-value funding outputs: unspent first, then by txid:vout (deterministic). */
function fundingOf(
  terms: HtlcSwapTerms,
  xec: XecHtlcObservation,
): readonly XecHtlcOutputObservation[] {
  return xec.outputs
    .filter(o => o.valueSats === terms.xec.fundingValueSats)
    .slice()
    .sort(
      (a, b) =>
        Number(a.spentBy !== undefined) - Number(b.spentBy !== undefined) ||
        (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.vout - b.vout),
    )
}

function calls(
  observations: HtlcSwapObservations,
  action: EvmHtlcOwnCall['action'],
) {
  const mine = observations.evmCalls.filter(c => c.action === action)
  return {
    /** A call that was signed: its calldata may have reached the network. */
    signed: mine.some(c => c.signed),
    pending: mine.some(c => c.state === 'pending'),
    landed: mine.some(c => c.state === 'landed'),
    reverts: mine.filter(c => c.state === 'reverted').length,
  }
}

const outpointOf = (o: XecHtlcOutputObservation) => ({
  txid: o.txid,
  vout: o.vout,
})

/**
 * The next eCash spend among `candidates` (unspent exact outputs, in order): sign the first one
 * the record has no spend for, else re-broadcast the first stored one. Signing first keeps one
 * output whose stored spend the network refuses from holding up the others.
 */
function xecSpendAction(
  candidates: readonly XecHtlcOutputObservation[],
  record: HtlcSwapRecord | undefined,
  branch: XecHtlcBranch,
  preimage: Uint8Array | null | undefined,
  /** False on an inactive device: it signs nothing new and only re-broadcasts a spend it
   * already stored for one of these same candidates. */
  maySign: boolean,
): HtlcSwapAction {
  if (!maySign) {
    const stored = candidates.find(o => storedXecSpendOf(record, o))
    return stored
      ? { kind: 'broadcast-xec-spend', funding: outpointOf(stored) }
      : NONE
  }
  const unsigned = candidates.find(o => !storedXecSpendOf(record, o))
  if (unsigned)
    return {
      kind: 'sign-xec-spend',
      branch,
      funding: outpointOf(unsigned),
      ...(preimage ? { preimage } : {}),
    }
  const first = candidates[0]
  return first
    ? { kind: 'broadcast-xec-spend', funding: outpointOf(first) }
    : NONE
}

/**
 * What the runner does next for one swap. Pure: every input is passed in. Cutoffs pass when
 * either this device's clock or the EVM chain's says so; the refund branches follow the chains'
 * own clocks (MTP > T_A for eCash, block.timestamp ≥ T_B for EVM).
 *
 * Every exact-value output at the HTLC script is a separate fund: B claims each one it can once
 * the preimage is public, and A refunds each one after MTP > T_A, except that once A's withdraw
 * landed one output stays for B until B has claimed one.
 */
export function nextAction(input: HtlcSwapDecisionInput): HtlcSwapDecision {
  /** What an inactive device still does of `action`: only finishing its own exposed work. */
  // The eCash spends already follow the same candidate rules on an inactive device
  // (`xecSpendAction` with `maySign` false: only its own stored spend of a candidate).
  const finishing = (action: HtlcSwapAction): HtlcSwapAction => {
    if (action.kind === 'fund-xec') return action.resume ? action : NONE
    if (action.kind === 'broadcast-xec-spend') return action
    return NONE
  }
  const decide = (
    phase: HtlcSwapPhase,
    action: HtlcSwapAction = NONE,
    warnings: HtlcSwapWarning[] = [],
    funding?: { txid: string; vout: number },
    lockFunds?: { shortfallWei: bigint; lockBy: number },
  ): HtlcSwapDecision => ({
    phase,
    action: input.activeDevice ? action : finishing(action),
    warnings,
    ...(funding ? { funding } : {}),
    ...(lockFunds ? { lockFunds } : {}),
  })
  if (input.negotiation === 'rejected') return decide('rejected')
  if (input.negotiation === 'offered')
    return decide(
      input.now >= input.acceptBy
        ? 'expired'
        : input.role === 'A'
        ? 'offered'
        : 'offerReceived',
    )
  const { terms, observations, record } = input
  const { xec, evm } = observations
  const now = Math.max(input.now, evm.blockTimestamp)
  const cut = htlcSwapCutoffs(terms)
  const exact = fundingOf(terms, xec)
  const output = exact[0]
  const unspent = exact.filter(o => o.spentBy === undefined)
  const claimed = exact.filter(o => o.spentBy?.branch === 'claim')
  const refunded = exact.filter(o => o.spentBy?.branch === 'refund')
  const warnings: HtlcSwapWarning[] =
    exact.length > 1 ? ['xec-double-funded'] : []
  const funding = output ? outpointOf(output) : undefined
  const owed =
    evm.owedWei > 0n
      ? ({ kind: 'claim-owed' } as const)
      : (NONE as HtlcSwapAction)
  const mtpPassed = xec.tipMedianTime > terms.xecRefundTime

  if (input.role === 'A') {
    const withdraw = calls(observations, 'withdraw')
    // A landed withdraw is known from the chain or from A's own journal: a lagging node that
    // still shows the lock open must never lead A to refund after revealing the preimage.
    const withdrawn = evm.latest?.state === 'withdrawn' || withdraw.landed
    if (!withdrawn && evm.mainBalanceWei < evm.callCostWei)
      warnings.push('claim-gas-low')
    if (withdrawn) {
      // A never refunds what B is owed: until a claim of B's is final, the first unspent one
      // stays for B (a claim still in the mempool can lose to a refund of its output). Any
      // other exact output is A's own extra funding, refundable after T_A.
      const refundable = mtpPassed
        ? claimed.some(o => o.spentBy!.final)
          ? unspent
          : unspent.slice(1)
        : []
      return decide(
        'claimed',
        refundable.length > 0
          ? xecSpendAction(
              refundable,
              record,
              'refund',
              undefined,
              input.activeDevice,
            )
          : owed,
        warnings,
        funding,
      )
    }
    const peerClaimed = claimed.length > 0
    const lockOpen = evm.latest?.state === 'open'
    // Once a withdraw was sent (it may have reverted, been given up or still be pending) or B
    // claimed, the preimage may be public: A then withdraws for as long as the lock can pay,
    // whatever the margin or earlier reverts.
    const secretPublic = peerClaimed || withdraw.signed
    const withdrawDeadline = secretPublic
      ? terms.evmExpiry - 1
      : cut.evmWithdrawBy
    const canWithdraw =
      lockOpen &&
      !withdraw.pending &&
      ((secretPublic && now < terms.evmExpiry) ||
        (evm.final?.state === 'open' &&
          now <= cut.evmWithdrawBy &&
          withdraw.reverts < HTLC_CALL_MAX_REVERTS))
    // A withdraw in flight can still land until block.timestamp reaches T_B.
    const withdrawInFlight =
      withdraw.pending && evm.blockTimestamp < terms.evmExpiry
    const claiming = peerClaimed ? 'claimedByPeer' : 'claiming'

    if (!output) {
      const op = observations.xecLockOperation
      if (op === 'exposed' || op === 'submitted' || op === 'confirmed')
        return decide(
          'xecLockPending',
          { kind: 'fund-xec', resume: true },
          warnings,
        )
      if (op === 'released') return decide('abandoned', NONE, warnings)
      // An output at the script that is not the exact lock: never fund (again) next to it.
      if (
        xec.outputs.length > 0 &&
        (op === undefined || op === 'prepared' || op === 'conflicted')
      ) {
        warnings.push('xec-foreign-output')
        if (op === 'prepared' && now > cut.xecFundBy)
          return decide('abandoned', { kind: 'release-xec-lock' }, warnings)
        return decide(
          op === undefined ? 'accepted' : 'xecLockPending',
          NONE,
          warnings,
        )
      }
      if (now > cut.xecFundBy)
        return decide(
          'abandoned',
          op === 'prepared' ? { kind: 'release-xec-lock' } : NONE,
          warnings,
        )
      // A conflicted lock never landed and never will: before the cutoff it is funded again.
      return decide(
        op === 'prepared' ||
          op === 'conflicted' ||
          record?.fundingAuthorizedAt !== undefined
          ? 'xecLockPending'
          : 'accepted',
        { kind: 'fund-xec', resume: false },
        warnings,
      )
    }
    if (canWithdraw)
      return decide(
        claiming,
        { kind: 'withdraw-evm', deadline: withdrawDeadline },
        warnings,
        funding,
      )
    if (withdrawInFlight) return decide(claiming, NONE, warnings, funding)
    if (mtpPassed && unspent.length > 0)
      return decide(
        peerClaimed ? 'claimedByPeer' : 'refunding',
        xecSpendAction(
          unspent,
          record,
          'refund',
          undefined,
          input.activeDevice,
        ),
        warnings,
        funding,
      )
    if (peerClaimed) return decide('claimedByPeer', NONE, warnings, funding)
    if (unspent.length === 0)
      return decide(
        refunded.every(o => o.spentBy!.final) ? 'refunded' : 'refunding',
        NONE,
        warnings,
        funding,
      )
    if (evm.latest?.state === 'refunded' || now > cut.evmWithdrawBy)
      return decide('awaitRefund', NONE, warnings, funding)
    return decide(
      output.final ? 'xecLocked' : 'xecLockPending',
      NONE,
      warnings,
      funding,
    )
  }

  // B.
  const lock = calls(observations, 'lock')
  const refund = calls(observations, 'refund')
  const latest = evm.latest
  if (latest === null) {
    if (lock.pending || (lock.landed && now <= terms.evmExpiry))
      return decide('locking', NONE, warnings, funding)
    if (now > cut.evmLockBy) return decide('abandoned', NONE, warnings, funding)
    // B's lock is still to be sent from the EVM main account (A's lock may not have arrived
    // yet): warn, never fund, while that account cannot pay the amount plus the call's gas.
    // Not once the lock can no longer be sent (reverts exhausted, A's output already spent).
    let lockFunds: { shortfallWei: bigint; lockBy: number } | undefined
    const lockDue = lock.reverts < HTLC_CALL_MAX_REVERTS && !output?.spentBy
    const lockCostWei = terms.evm.terms.amount + evm.callCostWei
    if (lockDue && evm.mainBalanceWei < lockCostWei) {
      warnings.push('lock-funds-low')
      lockFunds = {
        shortfallWei: lockCostWei - evm.mainBalanceWei,
        lockBy: cut.evmLockBy,
      }
    }
    if (lockDue && output && output.final)
      return decide(
        'locking',
        { kind: 'lock-evm', deadline: cut.evmLockBy },
        warnings,
        funding,
        lockFunds,
      )
    return decide('awaitXecLock', NONE, warnings, funding, lockFunds)
  }
  if (latest.state === 'refunded')
    return decide('refunded', owed, warnings, funding)
  if (latest.state === 'open') {
    if (evm.blockTimestamp >= terms.evmExpiry)
      return decide(
        'refunding',
        refund.pending || refund.reverts >= HTLC_CALL_MAX_REVERTS
          ? NONE
          : { kind: 'refund-evm' },
        warnings,
        funding,
      )
    return decide('evmLocked', NONE, warnings, funding)
  }
  // Withdrawn: A revealed the preimage on chain. B is owed exactly one principal: it claims one
  // output, the one A keeps back for it (the first unspent exact output), or the one it already
  // signed a claim for. Any extra output is A's to refund after T_A.
  if (claimed.length === 0 && unspent.length > 0) {
    const signed = unspent.find(o => storedXecSpendOf(record, o))
    return decide(
      'claimingXec',
      xecSpendAction(
        [signed ?? unspent[0]!],
        record,
        'claim',
        latest.preimage,
        input.activeDevice,
      ),
      warnings,
      funding,
    )
  }
  if (claimed.length > 0) {
    const final = claimed.every(o => o.spentBy!.final)
    return decide(
      final ? 'complete' : 'claimingXec',
      final ? owed : NONE,
      warnings,
      funding,
    )
  }
  if (refunded.length > 0)
    return decide('lostToRefund', owed, warnings, funding)
  return decide('claimingXec', NONE, warnings)
}

/** Lowercase-hex helpers shared with the runner. */
export const htlcSwapHex = Object.freeze({
  of: hex,
  address,
  equal: equalBytes,
  sha256Hex: (value: Uint8Array) => hex(sha256(value)),
})
