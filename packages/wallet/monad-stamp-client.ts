import { inspectCanonicalPreparedEnvelope } from './monad-stamp-stealth'
/**
 * Stamp payments on EVM networks.
 *
 * Two parts:
 *
 * - The calldata and commitment of one stamp payment (`<"POND"><0x02><32-byte commitment>`, the
 *   commitment being `SHA256("frank:dm-stamp-payment:v1" || payload_hash || uint32_be(child))`),
 *   the gas a payment needs, and finding and sweeping payments received at the one-time child
 *   addresses of this wallet's key.
 * - `MonadCanonicalStampClient`, which prepares, journals and submits the payments of a message
 *   on the relay's one message transport.
 *
 * The protobuf message codec below (`encodeMonadStampedMessage` and its readers) is kept only
 * because the wallet's stored-state check still reads stamp-attempt rows written in that shape.
 * Nothing sends it: the relay has no protobuf message route.
 */
import {
  Provider,
  Transaction,
  concat,
  getBytes,
  hexlify,
  sha256,
  toUtf8Bytes,
} from 'ethers'
import {
  MonadStampedMessage,
  StoredMonadMessage,
  MonadStampPayment,
} from '@frank/cashweb/relay/monad-mailbox-compat'
import { AccountLeaseHandle } from './monad-account-lease'
import {
  MonadAccountTxSigner,
  MonadTxOverrides,
  MonadTxSubmitter,
  SignedMonadTx,
} from './monad-account-tx'
import { selectStampAccounts } from './monad-stamp-account-selection'
import {
  deriveMonadStampChildPrivate,
  deriveMonadStampChildPublic,
} from './monad-stamp-stealth'
import { estimateDustThresholdWei } from './monad-change-pool'

/** `cashweb_payload::verify::BROADCAST_MESSAGE_LOKAD_ID` (`backend/cashweb/cashweb-payload/src/
 * verify.rs:15`, `*b"POND"`) — the LOKAD ID the live `PUT /message/monad` handler requires
 * (the tag name is historical; using it does not make a direct-message payment a burn). */
const BROADCAST_MESSAGE_LOKAD_ID = new Uint8Array([0x50, 0x4f, 0x4e, 0x44]) // "POND"

/** `cashweb_registry::monad_stamp_verify::COMMITMENT_VERSION_TAG`: split-payment protocol v2. */
const COMMITMENT_VERSION_TAG = new Uint8Array([0x02])
const PAYMENT_COMMITMENT_DOMAIN = toUtf8Bytes('frank:dm-stamp-payment:v1')
const STAMP_COMMITMENT_LENGTH = 32

/** `cashweb_registry::monad_stamp_verify::{CALLDATA_PREFIX_LEN, CALLDATA_COMMITMENT_LEN}` (5 + 32 =
 * 37 total): `<lokad_id: 4><version: 1><commitment: 32>`. Exported for tests that want to assert on
 * the exact calldata length independent of this module's other constants. */
export const MONAD_STAMP_CALLDATA_LENGTH =
  BROADCAST_MESSAGE_LOKAD_ID.length +
  COMMITMENT_VERSION_TAG.length +
  STAMP_COMMITMENT_LENGTH

/**
 * `MonadStampedMessage` from `monad_message.proto`, decoded/encoded here in plain-object form
 * (rather than a `jspb.Message` subclass). Field numbers match the `.proto`: the removed singular
 * transaction is reserved at 1, `encrypted_payload = 2`, `payload_hash = 3`, and
 * `stamp_payments = 4`.
 */
export interface MonadStampedMessageProto {
  stampPayments: Array<{ childIndex: number; rawTx: Uint8Array }>
  encryptedPayload: Uint8Array
  payloadHash: Uint8Array
}

/**
 * @deprecated Legacy protobuf DM transport type. Canonical CBOR envelope is the active path.
 * `StoredMonadMessage` from `monad_message.proto` — what both `PUT /message/monad`'s success
 * response and `GET /message/monad/:payload_hash` return. The old sender/hash assertions are
 * reserved at fields 2 and 3; `timestamp = 4`, `network_tag = 5`.
 */
export interface StoredMonadMessageProto {
  message: MonadStampedMessageProto | undefined
  /** Milliseconds since the Unix epoch. Decoded via `jspb.BinaryReader.readInt64`, which returns a
   * plain JS `number` (not `bigint`) — safe here since a millisecond timestamp is far below
   * `Number.MAX_SAFE_INTEGER` for a very long time yet. */
  timestamp: number
  /** Frank-specific network tag (ticket #39, see `backend/cashweb/cashweb-registry/src/
   * network_tag.rs` and PLAN.md constraint 9), e.g. `"MONT"`/`"MON1"` as raw bytes, stamped by the
   * relay from its own `FRANK_NETWORK_TAG` configuration — never asserted by the client. Empty on
   * records stored before this ticket shipped (proto3 default, not backfilled). Out of scope for
   * this ticket: any client-side warning/rejection when this doesn't match what a client expects —
   * this field only needs to exist, be populated by the relay, and decode correctly here. */
  networkTag: Uint8Array
}

/**
 * @deprecated Legacy protobuf DM transport helper. Canonical CBOR envelope is the active path.
 * Encode a {@link MonadStampedMessageProto} to protobuf wire-format bytes, via the generated
 * `MonadStampedMessage` class.
 */
export function encodeMonadStampedMessage(
  msg: MonadStampedMessageProto,
): Uint8Array {
  const pb = new MonadStampedMessage()
  pb.setEncryptedPayload(msg.encryptedPayload)
  pb.setPayloadHash(msg.payloadHash)
  pb.setStampPaymentsList(
    msg.stampPayments.map(payment => {
      const paymentPb = new MonadStampPayment()
      paymentPb.setChildIndex(payment.childIndex)
      paymentPb.setRawTx(payment.rawTx)
      return paymentPb
    }),
  )
  return pb.serializeBinary()
}

/**
 * @deprecated Legacy protobuf DM transport helper. Canonical CBOR envelope is the active path.
 * Decode protobuf wire-format bytes into a {@link MonadStampedMessageProto}. Round-trips with
 * {@link encodeMonadStampedMessage}.
 */
export function decodeMonadStampedMessage(
  bytes: Uint8Array,
): MonadStampedMessageProto {
  const pb = MonadStampedMessage.deserializeBinary(bytes)
  return {
    stampPayments: pb.getStampPaymentsList().map(payment => ({
      childIndex: payment.getChildIndex(),
      rawTx: payment.getRawTx_asU8(),
    })),
    encryptedPayload: pb.getEncryptedPayload_asU8(),
    payloadHash: pb.getPayloadHash_asU8(),
  }
}

/**
 * @deprecated Legacy protobuf DM transport helper. Canonical CBOR envelope is the active path.
 * Decode protobuf wire-format bytes into a {@link StoredMonadMessageProto} — what the relay
 * returns from both `PUT /message/monad` and `GET /message/monad/:payload_hash`.
 */
export function decodeStoredMonadMessage(
  bytes: Uint8Array,
): StoredMonadMessageProto {
  const pb = StoredMonadMessage.deserializeBinary(bytes)
  const nested = pb.getMessage()
  return {
    message: nested
      ? {
          stampPayments: nested.getStampPaymentsList().map(payment => ({
            childIndex: payment.getChildIndex(),
            rawTx: payment.getRawTx_asU8(),
          })),
          encryptedPayload: nested.getEncryptedPayload_asU8(),
          payloadHash: nested.getPayloadHash_asU8(),
        }
      : undefined,
    timestamp: pb.getTimestamp(),
    networkTag: pb.getNetworkTag_asU8(),
  }
}

/** Spendable recipient-side view of one verified stamp-payment child. This is intentionally
 * produced only by an explicit recovery call; private keys are never added to ordinary stored
 * message/feed objects. */
export interface RecoveredMonadStampPayment {
  childIndex: number
  address: string
  privateKey: Uint8Array
  txHash: string
  valueWei: bigint
}

export type MonadStampPaymentSweepOutcome =
  | {
      swept: true
      txHash: string
      valueWei: bigint
      destinationAddress: string
    }
  | {
      swept: false
      reason: 'below-dust-threshold' | 'pending'
      balanceWei?: bigint
      dustThresholdWei?: bigint
      txHash?: string
      valueWei?: bigint
      destinationAddress?: string
    }

/** Reconstruct every one-time payment key from a stored message and the recipient identity key.
 * The raw transaction destination is checked against the derived address before any key is
 * returned, so a malformed/local message cannot silently associate funds with the wrong child. */
export function recoverMonadStampPayments(params: {
  message: MonadStampedMessageProto
  recipientPrivateKey: Uint8Array
}): RecoveredMonadStampPayment[] {
  const seenChildren = new Set<number>()
  return params.message.stampPayments.map(payment => {
    if (seenChildren.has(payment.childIndex)) {
      throw new Error(
        `Duplicate stamp-payment child index ${payment.childIndex}`,
      )
    }
    seenChildren.add(payment.childIndex)
    const child = deriveMonadStampChildPrivate({
      payloadHash: params.message.payloadHash,
      recipientPrivateKey: params.recipientPrivateKey,
      paymentIndex: payment.childIndex,
    })
    const tx = Transaction.from(hexlify(payment.rawTx))
    if (tx.to?.toLowerCase() !== child.address.toLowerCase()) {
      throw new Error(
        `Stamp payment child ${payment.childIndex} pays ${
          tx.to ?? 'no address'
        }, expected ${child.address}`,
      )
    }
    if (tx.hash === null) {
      throw new Error(
        `Stamp payment child ${payment.childIndex} is not a signed transaction`,
      )
    }
    return {
      childIndex: payment.childIndex,
      address: child.address,
      privateKey: child.privateKey,
      txHash: tx.hash,
      valueWei: tx.value,
    }
  })
}

/** Sweep one recovered recipient payment into an ordinary recipient-controlled change address.
 * The child pays its own gas, so only `balance - dustThreshold` is transferred. The private key
 * remains caller-owned and is never serialized into the message or returned in the outcome. */
export async function sweepRecoveredMonadStampPayment(params: {
  payment: RecoveredMonadStampPayment
  destinationAddress: string
  provider: Provider
  httpClient: MonadTxSubmitter
  signer?: MonadAccountTxSigner
  dustThresholdWei?: bigint
  overrides?: MonadTxOverrides
  /** Durably record the exact signed bytes before the first RPC submission. */
  onSigned?: (signedTx: SignedMonadTx) => Promise<void>
}): Promise<MonadStampPaymentSweepOutcome> {
  const signer =
    params.signer ??
    new MonadAccountTxSigner({
      privateKey: hexlify(params.payment.privateKey),
      provider: params.provider,
      httpClient: params.httpClient,
    })
  if (signer.address.toLowerCase() !== params.payment.address.toLowerCase()) {
    throw new Error(
      `Recovered stamp-payment key resolves to ${signer.address}, expected ${params.payment.address}`,
    )
  }

  const balanceWei = await params.provider.getBalance(params.payment.address)
  const dustThresholdWei =
    params.dustThresholdWei ?? (await estimateDustThresholdWei(params.provider))
  if (balanceWei <= dustThresholdWei) {
    return {
      swept: false,
      reason: 'below-dust-threshold',
      balanceWei,
      dustThresholdWei,
    }
  }

  const valueWei = balanceWei - dustThresholdWei
  const signed = await signer.buildAndSignTransfer(
    params.destinationAddress,
    valueWei,
    params.overrides,
  )
  await params.onSigned?.(signed)
  const txHash = await signer.submit(signed)
  const status = await signer.getStatus(txHash)
  if (status === 'failed') {
    throw new Error(`Recipient stamp-payment sweep ${txHash} failed on-chain`)
  }
  if (status === 'pending') {
    return {
      swept: false,
      reason: 'pending',
      txHash,
      valueWei,
      destinationAddress: signed.to,
    }
  }
  return {
    swept: true,
    txHash,
    valueWei,
    destinationAddress: signed.to,
  }
}

/** `h_m = SHA256(encrypted_payload)`, stored as `MonadStampedMessage.payload_hash`. Per-payment
 * on-chain commitments are derived from this hash by {@link computeMonadStampPaymentCommitment}.
 * Returns the raw 32-byte hash, not hex. */
export function computeMonadStampCommitment(
  encryptedPayload: Uint8Array,
): Uint8Array {
  return getBytes(sha256(encryptedPayload))
}

/** Build the exact `<lokad_id: 4><version: 1><commitment: 32>` calldata layout
 * `monad_stamp_verify::parse_commitment_calldata` decodes (see this file's header), as a `0x`-
 * prefixed hex string ready to pass straight into `MonadAccountTxSigner.buildAndSignCall`. */
export function buildMonadStampCalldata(commitment: Uint8Array): string {
  if (commitment.length !== 32) {
    throw new Error(
      `Monad stamp commitment must be exactly 32 bytes, got ${commitment.length}`,
    )
  }
  return concat([
    BROADCAST_MESSAGE_LOKAD_ID,
    COMMITMENT_VERSION_TAG,
    commitment,
  ])
}

/** Quotes a current worst-case fee reserve for one stamp payment without submitting anything. */
export async function quoteMonadStampPaymentGasReserve(params: {
  signer: MonadAccountTxSigner
  recipientPublicKey: Uint8Array
  /** Deterministic transaction fields for tests; production resolves all fields from the RPC. */
  overrides?: MonadTxOverrides
}): Promise<bigint> {
  const worstCaseCommitment = new Uint8Array(STAMP_COMMITMENT_LENGTH).fill(0xff)
  const derivationScalar = new Uint8Array(STAMP_COMMITMENT_LENGTH)
  derivationScalar[STAMP_COMMITMENT_LENGTH - 1] = 1
  const destination = deriveMonadStampChildPublic({
    payloadHash: derivationScalar,
    recipientPublicKey: params.recipientPublicKey,
    paymentIndex: 0,
  }).address
  const probe = await params.signer.buildAndSignCall(
    destination,
    BigInt(1),
    buildMonadStampCalldata(worstCaseCommitment),
    params.overrides,
  )
  const feePerGas = probe.maxFeePerGas ?? probe.gasPrice
  if (feePerGas === undefined) {
    throw new Error('Unable to determine a maximum fee for stamp payment')
  }
  // Keep a modest fee headroom because funding must confirm before the child constructs its real
  // payment. The underlying gas limit and fee cap still come from the current RPC quote.
  return (probe.gasLimit * feePerGas * BigInt(5)) / BigInt(4)
}

/** Domain-separated commitment for one member of a payment set. Distinct child calldata prevents
 * a passive chain observer from grouping every split solely because it repeats the payload hash. */
export function computeMonadStampPaymentCommitment(
  payloadHash: Uint8Array,
  childIndex: number,
): Uint8Array {
  if (payloadHash.length !== 32) {
    throw new Error(
      `Monad stamp payload hash must be exactly 32 bytes, got ${payloadHash.length}`,
    )
  }
  if (
    !Number.isInteger(childIndex) ||
    childIndex < 0 ||
    childIndex > 0xffffffff
  ) {
    throw new Error(
      `Stamp payment child index must be a uint32, got ${childIndex}`,
    )
  }
  const indexBytes = Uint8Array.from([
    (childIndex >>> 24) & 0xff,
    (childIndex >>> 16) & 0xff,
    (childIndex >>> 8) & 0xff,
    childIndex & 0xff,
  ])
  return getBytes(
    sha256(concat([PAYMENT_COMMITMENT_DOMAIN, payloadHash, indexBytes])),
  )
}

/** Base class for every error this module throws. */
export class MonadStampError extends Error {}

/** Thrown when `PUT /message/monad` returns an HTTP-level error response (the relay was reached and
 * definitively rejected the message — see this file's header, "Lease release policy"). */
export class MonadStampRejectedError extends MonadStampError {
  readonly status: number | undefined
  readonly detail: unknown

  constructor(message: string, status: number | undefined, detail: unknown) {
    super(message)
    this.status = status
    this.detail = detail
  }
}

/** Thrown when the outcome stayed unresolved through the whole idempotent-retry budget (network
 * failure or a persistent `503 mailbox_retryable`) and no attempt journal exists to resume it
 * (see this file's header, "Lease release policy"). The lease has already been released as
 * `'stuck'` (retired) by the time this is thrown. */
export class MonadStampAbandonedError extends MonadStampError {
  readonly payloadHashHex: string

  constructor(message: string, payloadHashHex: string) {
    super(message)
    this.payloadHashHex = payloadHashHex
  }
}

/** The relay ended this exact payment set for good: `409 mailbox_conflict` (the payload hash is
 * owned by a different set) or `422 mailbox_terminal` (durable claim terminal: stale nonce, expiry,
 * failed verification, ...). Re-sending the same bytes cannot succeed; only a new send can. */
export class MonadStampTerminalError extends MonadStampError {
  readonly status: number
  readonly code: 'mailbox_conflict' | 'mailbox_terminal'
  /** Whether the relay still owns these exact bytes (`exact_set_retained`). */
  readonly exactSetRetained: boolean | undefined
  readonly detail: unknown

  constructor(
    message: string,
    status: number,
    code: 'mailbox_conflict' | 'mailbox_terminal',
    exactSetRetained: boolean | undefined,
    detail: unknown,
  ) {
    super(message)
    this.status = status
    this.code = code
    this.exactSetRetained = exactSetRetained
    this.detail = detail
  }
}

/** A previous exact payment set still needs reconciliation. Building a fresh salted envelope
 * while it is pending could pay twice under a different payload hash. */
export class MonadStampPendingAttemptError extends MonadStampError {
  readonly payloadHashes: string[]

  constructor(payloadHashes: string[]) {
    super(
      `Cannot create another stamp payment while ${payloadHashes.length} prior attempt(s) remain pending`,
    )
    this.payloadHashes = payloadHashes
  }
}

/** A prior exact set completed while reconciling a new send request. The caller must refresh
 * message state instead of silently paying again for the newly salted envelope. */
export class MonadStampRecoveredAttemptError extends MonadStampError {
  readonly payloadHashes: string[]

  constructor(payloadHashes: string[]) {
    super(`Recovered ${payloadHashes.length} prior stamp payment attempt(s)`)
    this.payloadHashes = payloadHashes
  }
}

/**
 * What is known about one outgoing attempt (identified by its bare-hex payload hash). A caller
 * that kept a message after a failed send asks this before it builds new payments, because a
 * second payment for the same message while the first can still land is a double payment.
 *
 * - `live`: the signed set is still journaled and may still land. Never build a new payment.
 * - `delivered`: the relay delivered it.
 * - `dead`: nothing can land for it any more; a new payment is the only way forward.
 * - `unknown`: no record. It may or may not have been delivered; callers must not silently pay
 *   again.
 */
export type MonadStampAttemptStatus = 'live' | 'delivered' | 'dead' | 'unknown'

import { randomBytes as canonicalRandomBytes } from '@frank/crypto-box'
// Opt-in canonical consumer. Legacy client/default submission and journals above are unchanged.
import {
  cborMap,
  encodeFrame,
  encodeCanonical,
  parseFrame,
  decodeCanonical,
  toHex,
  recipientPayloadDigest,
  paymentCommitment,
  verifyPreviewDirectoryEvidence,
  compareBytes,
  type Encodable,
} from '@frank/codec'
import {
  canonicalStampDestination,
  verifyCanonicalStampProof,
} from '@frank/cashweb/relay/canonical-dm-stamp'
import {
  freezeCanonicalRequest,
  equalCanonicalRequests,
  matchesRelayOrigin,
  submitCanonicalRequest,
  type CanonicalFetch,
  type CanonicalAcceptedBody,
  type CanonicalTerminalReason,
} from '@frank/cashweb/relay/canonical-dm-transport'
import type { Current, HistoricalEvidence } from '../directory-admission/src'
import { openDirectMessage } from '@frank/cashweb/relay/canonical-dm'
import type { MonadCanonicalWalletHandle } from './monad-wallet-handle'
import {
  isJournalPrepared,
  type CanonicalPreparedAttempt,
  type CanonicalJournalIntent,
  type CanonicalJournalAttempt,
  type CanonicalPaymentObservation,
  type CanonicalPaymentObservations,
} from './storage/stamp-attempt-journal'
import {
  assertMonadWalletBundleProvenance,
  assertOrdinaryMonadPoolSelection,
  runMonadPoolFinancialOperation,
} from './storage/monad-wallet-bundle'

export interface CanonicalWorkflowLink {
  readonly attemptRef: string
  readonly consumerId: string
  readonly prepared: CanonicalPreparedAttempt
}
export interface CanonicalWalletEligibility {
  readonly attemptRef: string
}
export type CanonicalWalletLookup =
  | { readonly kind: 'intent'; readonly record: CanonicalJournalIntent }
  | { readonly kind: 'attempt'; readonly record: CanonicalJournalAttempt }

/** Explicit local workflow correlation, separate from HTTP recipient obligation acknowledgement. */
const canonicalLiveLeases = new WeakMap<
  object,
  Map<number, AccountLeaseHandle>
>()
const canonicalFaultedOwners = new WeakSet<object>()
import {
  canonicalAdmissionJournal,
  canonicalAdmissionPool,
  EvmInputAdmissionError,
  type WalletOperationLifetime,
} from './evm-input-admission'
export class MonadCanonicalStampClient {
  private readonly tokens = new WeakMap<
    CanonicalWalletEligibility,
    { link: CanonicalWorkflowLink; snapshot: string }
  >()
  constructor(private readonly wallet: MonadCanonicalWalletHandle) {
    assertMonadWalletBundleProvenance(wallet.walletState)
    if (wallet.walletState.canonicalUnavailable)
      throw wallet.walletState.canonicalUnavailable
    if (
      !wallet.walletState.canonicalJournal ||
      !wallet.walletState.canonicalBinding ||
      wallet.walletState.pool !== wallet.pool ||
      wallet.walletState.leaseManager !== wallet.leaseManager ||
      wallet.walletState.changePool !== wallet.changePool
    )
      throw new Error('canonical-wallet:coherent-owner-required')
  }
  private get journal() {
    return this.wallet.walletState.canonicalJournal!
  }
  private writer(lifetime: WalletOperationLifetime) {
    return canonicalAdmissionJournal(
      this.wallet.walletState.inputAdmission,
      lifetime,
    )
  }
  private assertOwner(): void {
    if (canonicalFaultedOwners.has(this.wallet.walletState))
      throw new Error('canonical-wallet:storage-uncertain-reopen-required')
    this.wallet.walletState.assertOpen()
    assertMonadWalletBundleProvenance(this.wallet.walletState)
    this.wallet.walletState.assertSemanticallyValid()
  }
  private async acquireCanonicalLease(
    index: number,
    attemptRef: string,
    lifetime: WalletOperationLifetime,
  ): Promise<void> {
    const handle = await canonicalAdmissionPool(
      this.wallet.walletState.inputAdmission,
      lifetime,
    ).acquire(index, attemptRef)
    let leases = canonicalLiveLeases.get(this.wallet.walletState)
    if (!leases) {
      leases = new Map()
      canonicalLiveLeases.set(this.wallet.walletState, leases)
    }
    leases.set(index, handle)
  }
  private async flushCanonicalReservations(): Promise<void> {
    try {
      await this.wallet.pool.flush()
    } catch (error) {
      canonicalFaultedOwners.add(this.wallet.walletState)
      throw error
    }
  }
  private preparedIsBound(prepared: CanonicalPreparedAttempt): boolean {
    const bound = JSON.parse(this.wallet.walletState.canonicalBinding!.tuple)
    return (
      prepared.walletBindingId ===
        this.wallet.walletState.canonicalBinding!.id &&
      prepared.accountId === bound.main &&
      prepared.network === bound.network &&
      prepared.chainId === bound.chainId &&
      `0x${prepared.senderSubject}` === bound.auth
    )
  }
  private assertPreparedOwner(prepared: CanonicalPreparedAttempt): void {
    this.assertOwner()
    if (!this.preparedIsBound(prepared))
      throw new Error('canonical-wallet:binding-mismatch')
  }
  /**
   * `lookup(prepared)` for a link the caller has already paired, by `attemptRef`, with a record
   * the journal returned in this same synchronous call, after `assertOwner`. When the link's
   * prepared attempt is bound to this wallet and is exactly that record's, the answer is that
   * record: nothing is searched and nothing is validated twice. In every other case the scanning
   * `lookup` runs unchanged, so a foreign, malformed, conflicting or unknown link is refused,
   * held or thrown for exactly as before.
   */
  private lookupLinked(
    held: CanonicalWalletLookup,
    prepared: CanonicalPreparedAttempt,
  ): CanonicalWalletLookup | undefined {
    if (
      isJournalPrepared(held.record.prepared, prepared) &&
      this.preparedIsBound(prepared)
    )
      return held
    return this.lookup(prepared)
  }
  lookup(
    prepared: CanonicalPreparedAttempt,
  ): CanonicalWalletLookup | undefined {
    this.assertPreparedOwner(prepared)
    const attempt = this.journal.lookup(prepared)
    if (attempt) return { kind: 'attempt', record: attempt }
    const intent = this.journal.lookupIntent(prepared)
    return intent ? { kind: 'intent', record: intent } : undefined
  }
  /** Capture exact-set chain observations without signing, submitting or authorizing cleanup.
   * The recovery consumer must separately establish finality before retiring reservations.
   * Network reads do not hold the wallet's selection/admission lock. */
  async capturePaymentObservations(
    prepared: CanonicalPreparedAttempt,
  ): Promise<
    | { kind: 'recorded'; observations: CanonicalPaymentObservations }
    | { kind: 'stale' }
  > {
    const preparedSnapshot = {
      ...prepared,
      payload: new Uint8Array(prepared.payload),
      context: new Uint8Array(prepared.context),
      economicBinding: new Uint8Array(prepared.economicBinding),
    }
    const capture = await this.wallet.runCanonicalExclusive(async lifetime => {
      this.assertPreparedOwner(preparedSnapshot)
      const attempt = this.journal.lookup(preparedSnapshot)
      if (!attempt) throw new Error('canonical-wallet:attempt-required')
      return this.writer(lifetime).beginObservation(attempt.attemptRef)
    })
    const members: CanonicalPaymentObservation[] = []
    // Sequential reads bound RPC concurrency independently of the signed-set size.
    for (const raw of capture.attempt.request.parts.transactions) {
      const expected = Transaction.from(hexlify(raw))
      const transactionHash = expected.hash!
      let observation: CanonicalPaymentObservation = {
        transactionHash,
        state: 'unknown',
      }
      try {
        const [transaction, receipt] = await Promise.all([
          this.wallet.provider.getTransaction(transactionHash),
          this.wallet.provider.getTransactionReceipt(transactionHash),
        ])
        if (transaction === null && receipt === null) {
          observation = { transactionHash, state: 'missing' }
        } else if (
          transaction &&
          transaction.hash.toLowerCase() === transactionHash &&
          transaction.chainId === BigInt(capture.attempt.prepared.chainId) &&
          transaction.from.toLowerCase() === expected.from!.toLowerCase() &&
          Transaction.from(transaction).serialized === expected.serialized
        ) {
          if (receipt === null) {
            observation = { transactionHash, state: 'pending' }
          } else if (
            receipt.hash.toLowerCase() === transactionHash &&
            receipt.from.toLowerCase() === expected.from!.toLowerCase() &&
            receipt.to?.toLowerCase() === expected.to?.toLowerCase() &&
            typeof receipt.blockHash === 'string' &&
            /^0x[0-9a-fA-F]{64}$/.test(receipt.blockHash) &&
            Number.isSafeInteger(receipt.blockNumber) &&
            receipt.blockNumber >= 0 &&
            Number.isSafeInteger(receipt.index) &&
            receipt.index >= 0 &&
            transaction.blockHash?.toLowerCase() ===
              receipt.blockHash.toLowerCase() &&
            transaction.blockNumber === receipt.blockNumber &&
            transaction.index === receipt.index &&
            (receipt.status === 0 || receipt.status === 1)
          ) {
            observation = {
              transactionHash,
              state: receipt.status === 1 ? 'observed' : 'reverted',
              blockHash: receipt.blockHash.toLowerCase(),
              blockNumber: receipt.blockNumber,
              transactionIndex: receipt.index,
            }
          }
        }
      } catch {
        // Unavailable or inconsistent provider evidence is not a payment failure.
      }
      members.push(observation)
    }
    return this.wallet.runCanonicalExclusive(async lifetime => {
      this.assertPreparedOwner(capture.attempt.prepared)
      const observations = await this.writer(lifetime).recordObservations(
        capture,
        members,
      )
      return observations
        ? { kind: 'recorded', observations }
        : { kind: 'stale' }
    })
  }
  /** Effect-free binding for the workflow's already sealed B bytes and intended economics. */
  bindPrepared(input: {
    payload: Uint8Array
    context: Uint8Array
    stampValueWei: bigint
    economicBinding: Uint8Array
  }): CanonicalPreparedAttempt {
    this.assertOwner()
    if (
      input.stampValueWei <= 0n ||
      input.stampValueWei >= 1n << 256n ||
      input.economicBinding.length > 8192
    )
      throw new Error('canonical-wallet:economics-invalid')
    inspectCanonicalPreparedEnvelope(input.payload, input.context)
    const payload = new Uint8Array(input.payload),
      context = new Uint8Array(input.context)
    const parsed = parseFrame(payload),
      fields = decodeCanonical(context)
    if (
      parsed.kind !== 'parsed' ||
      parsed.typed?.type !== 5 ||
      parsed.schemaVersion !== 2 ||
      parsed.typed.suite !== 1 ||
      !(fields instanceof Map)
    )
      throw new Error('canonical-wallet:prepared-required')
    const bound = JSON.parse(this.wallet.walletState.canonicalBinding!.tuple)
    const t1 = (key: bigint) => {
      const value = fields.get(key)
      if (!(value instanceof Uint8Array) || value.length !== 32)
        throw new Error('canonical-wallet:T1-required')
      return toHex(value)
    }
    const prepared = {
      walletBindingId: this.wallet.walletState.canonicalBinding!.id,
      accountId: bound.main,
      chainId: bound.chainId,
      network: parsed.typed.network,
      senderSubject: toHex(parsed.typed.sender.keyBytes),
      recipientSubject: toHex(parsed.typed.recipient.keyBytes),
      senderT1: t1(4n),
      recipientT1: t1(5n),
      payload,
      context,
      economicBinding: encodeCanonical(
        cborMap([
          [0, 1],
          [1, input.stampValueWei.toString()],
          [2, new Uint8Array(input.economicBinding)],
        ]),
      ),
    }
    this.assertPreparedOwner(prepared)
    this.journal.lookup(prepared)
    this.journal.lookupIntent(prepared)
    return prepared
  }

  private snapshot(): string {
    return JSON.stringify([this.journal.getIntents(), this.journal.getAll()])
  }

  /** Read-only: whether the journal holds a payment intent or attempt recorded for this consumer. */
  hasConsumerRecord(consumerId: string): boolean {
    this.assertOwner()
    return [...this.journal.getIntents(), ...this.journal.getAll()].some(
      record => record.consumerId === consumerId,
    )
  }

  /** All reopened records must match real persisted workflow links before explicit replay. */
  reconcileWorkflowLinks(links: readonly CanonicalWorkflowLink[]): readonly {
    attemptRef: string
    state: 'ready' | 'terminal' | 'hold'
    eligibility?: CanonicalWalletEligibility
  }[] {
    this.assertOwner()
    const held: CanonicalWalletLookup[] = [
      ...this.journal
        .getIntents()
        .map(record => ({ kind: 'intent' as const, record })),
      ...this.journal
        .getAll()
        .map(record => ({ kind: 'attempt' as const, record })),
    ]
    const records = held.map(item => item.record)
    const snapshot = this.snapshot()
    const matches = held.map(item => {
      const record = item.record
      const candidates = links.filter(
        link => link.attemptRef === record.attemptRef,
      )
      const link = candidates.length === 1 ? candidates[0] : undefined
      if (!link || link.consumerId !== record.consumerId)
        return { attemptRef: record.attemptRef, state: 'hold' as const }
      // The record is in hand by reference; only an inexact link is searched for by its bytes.
      const found = this.lookupLinked(item, link.prepared)
      if (!found || found.record.attemptRef !== record.attemptRef)
        return { attemptRef: record.attemptRef, state: 'hold' as const }
      return {
        attemptRef: record.attemptRef,
        state: 'terminal' as const,
        link,
        record,
        found,
      }
    })
    // A missing/unknown workflow record blocks all economic replay, not only its own row.
    const complete =
      matches.every(m => 'link' in m) && links.length === records.length
    return matches.map(m => {
      if (!m.link || !m.record || !complete)
        return { attemptRef: m.attemptRef, state: 'hold' as const }
      if ('terminal' in m.record && m.record.terminal !== null)
        return { attemptRef: m.attemptRef, state: 'terminal' as const }
      const eligibility = Object.freeze({ attemptRef: m.attemptRef })
      this.tokens.set(eligibility, {
        link: {
          ...m.link,
          prepared: m.found.record.prepared,
        },
        snapshot,
      })
      return { attemptRef: m.attemptRef, state: 'ready' as const, eligibility }
    })
  }

  /** The callback must durably link this exact intent before any lease mutation or signature. */
  prepareIntent(input: {
    prepared: CanonicalPreparedAttempt
    consumerId: string
    stampValueWei: bigint
    senderCurrent: Current
    recipientCurrent: Current
    overrides?: MonadTxOverrides
    onIntentDurable: (link: CanonicalWorkflowLink) => Promise<void>
  }): Promise<CanonicalJournalIntent> {
    inspectCanonicalPreparedEnvelope(
      input.prepared.payload,
      input.prepared.context,
    )
    // Copy all byte input before admission's first asynchronous boundary.
    input = {
      ...input,
      prepared: {
        ...input.prepared,
        payload: new Uint8Array(input.prepared.payload),
        context: new Uint8Array(input.prepared.context),
        economicBinding: new Uint8Array(input.prepared.economicBinding),
      },
      overrides: { ...input.overrides },
    }
    return this.wallet.runCanonicalExclusive(async lifetime => {
      this.assertPreparedOwner(input.prepared)
      const snapshot = this.wallet.walletState.inputAdmission.inspect(lifetime)
      if (snapshot.status !== 'ready')
        throw new EvmInputAdmissionError(snapshot.reason)
      const economics = decodeCanonical(input.prepared.economicBinding)
      if (
        !(economics instanceof Map) ||
        economics.size !== 3 ||
        economics.get(0n) !== 1n ||
        economics.get(1n) !== input.stampValueWei.toString() ||
        !(economics.get(2n) instanceof Uint8Array)
      )
        throw new Error('canonical-wallet:economics-mismatch')
      const existing = this.lookup(input.prepared)
      if (existing)
        throw new Error('canonical-wallet:existing-record-requires-correlation')
      const roles = this.wallet.canonicalRoles.create(
        input.prepared.network,
        input.senderCurrent,
      )
      roles.dispose()
      const evidence = verifyPreviewDirectoryEvidence(
        input.recipientCurrent.evidence.attestation,
        input.prepared.network,
      )
      if (
        input.recipientCurrent.kind !== 'current' ||
        input.recipientCurrent.status.forked ||
        toHex(evidence.statement.subject.keyBytes) !==
          input.prepared.recipientSubject ||
        toHex(evidence.statementHash) !== input.prepared.recipientT1 ||
        toHex(input.senderCurrent.evidence.hash) !== input.prepared.senderT1 ||
        compareBytes(
          evidence.statement.stampKey.keyBytes,
          input.recipientCurrent.stampKey.keyBytes,
        ) !== 0
      )
        throw new Error('canonical-wallet:current-mismatch')
      const parsed = parseFrame(input.prepared.payload)
      const context = decodeCanonical(input.prepared.context)
      if (
        parsed.kind !== 'parsed' ||
        parsed.typed?.type !== 5 ||
        parsed.schemaVersion !== 2 ||
        !(context instanceof Map)
      )
        throw new Error('canonical-wallet:prepared-required')
      const stampKey = context.get(8n)
      if (
        !(stampKey instanceof Map) ||
        stampKey.get(0n) !== 1n ||
        !(stampKey.get(1n) instanceof Uint8Array) ||
        compareBytes(
          stampKey.get(1n) as Uint8Array,
          input.recipientCurrent.stampKey.keyBytes,
        ) !== 0
      )
        throw new Error('canonical-wallet:stamp-key-mismatch')
      const ownedStampKey = {
        keyType: 1,
        keyBytes: new Uint8Array(input.recipientCurrent.stampKey.keyBytes),
      }
      for (const [key, expected] of [
        [6n, input.senderCurrent.messageKey.keyBytes],
        [7n, input.recipientCurrent.messageKey.keyBytes],
      ] as const) {
        const role = context.get(key)
        if (
          !(role instanceof Map) ||
          role.get(0n) !== 1n ||
          !(role.get(1n) instanceof Uint8Array) ||
          compareBytes(role.get(1n) as Uint8Array, expected) !== 0
        )
          throw new Error('canonical-wallet:message-role-mismatch')
      }
      for (const [key, expected] of [
        [9n, parsed.typed.ephemeralPoint],
        [10n, parsed.typed.sharedPoint],
        [11n, parsed.typed.dleqProof],
      ] as const) {
        const bytes = context.get(key)
        if (
          !(bytes instanceof Uint8Array) ||
          compareBytes(bytes, expected) !== 0
        )
          throw new Error('canonical-wallet:proof-context-mismatch')
      }
      verifyCanonicalStampProof({
        network: input.prepared.network,
        stampKey: ownedStampKey,
        ephemeralPoint: parsed.typed.ephemeralPoint,
        sharedPoint: parsed.typed.sharedPoint,
        dleqProof: parsed.typed.dleqProof,
      })
      const destination = (i: number) =>
        canonicalStampDestination({
          network: input.prepared.network,
          stampKey: ownedStampKey,
          sharedPoint:
            parsed.typed!.type === 5
              ? parsed.typed!.sharedPoint
              : new Uint8Array(),
          childIndex: i,
        })
      const protectedIndices = new Set([
        ...this.journal
          .getIntents()
          .flatMap(intent => intent.members.map(m => m.reservation.index)),
        ...this.journal
          .getAll()
          .filter(a => !a.cleanupComplete)
          .flatMap(a => a.reservations.map(r => r.index)),
      ])
      let baseNonce = 0
      let baseGasLimit = input.overrides?.gasLimit ?? 21_000n
      let baseChainId = BigInt(input.prepared.chainId)
      let baseMaxFeePerGas = input.overrides?.maxFeePerGas
      let baseMaxPriorityFeePerGas = input.overrides?.maxPriorityFeePerGas
      let baseGasPrice = input.overrides?.gasPrice

      const candidateRecords = this.wallet.pool
        .records()
        .filter(
          r =>
            r.status === 'available' &&
            !protectedIndices.has(r.index) &&
            !this.wallet.pool.isSpendReserved(r.index),
        )

      // Resolve base quote once outside the loop only if fee fields were not provided in overrides
      if (baseMaxFeePerGas === undefined && baseGasPrice === undefined) {
        try {
          const feeData = await this.wallet.provider.getFeeData()
          baseMaxFeePerGas = feeData.maxFeePerGas ?? undefined
          baseMaxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? undefined
          baseGasPrice =
            baseMaxFeePerGas !== undefined
              ? undefined
              : feeData.gasPrice ?? undefined
        } catch {
          // Fall back to sample signer if feeData query fails
        }
        if (
          baseMaxFeePerGas === undefined &&
          baseGasPrice === undefined &&
          candidateRecords.length > 0
        ) {
          try {
            const sampleSigner = this.wallet.pool.getSigner(
              candidateRecords[0].index,
              this.wallet,
            )
            const sampleQuote = Transaction.from(
              (
                await sampleSigner.populateUnsignedTransfer(
                  hexlify(destination(0).address),
                  1n,
                  { gasLimit: baseGasLimit, ...input.overrides },
                )
              ).unsignedSerialized,
            )
            baseNonce = sampleQuote.nonce
            baseChainId = sampleQuote.chainId
            baseGasLimit = sampleQuote.gasLimit
            baseMaxFeePerGas = sampleQuote.maxFeePerGas ?? undefined
            baseMaxPriorityFeePerGas =
              sampleQuote.maxPriorityFeePerGas ?? undefined
            baseGasPrice =
              baseMaxFeePerGas !== undefined
                ? undefined
                : sampleQuote.gasPrice ?? undefined
          } catch {
            // Keep default fees
          }
        }
      }

      const fee = baseMaxFeePerGas ?? baseGasPrice ?? 2n
      if (fee === null || baseChainId.toString() !== input.prepared.chainId)
        throw new Error('canonical-wallet:quote-mismatch')

      const quotes = []
      const frozenQuotes = new Map<
        number,
        {
          nonce: number
          chainId: bigint
          gasLimit: bigint
          maxFeePerGas?: bigint
          maxPriorityFeePerGas?: bigint
          gasPrice?: bigint
          balance: bigint
        }
      >()

      for (const record of candidateRecords) {
        // Fast in-memory balance check from accountUtxoPool, or provider query
        let balance: bigint | undefined
        if (this.wallet.accountUtxoPool) {
          const utxos = this.wallet.accountUtxoPool.getCoinsByAddress(
            record.address,
            'monad',
          )
          if (utxos.length > 0 && utxos[0].balanceWei > 0n) {
            balance = utxos[0].balanceWei
          }
        }
        if (balance === undefined) {
          balance = await this.wallet.provider.getBalance(record.address)
          if (this.wallet.accountUtxoPool && balance > 0n) {
            const utxos = this.wallet.accountUtxoPool.getCoinsByAddress(
              record.address,
              'monad',
            )
            if (utxos.length > 0) {
              utxos[0].balanceWei = balance
            }
          }
        }
        if (balance <= 0n) continue
        const signer = this.wallet.pool.getSigner(record.index, this.wallet)
        if (signer.address.toLowerCase() !== record.address.toLowerCase())
          throw new Error('canonical-wallet:pool-custody-mismatch')

        const capacityWei =
          balance > baseGasLimit * fee ? balance - baseGasLimit * fee : 0n
        quotes.push({
          index: record.index,
          address: record.address,
          capacityWei,
        })
        frozenQuotes.set(record.index, {
          nonce: 0,
          chainId: baseChainId,
          gasLimit: baseGasLimit,
          maxFeePerGas: baseMaxFeePerGas,
          maxPriorityFeePerGas: baseMaxPriorityFeePerGas,
          gasPrice: baseGasPrice,
          balance,
        })
      }
      const selected = selectStampAccounts({
        amountWei: input.stampValueWei,
        accounts: quotes,
        maxTransactions: 64,
      })
      const members = []
      for (const [i, selection] of selected.entries()) {
        const quote = frozenQuotes.get(selection.index)!
        const signer = this.wallet.pool.getSigner(selection.index, this.wallet)
        // Plain value transfer to the one-off child address: no calldata, so nothing on
        // chain marks this as a Frank message payment (#826).
        const overrides: MonadTxOverrides = {
          nonce: quote.nonce,
          chainId: quote.chainId,
          gasLimit: quote.gasLimit,
        }
        if (quote.maxFeePerGas !== undefined) {
          overrides.maxFeePerGas = quote.maxFeePerGas
          overrides.maxPriorityFeePerGas = quote.maxPriorityFeePerGas
        } else if (quote.gasPrice !== undefined) {
          overrides.gasPrice = quote.gasPrice
        }
        const frozen = await signer.populateUnsignedTransfer(
          hexlify(destination(i).address),
          selection.paymentValueWei,
          overrides,
        )
        const tx = Transaction.from(frozen.unsignedSerialized),
          txFee = tx.maxFeePerGas ?? tx.gasPrice
        if (txFee === null || tx.value + tx.gasLimit * txFee > quote.balance)
          throw new Error('canonical-wallet:selection-capacity-changed')
        members.push({
          reservation: {
            id: `canonical:${sha256(
              toUtf8Bytes(`${selection.index}:${input.consumerId}`),
            ).slice(2)}`,
            index: selection.index,
          },
          ...frozen,
          rawTx: null,
        })
      }
      const intent =
        await this.wallet.walletState.inputAdmission.prepareCanonical(
          lifetime,
          snapshot.epoch,
          {
            prepared: input.prepared,
            consumerId: input.consumerId,
            boundary: `frank-${toHex(canonicalRandomBytes(24))}`,
            members,
            construction: new TextEncoder().encode(
              input.stampValueWei.toString(),
            ),
          },
        )
      await input.onIntentDurable({
        attemptRef: intent.attemptRef,
        consumerId: intent.consumerId,
        prepared: intent.prepared,
      })
      // Durable intent and linked workflow are now authoritative; no pool write preceded them.
      for (const member of intent.members)
        await this.acquireCanonicalLease(
          member.reservation.index,
          intent.attemptRef,
          lifetime,
        )
      await this.flushCanonicalReservations()
      return intent
    })
  }

  /** Finish only frozen correlated intent. No replacement quotes, fees, account or nonce. */
  finishIntent(
    eligibility: CanonicalWalletEligibility,
  ): Promise<CanonicalJournalAttempt> {
    return this.wallet.runCanonicalExclusive(async lifetime => {
      const token = this.tokens.get(eligibility)
      this.tokens.delete(eligibility)
      if (!token || token.snapshot !== this.snapshot())
        throw new Error('canonical-wallet:reconcile-required')
      const found = this.lookup(token.link.prepared)
      if (
        !found ||
        found.kind !== 'intent' ||
        found.record.attemptRef !== token.link.attemptRef
      )
        throw new Error('canonical-wallet:intent-required')
      let intent =
        await this.wallet.walletState.inputAdmission.authorizeCanonicalSigning(
          lifetime,
          found.record.attemptRef,
        )
      for (const member of intent.members) {
        const record = this.wallet.pool.getRecord(member.reservation.index)
        const signer = this.wallet.pool.getSigner(
          member.reservation.index,
          this.wallet,
        )
        if (
          !record ||
          signer.address.toLowerCase() !== member.from ||
          record.address.toLowerCase() !== member.from ||
          (record.status !== 'available' && record.status !== 'in-use')
        )
          throw new Error('canonical-wallet:pool-custody-hold')
        if (
          record.status === 'in-use' &&
          this.wallet.leaseManager.isLeased(record.index) &&
          !canonicalLiveLeases.get(this.wallet.walletState)?.has(record.index)
        )
          throw new Error('canonical-wallet:foreign-lease-hold')
        if (record.status === 'available') {
          if (this.wallet.leaseManager.isLeased(record.index))
            throw new Error('canonical-wallet:foreign-lease-hold')
          await this.acquireCanonicalLease(
            record.index,
            intent.attemptRef,
            lifetime,
          )
        }
      }
      await this.flushCanonicalReservations()
      for (let i = 0; i < intent.members.length; i++) {
        const member = intent.members[i]
        if (member.rawTx !== null) continue
        const signer = this.wallet.pool.getSigner(
          member.reservation.index,
          this.wallet,
        )
        const signed = await signer.signFrozenUnsigned(member)
        intent = await this.writer(lifetime).checkpointSignedMember(
          intent.attemptRef,
          i,
          signed.rawTx,
        )
      }
      const payload = parseFrame(intent.prepared.payload)
      if (payload.kind !== 'parsed' || payload.typed?.type !== 5)
        throw new Error('canonical-wallet:payload-required')
      const digest = recipientPayloadDigest(
        intent.prepared.network,
        intent.prepared.payload,
      )
      const payments = intent.members.map((member, i) => {
        const tx = Transaction.from(member.rawTx!)
        const value = getBytes('0x' + tx.value.toString(16).padStart(64, '0'))
        const rawBytes = member.rawTx ? getBytes(member.rawTx) : undefined
        const entries: [number, Encodable][] = [
          [0, i],
          [1, getBytes(tx.hash!)],
          [2, value],
          [3, getBytes(tx.to!)],
          [4, paymentCommitment(digest, i)],
        ]
        if (rawBytes && rawBytes.length > 0) {
          entries.push([6, rawBytes])
        }
        return cborMap(entries)
      })
      const inspected = inspectCanonicalPreparedEnvelope(
        intent.prepared.payload,
        intent.prepared.context,
      )
      const delivery = encodeFrame(
        { typeId: 1, schemaVersion: 1, minReaderVersion: 1 },
        cborMap([
          [0, intent.prepared.network],
          [
            1,
            cborMap([
              [0, 1],
              [1, inspected.stampKey.keyBytes],
            ]),
          ],
          [2, intent.prepared.payload],
          [3, digest],
          [4, payments],
          [
            5,
            cborMap([
              [0, inspected.payload.recipient.keyType],
              [1, inspected.payload.recipient.keyBytes],
            ]),
          ],
          [6, inspected.payload.dleqProof],
        ]),
      )
      const request = freezeCanonicalRequest(
        {
          delivery,
          context: intent.prepared.context,
          transactions: intent.members.map(m => getBytes(m.rawTx!)),
        },
        intent.boundary,
      )
      return this.writer(lifetime).promoteIntent(intent.attemptRef, request)
    })
  }

  /**
   * Replays one promoted attempt: the identical frozen bytes, once, to the installed relay.
   *
   * Three steps, so that the wallet queue is never held while the relay is being waited on:
   *
   *   1. Inside the wallet queue: check the permit against the whole journal, correlate, pass the
   *      input admission, and mark the attempt as being replayed in the journal. A second `submit`
   *      of the same attempt is refused here, with no request, for as long as the mark is set.
   *   2. Outside the wallet queue, under the wallet lifetime only: send the frozen request.
   *      Nothing is selected, signed, released or written, and no store is touched.
   *   3. Inside the wallet queue again, and only when the relay gave an authenticated final
   *      answer: record it against the same record, if that record is still unanswered. A kept
   *      ("retained") answer and an unknown outcome record nothing and take no queue entry.
   *
   * The wallet lifetime spans all three steps. Close therefore waits for the request (bounded by
   * the transport's deadline) and the journal stays open until the mark is cleared. A close that
   * begins between steps 1 and 2 makes no request; one that begins during step 2 has step 3
   * refused, so the answer is dropped, nothing is written, and `submit` rejects. The mark is
   * memory only and is cleared on every exit, whether or not step 3 was admitted.
   */
  submit(
    eligibility: CanonicalWalletEligibility,
    options: { fetch?: CanonicalFetch; signal?: AbortSignal } = {},
  ): Promise<CanonicalAcceptedBody> {
    return this.wallet.walletState.runLifetime(async session => {
      // Set only once the journal holds the mark, so every later exit knows to clear it.
      let marked: CanonicalWalletEligibility | undefined
      try {
        // Step 1.
        const attempt = await this.wallet.runCanonicalExclusive(
          async lifetime => {
            const token = this.tokens.get(eligibility)
            this.tokens.delete(eligibility)
            // The whole journal, as for `finishIntent`: a record that appeared, changed or went
            // away after the permit was issued requires a new correlation first.
            if (!token || token.snapshot !== this.snapshot())
              throw new Error('canonical-wallet:reconcile-required')
            const found = this.lookup(token.link.prepared)
            if (
              !found ||
              found.kind !== 'attempt' ||
              found.record.terminal !== null
            )
              throw new Error('canonical-wallet:attempt-required')
            const results = this.journal.reconcile(
              this.journal.getAll().map(a => ({
                attemptRef: a.attemptRef,
                prepared: a.prepared,
                request: a.request,
                reservations: a.reservations,
                consumerId: a.consumerId,
              })),
            )
            const result = results.find(
              r => r.attemptRef === found.record.attemptRef,
            )
            if (!result || result.state !== 'ready')
              throw new Error('canonical-wallet:replay-hold')
            // Admission must be durable-owner confirmed before any byte reaches the relay.
            await this.writer(lifetime).beginReplay(result.eligibility)
            marked = result.eligibility
            return found.record
          },
        )
        // Step 2. No queue is held from here until step 3.
        this.wallet.walletState.assertOpen()
        const accepted = await submitCanonicalRequest({
          installedRelayOrigin: this.wallet.relayBaseUrl,
          expectedNetworkTag: this.wallet.installedNetworkTag,
          request: attempt.request,
          ...options,
        })
        if (accepted.phase === 'retained') return accepted
        // Step 3. A refused queue entry (the wallet closed meanwhile) drops the answer.
        return await this.wallet.runCanonicalExclusive(async lifetime => {
          this.assertOwner()
          const current = this.journal
            .getAll()
            .find(a => a.attemptRef === attempt.attemptRef)
          // An answer for a record that was meanwhile answered, cleaned up or replaced is not
          // written over what the journal holds; the caller reads the journal for the outcome.
          if (
            current &&
            current.terminal === null &&
            equalCanonicalRequests(current.request, attempt.request)
          )
            await this.writer(lifetime).recordTerminal(
              attempt.attemptRef,
              accepted,
            )
          const replay = marked!
          marked = undefined
          this.writer(lifetime).endReplay(replay)
          return accepted
        })
      } finally {
        if (marked !== undefined) {
          try {
            this.writer(session).endReplay(marked)
          } catch {
            // Only a faulted, closed or reopened journal refuses, and each of those has already
            // dropped every mark. The error that brought us here is the one to report.
          }
        }
      }
    })
  }
  markAttemptTerminal(
    attemptRef: string,
    reason: CanonicalTerminalReason = 'attempts_exhausted',
  ): Promise<CanonicalJournalAttempt> {
    return this.wallet.runCanonicalExclusive(async lifetime => {
      this.assertOwner()
      const attempt = this.journal
        .getAll()
        .find(a => a.attemptRef === attemptRef)
      if (!attempt) throw new Error('canonical-wallet:attempt-required')
      if (attempt.terminal !== null) return attempt
      return this.writer(lifetime).recordTerminal(attemptRef, {
        version: 1,
        phase: 'dead',
        identity: attempt.request.identity,
        reason,
      })
    })
  }

  reapOrphanedAttempts(activeAttemptRefs: Set<string>): Promise<void> {
    return this.wallet.runCanonicalExclusive(async lifetime => {
      this.assertOwner()
      const attempts = this.journal
        .getAll()
        .filter(a => !activeAttemptRefs.has(a.attemptRef))
      for (const attempt of attempts) {
        if (attempt.terminal === null) {
          try {
            await this.writer(lifetime).recordTerminal(attempt.attemptRef, {
              version: 1,
              phase: 'dead',
              identity: attempt.request.identity,
              reason: 'attempts_exhausted',
            })
          } catch {
            // ignore
          }
        }
        try {
          await this.cleanupTerminalOwned(
            attempt.attemptRef,
            attempt.consumerId,
            lifetime,
          )
        } catch {
          // ignore
        }
        try {
          await this.writer(lifetime).acknowledge(
            attempt.attemptRef,
            attempt.consumerId,
          )
        } catch {
          // ignore
        }
      }
    })
  }

  private async cleanupTerminalOwned(
    attemptRef: string,
    consumerId: string,
    lifetime: WalletOperationLifetime,
  ): Promise<void> {
    this.assertOwner()
    const attempt = this.journal
      .getAll()
      .find(a => a.attemptRef === attemptRef && a.consumerId === consumerId)
    if (!attempt || attempt.terminal === null)
      throw new Error('canonical-wallet:terminal-required')
    if (attempt.cleanupComplete) return
    const members = attempt.request.parts.transactions
    for (const [i, reservation] of attempt.reservations.entries()) {
      const record = this.wallet.pool.getRecord(reservation.index)
      if (
        !record ||
        (record.status !== 'in-use' &&
          record.status !== 'spent' &&
          record.status !== 'retired')
      )
        throw new Error('canonical-wallet:cleanup-hold')
      if (record.status === 'in-use') {
        if (
          attempt.terminal.phase === 'delivered' &&
          record.lifecycle?.spend === undefined
        ) {
          // A spent account must retain its exact signed spend, or the wallet's own
          // lifecycle validation rejects the whole owner on the next operation or reopen.
          const rawTx = hexlify(members[i])
          const tx = Transaction.from(rawTx)
          if (tx.from?.toLowerCase() !== record.address.toLowerCase())
            throw new Error('canonical-wallet:cleanup-hold')
          await canonicalAdmissionPool(
            this.wallet.walletState.inputAdmission,
            lifetime,
          ).recordSpend(record.index, {
            rawTx,
            txHash: tx.hash!,
            valueWei: tx.value.toString(),
          })
          // The status change below rewrites the same row; make the spend durable first so
          // the two writes cannot commit out of order.
          await this.flushCanonicalReservations()
        }
        const live = canonicalLiveLeases
          .get(this.wallet.walletState)
          ?.get(record.index)
        if (live) {
          await canonicalAdmissionPool(
            this.wallet.walletState.inputAdmission,
            lifetime,
          ).release(
            live,
            attempt.terminal.phase === 'delivered' ? 'confirmed' : 'failed',
          )
          canonicalLiveLeases.get(this.wallet.walletState)!.delete(record.index)
        } else {
          if (this.wallet.leaseManager.isLeased(record.index))
            throw new Error('canonical-wallet:foreign-lease-hold')
          await canonicalAdmissionPool(
            this.wallet.walletState.inputAdmission,
            lifetime,
          ).setStatus(
            record.index,
            attempt.terminal.phase === 'delivered' ? 'spent' : 'retired',
          )
        }
      }
    }
    await this.flushCanonicalReservations()
    await this.writer(lifetime).completeCleanup(attemptRef)
  }

  cleanupTerminal(attemptRef: string, consumerId: string): Promise<void> {
    return this.wallet.runCanonicalExclusive(lifetime =>
      this.cleanupTerminalOwned(attemptRef, consumerId, lifetime),
    )
  }
  acknowledgeWorkflow(attemptRef: string, consumerId: string): Promise<void> {
    return this.wallet.runCanonicalExclusive(lifetime =>
      this.writer(lifetime).acknowledge(attemptRef, consumerId),
    )
  }
  wasAcknowledged(attemptRef: string): boolean {
    return this.journal.wasAcknowledged(attemptRef)
  }

  terminalOutcomes(): readonly CanonicalJournalAttempt[] {
    this.assertOwner()
    return this.journal.getAll().filter(a => a.terminal !== null)
  }
}
