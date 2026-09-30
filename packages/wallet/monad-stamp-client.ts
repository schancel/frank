/**
 * Client-side Stamp-over-Monad message submission (ticket #13).
 *
 * **Read this header's "Correction" note first** — this ticket's original body described a
 * pubkey-preimage commitment scheme that ticket #27 (merged, live) did *not* ship. The comment on
 * issue #13 (2026-09-xx) corrected the acceptance criteria; this file implements the corrected
 * version only. See `backend/cashweb/cashweb-registry/proto/monad_message.proto` and
 * `backend/cashweb/cashweb-registry/src/http/monad_message.rs` for the live server-side contract
 * this module targets byte-for-byte.
 *
 * ## What this does
 *
 * 1. Computes `h_m = SHA256(encrypted_payload)` as `MonadStampedMessage.payload_hash`. Each
 *    payment carries `SHA256("frank:dm-stamp-payment:v1" || h_m || uint32_be(child_index))`, so
 *    split payments do not repeat a trivially linkable calldata value. Unlike Lotus's
 *    `SHA256(SHA256(pubkey) || payload_hash)` preimage, there is deliberately no pubkey folded in
 *    here — see `monad_message.proto`'s module doc and `monad_stamp_verify.rs`'s
 *    `calc_expected_commitment` doc comment (that function documents the *Lotus-mirroring* preimage
 *    math used for the Lotus-style `ADDRESS_METADATA_LOKAD_ID` path elsewhere in that module; the
 *    live `PUT /message/monad` handler, `process_monad_message` in `http/monad_message.rs`, never
 *    calls it — it builds the expected payment directly from
 *    `SHA256(encrypted_payload)`, confirmed by reading that function's body).
 * 2. Builds each payment transaction's calldata as `<BROADCAST_MESSAGE_LOKAD_ID: 4 bytes><version: 1
 *    byte><per-child commitment: 32 bytes>` (37 bytes total) — the exact layout
 *    `cashweb_registry::monad_stamp_verify::parse_commitment_calldata` decodes (see
 *    `backend/cashweb/cashweb-registry/src/monad_stamp_verify.rs` lines 139-172:
 *    `CALLDATA_PREFIX_LEN = 5` for `<lokad_id><version>`, then `CALLDATA_COMMITMENT_LEN = 32` for
 *    the commitment, checked byte-range-exact, no padding/trailing bytes tolerated). The LOKAD ID
 *    used is `BROADCAST_MESSAGE_LOKAD_ID = *b"POND"`, defined in
 *    `backend/cashweb/cashweb-payload/src/verify.rs:15` and threaded into the live handler via
 *    `http/monad_message.rs`'s `use cashweb_payload::verify::BROADCAST_MESSAGE_LOKAD_ID;` /
 *    the relay's expected stamp transaction (not the Lotus private-message
 *    LOKAD ID, and not `ADDRESS_METADATA_LOKAD_ID` — reused for symmetry with the broadcast path per
 *    #27's own reasoning, not because this is conceptually a broadcast message). The version byte is
 *    `monad_stamp_verify::COMMITMENT_VERSION_TAG = 0x02`; version 2 identifies the split,
 *    child-bound direct-message payment format.
 * 3. Greedily selects one or more distinct, single-use funding accounts, aiming for at least two
 *    transactions when the account distribution permits it. Each transaction pays a distinct
 *    one-time child of the recipient's registered public key; values are not artificially equal.
 * 4. Assembles a `MonadStampedMessage { stamp_payments, encrypted_payload, payload_hash }` and encodes
 *    it as protobuf wire bytes (see "Protobuf encoding" below), then does the actual
 *    `PUT /message/monad` HTTP call — ticket #27's own scope was server-side only and explicitly
 *    left this client-side gap open (see `http/monad_message.rs`'s module doc, "completing the
 *    wiring `crate::monad_stamp_relay`'s module docs left for whoever picks up the wire format
 *    decision" — that "whoever" on the client side is this ticket).
 * 5. Releases the lease once the outcome is known — see "Lease release policy" below for exactly
 *    when/how. Since PR #197, `PUT /message/monad` claims the exact raw payment set durably and may
 *    answer 503 `mailbox_retryable` before delivery completes, so success is a 200 (possibly on an
 *    idempotent re-PUT of the same bytes), not merely "the request was accepted".
 *
 * ## Protobuf encoding
 *
 * Uses real generated protobuf bindings (`./proto/monad_message.proto` -> `./monad_message_pb.js`/
 * `.d.ts`, via `./generate_protobufs.sh`), matching this app's established pattern elsewhere (see
 * e.g. `../registry/broadcast_pb.js`, `../registry/generate_protobufs.sh`). An earlier revision of
 * this file hand-encoded the wire format directly against `google-protobuf`'s low-level
 * `BinaryWriter`/`BinaryReader` primitives, because this environment's bundled `protoc` (the
 * `protoc` npm package, v1.0.4) ships a 32-bit binary that can't execute on a modern host. Fixed by
 * installing a working toolchain instead of working around it: `brew install protobuf
 * protoc-gen-js` (the system `protoc` no longer bundles `--js_out` codegen; `protoc-gen-js` is now
 * a separate plugin) plus this package's own `node_modules/.bin/protoc-gen-ts` (already a
 * dependency, `ts-protoc-gen`) for `--ts_out`. `generate_protobufs.sh` documents the exact command.
 * `encodeMonadStampedMessage`/`decodeMonadStampedMessage`/`decodeStoredMonadMessage` below are thin
 * wrappers converting between the generated `jspb.Message` classes and this file's plain-object
 * `MonadStampedMessageProto`/`StoredMonadMessageProto` shapes, so the rest of this file (and its
 * tests) didn't need to change when the encoding underneath them did.
 *
 * ## Lease release policy (PR #197 durable mailbox semantics)
 *
 * `SubAccountLeaseManager.releaseLease` (#18) only accepts three outcomes: `'confirmed'`
 * (`'in-use' -> 'spent'`, corrected by ticket #34 — see that file's own header for why this never
 * goes back to `'available'`), or `'failed'`/`'stuck'` (`'in-use' -> 'retired'`, never reused with a
 * guessed nonce). `PUT /message/monad` no longer blocks until the payments are confirmed: the relay
 * claims the exact raw payment set in a durable outbox, reconciles it, and answers
 *
 *   - **200** (`StoredMonadMessage`): durably delivered to the recipient inbox. → `'confirmed'`.
 *     `PUT` of a set that is *already* delivered also answers 200 with the stored record
 *     (`admit_monad_message`'s `DeliveredExact` arm), so **an idempotent re-`PUT` of the same exact
 *     bytes is the confirmation**. The relay exposes no sender-side read route any more
 *     (`GET /message/monad/:payload_hash` was removed), and none is needed.
 *   - **503 `mailbox_retryable`** (outbox pending/at capacity/relay busy/RPC timeout/storage
 *     hiccup), **429**, or **no HTTP response / an unverifiable 2xx**: the outcome is not final.
 *     The client retries the SAME encoded bytes with bounded exponential backoff (honouring
 *     `Retry-After`; `putRetry`). Never a freshly signed set: that would pay twice.
 *     If the budget is spent: `exact_set_retained: false` → nothing was claimed, released
 *     `'failed'` and {@link MonadStampRejectedError}; otherwise the set may be owned by the relay,
 *     so with an attempt journal the reservations and journal are kept and
 *     {@link MonadStampPendingAttemptError} is thrown (`resumePendingAttempts` re-PUTs later);
 *     without a journal leases are retired `'stuck'` and {@link MonadStampAbandonedError} is thrown.
 *   - **409 `mailbox_conflict`** (payload hash already bound to a different payment set) and
 *     **422 `mailbox_terminal`** (the durable claim reached a terminal state, e.g. stale nonce or
 *     expiry): re-sending can never succeed. Journal entry dropped, leases retired (`'stuck'` when
 *     the relay still owns the bytes, else `'failed'`), {@link MonadStampTerminalError} thrown —
 *     distinct from a plain rejection so callers know the exact set is dead and a *new* send is the
 *     only way forward.
 *   - **404**: the relay has no mailbox (disabled/old). Nothing was admitted; leases released
 *     `'failed'`, {@link MonadMailboxUnavailableError} thrown.
 *   - **400** and other 4xx: rejected before/without retention (`exact_set_retained`, as before).
 *   - **Building/signing a payment itself throws** (before any network call to the relay at all —
 *     e.g. a bad address, or a transient RPC failure while `MonadAccountTxSigner` reads
 *     gas/fee/nonce from the chain): released as `'failed'`. No transaction was ever broadcast in
 *     this case, so the sub-account's nonce is not actually at risk — but `releaseLease` has no
 *     "never attempted, fully safe to reuse immediately" outcome, and this module's ownership rules
 *     forbid adding one to `monad-account-lease.ts`. This trades a small amount of pool capacity
 *     for staying strictly within the existing three-outcome contract.
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
import axios from 'axios'

import { MonadMailboxUnavailableError } from '@frank/cashweb/relay/monad-mailbox-client'
import __pb_monad_message_pb from '@frank/cashweb/relay/monad_message_pb'
const { MonadStampedMessage, StoredMonadMessage } = __pb_monad_message_pb
const { MonadStampPayment } = __pb_monad_message_pb
import { MonadSubAccountPool } from './monad-account-pool'
import {
  AccountLeaseHandle,
  AcquireLeaseWhenAvailableOptions,
  NoAvailableSubAccountError,
  SubAccountLeaseManager,
} from './monad-account-lease'
import {
  MonadAccountTxSigner,
  MonadTxOverrides,
  MonadTxSubmitter,
  SignedMonadTx,
} from './monad-account-tx'
import { MonadWalletHandle } from './monad-wallet-handle'
import { selectStampAccounts } from './monad-stamp-account-selection'
import {
  deriveMonadStampChildPrivate,
  deriveMonadStampChildPublic,
} from './monad-stamp-stealth'
import {
  ChangeSweepOutcome,
  MonadChangePool,
  estimateDustThresholdWei,
  releaseLeaseAndSweepChange,
} from './monad-change-pool'

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

/** Encode a {@link MonadStampedMessageProto} to protobuf wire-format bytes, via the generated
 * `MonadStampedMessage` class. */
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

/** Decode protobuf wire-format bytes into a {@link MonadStampedMessageProto}. Round-trips with
 * {@link encodeMonadStampedMessage}. */
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

/** Decode protobuf wire-format bytes into a {@link StoredMonadMessageProto} — what the relay
 * returns from both `PUT /message/monad` and `GET /message/monad/:payload_hash`. */
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

/** Hex-encode `bytes` with no `0x` prefix — the shape Rust's `hex::decode` (used by
 * `handle_get_monad_message`'s `:payload_hash` path segment) expects. */
function toBareHex(bytes: Uint8Array): string {
  return hexlify(bytes).slice(2)
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
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

function relayRejectionDetail(detail: unknown): string | undefined {
  if (typeof detail === 'string') return detail
  const body = relayErrorBody(detail)
  const error = typeof body?.error === 'string' ? body.error : undefined
  // The relay's human-readable `detail` distinguishes, e.g., the per-recipient/global unconfirmed
  // claim cap ("...outbox is temporarily at capacity", 503 with exact_set_retained=false: nothing
  // was claimed) from "the exact set is pending" (503 with exact_set_retained=true).
  const text = typeof body?.detail === 'string' ? body.detail : undefined
  return error !== undefined && text !== undefined
    ? `${error}: ${text}`
    : error ?? text
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

const MAX_STAMP_PAYMENTS = 64
export const MAX_MONAD_STAMPED_MESSAGE_BYTES = 2 * 1024 * 1024

/** Parses a relay JSON error body (`{ error, detail, exact_set_retained }`), which axios hands
 * back as raw bytes under `responseType: 'arraybuffer'`. */
function relayErrorBody(
  responseData: unknown,
): Record<string, unknown> | undefined {
  let parsed = responseData
  if (responseData instanceof ArrayBuffer || ArrayBuffer.isView(responseData)) {
    try {
      const bytes =
        responseData instanceof ArrayBuffer
          ? new Uint8Array(responseData)
          : new Uint8Array(
              responseData.buffer,
              responseData.byteOffset,
              responseData.byteLength,
            )
      parsed = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      return undefined
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  return parsed as Record<string, unknown>
}

function exactSetRetained(responseData: unknown): boolean | undefined {
  const value = relayErrorBody(responseData)?.exact_set_retained
  return typeof value === 'boolean' ? value : undefined
}

function relayErrorCode(responseData: unknown): string | undefined {
  const value = relayErrorBody(responseData)?.error
  return typeof value === 'string' ? value : undefined
}

/** Terminal relay verdicts for one exact set (`409`/`422`), else undefined. */
function terminalCode(
  status: number,
  responseData: unknown,
): 'mailbox_conflict' | 'mailbox_terminal' | undefined {
  const code = relayErrorCode(responseData)
  if (status === 409 && code === 'mailbox_conflict') return code
  if (status === 422 && code === 'mailbox_terminal') return code
  return undefined
}

/** A response that means "not final yet, re-PUT the same bytes". */
function isRetryablePutResponse(status: number, responseData: unknown) {
  return (
    status === 429 ||
    (status === 503 && relayErrorCode(responseData) === 'mailbox_retryable')
  )
}

function retryAfterMs(headers: unknown): number | undefined {
  const raw = (headers as Record<string, unknown> | undefined)?.['retry-after']
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = typeof raw === 'string' ? Date.parse(raw) : NaN
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Idempotent re-`PUT` policy for a non-final outcome (`503 mailbox_retryable`, `429`, no response;
 * see this file's header, "Lease release policy"). Every attempt sends the identical bytes. */
export interface PutRetryOptions {
  /** Total `PUT` attempts including the first. Default 5. */
  maxAttempts?: number
  /** First backoff delay in ms; doubles each attempt (a larger `Retry-After` wins). Default 1000. */
  intervalMs?: number
  /** Cap for one delay in ms, including `Retry-After`. Default 15000. */
  maxDelayMs?: number
  /** Injectable in place of the real `setTimeout`-based delay, for deterministic tests. */
  sleep?: (ms: number) => Promise<void>
}

/** Params for `MonadStampClient.submitStampedMessage`. */
export interface StampMonadMessageParams {
  /** The message payload, already encrypted for its recipient(s) — this module is opaque to its
   * contents, per `monad_message.proto`'s own doc comment on `encrypted_payload`. */
  encryptedPayload: Uint8Array
  /** Recipient's registered compressed secp256k1 public key. It derives the one-time payment
   * destinations; the recipient address itself is never a payment destination. */
  recipientPublicKey: Uint8Array
  /** Aggregate stamp-payment value, in wei, across the selected sender accounts. */
  stampValueWei: bigint
  overrides?: MonadTxOverrides
  /** If provided, waits (`acquireLeaseWhenAvailable`) for a sub-account to free up instead of
   * failing immediately when the pool is fully leased. Omit for the default immediate-reject
   * behavior (`SubAccountLeaseManager.acquireLease`). */
  waitForLease?: AcquireLeaseWhenAvailableOptions
  /** Overrides the default idempotent re-`PUT` backoff (see this file's header, "Lease release
   * policy"). */
  putRetry?: PutRetryOptions
}

/** Outcome of a successful `submitStampedMessage` call — the relay durably delivered the message
 * (see this file's header: a 200 `PUT /message/monad` response, on the first send or on an
 * idempotent re-`PUT`, is the only way to reach this). */
export interface StampMonadMessageResult {
  stored: StoredMonadMessageProto
  /** Bare (no `0x`) hex of `h_m`. */
  payloadHashHex: string
  txHashes: string[]
  leaseIndices: number[]
  /** One result per confirmed payment account when an HD change pool is configured. Sweeps are
   * deliberately serial so every account receives a distinct monotonically-derived change
   * destination. A failed sweep is reported here and does not undo an accepted message. */
  changeSweeps: Array<ChangeSweepOutcome | undefined>
}

/**
 * Ties together sub-account leasing (#14/#18), payment construction (#11), and the live
 * `PUT /message/monad` HTTP surface (#27) into one call:
 * "stamp this encrypted payload onto Monad and hand it to the relay." See this file's header for
 * the full commitment/calldata/protobuf/lease-release design.
 */
export class MonadStampClient {
  private readonly pool: MonadSubAccountPool
  private readonly leaseManager: SubAccountLeaseManager
  private readonly provider: Provider
  private readonly httpClient: MonadTxSubmitter
  private readonly changePool: MonadChangePool | undefined
  private readonly attemptJournal: MonadWalletHandle['stampAttemptJournal']
  /** Base URL of the `cashweb-registry` relay, e.g. `https://relay.example.com` — no trailing
   * slash. `/message/monad` (`PUT`) is appended to it. */
  private readonly relayBaseUrl: string

  constructor(params: MonadWalletHandle) {
    this.pool = params.pool
    this.leaseManager = params.leaseManager
    this.provider = params.provider
    this.httpClient = params.httpClient
    this.changePool = params.changePool
    this.attemptJournal = params.stampAttemptJournal
    this.relayBaseUrl = params.relayBaseUrl.replace(/\/+$/, '')
  }

  /** `PUT` the exact bytes, re-sending the identical bytes while the outcome is not final. A 200
   * for an already-delivered set returns the stored record, so re-sending is the confirmation. */
  private async putStampedMessage(
    message: MonadStampedMessageProto,
    encoded = encodeMonadStampedMessage(message),
    retry?: PutRetryOptions,
  ): Promise<StoredMonadMessageProto> {
    const maxAttempts = Math.max(1, retry?.maxAttempts ?? 5)
    const baseDelayMs = retry?.intervalMs ?? 1000
    const maxDelayMs = retry?.maxDelayMs ?? 15_000
    const sleep = retry?.sleep ?? defaultSleep
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.putStampedMessageOnce(message, encoded)
      } catch (err) {
        let hintMs: number | undefined
        if (axios.isAxiosError(err) && err.response) {
          if (!isRetryablePutResponse(err.response.status, err.response.data)) {
            throw err
          }
          hintMs = retryAfterMs(err.response.headers)
        }
        // No response, an unverifiable 2xx, 429, or 503 mailbox_retryable: not final.
        if (attempt >= maxAttempts) throw err
        await sleep(
          Math.min(
            maxDelayMs,
            Math.max(baseDelayMs * 2 ** (attempt - 1), hintMs ?? 0),
          ),
        )
      }
    }
  }

  private async putStampedMessageOnce(
    message: MonadStampedMessageProto,
    encoded: Uint8Array,
  ): Promise<StoredMonadMessageProto> {
    const response = await axios({
      method: 'put',
      url: `${this.relayBaseUrl}/message/monad`,
      data: encoded,
      // Bug fix (ticket #8's e2e demo): this used to send `application/octet-stream`, which the
      // live `PUT /message/monad` route always rejected with a `400 wrong-content-type` --
      // `handle_put_monad_message` decodes its body via the same generic
      // `cashweb_http_utils::protobuf::Protobuf` extractor every other protobuf route in this
      // crate uses, and that extractor unconditionally requires exactly
      // `CONTENT_TYPE_PROTOBUF = "application/x-protobuf"` (see `cashweb-http-utils/src/
      // protobuf.rs`). Confirmed live: every `submitStampedMessage` call failed with this error
      // until this header was fixed to match. `application/octet-stream` never worked against
      // the real server.
      headers: { 'Content-Type': 'application/x-protobuf' },
      responseType: 'arraybuffer',
    })
    const stored = decodeStoredMonadMessage(new Uint8Array(response.data))
    if (
      stored.message === undefined ||
      !bytesEqual(encodeMonadStampedMessage(stored.message), encoded)
    ) {
      // A 2xx only proves that an HTTP peer answered. It does not prove that the relay retained
      // this exact payment set. Treat a missing/different nested message like a lost response so
      // the caller keeps its journal and reservations until the exact read side confirms it.
      throw new Error(
        'Relay returned success without the exact submitted Monad-stamped message',
      )
    }
    return stored
  }

  /**
   * Stamps `params.encryptedPayload` onto Monad end-to-end: computes `h_m`, builds the calldata,
   * leases distinct funding accounts, builds+signs the payments, `PUT`s the assembled message to
   * the relay, and releases the lease per this file's header's documented policy. Throws
   * {@link MonadStampRejectedError} if the relay definitively rejected the message, or
   * {@link MonadStampAbandonedError} if a network failure left the outcome unresolved even after the
   * fallback `GET` poll.
   */
  async submitStampedMessage(
    params: StampMonadMessageParams,
  ): Promise<StampMonadMessageResult> {
    if (params.encryptedPayload.length === 0) {
      throw new Error('encryptedPayload must not be empty')
    }
    if (params.encryptedPayload.length > MAX_MONAD_STAMPED_MESSAGE_BYTES) {
      throw new Error(
        `encryptedPayload exceeds the ${MAX_MONAD_STAMPED_MESSAGE_BYTES}-byte message limit`,
      )
    }
    if (
      this.attemptJournal !== undefined &&
      this.attemptJournal.getAll().length > 0
    ) {
      const recovered = await this.resumePendingAttempts(params.putRetry)
      if (recovered.length > 0) {
        throw new MonadStampRecoveredAttemptError(recovered)
      }
      const stillPending = this.attemptJournal
        .getAll()
        .map(attempt => attempt.payloadHashHex)
      if (stillPending.length > 0) {
        throw new MonadStampPendingAttemptError(stillPending)
      }
    }

    const payloadHash = computeMonadStampCommitment(params.encryptedPayload)
    // Quote with an all-nonzero commitment. The RPC therefore applies the active network's
    // worst-case calldata schedule (including EIP-7623) without this client hardcoding gas-table
    // arithmetic that could become stale after another repricing.
    const quoteCalldata = buildMonadStampCalldata(
      new Uint8Array(STAMP_COMMITMENT_LENGTH).fill(0xff),
    )
    const payloadHashHex = toBareHex(payloadHash)
    const quoteDestination = deriveMonadStampChildPublic({
      payloadHash,
      recipientPublicKey: params.recipientPublicKey,
      paymentIndex: 0,
    }).address

    let availableRecords = this.pool
      .records()
      .filter(candidate => candidate.status === 'available')
    if (availableRecords.length === 0 && params.waitForLease !== undefined) {
      const sleep = params.waitForLease.sleep ?? defaultSleep
      const now = params.waitForLease.now ?? Date.now
      const pollIntervalMs = params.waitForLease.pollIntervalMs ?? 250
      const deadline = now() + (params.waitForLease.timeoutMs ?? 30_000)
      while (availableRecords.length === 0 && now() < deadline) {
        await sleep(pollIntervalMs)
        availableRecords = this.pool
          .records()
          .filter(candidate => candidate.status === 'available')
      }
    }
    if (availableRecords.length === 0) {
      throw new NoAvailableSubAccountError(
        'No available sub-account to quote for a stamp payment',
      )
    }

    const quotes: Array<{
      index: number
      address: string
      balanceWei: bigint
      capacityWei: bigint
      resolvedOverrides: MonadTxOverrides
    }> = []
    for (const record of availableRecords) {
      const balance = await this.provider.getBalance(record.address)
      if (balance <= BigInt(0)) continue
      const signer = this.pool.getSigner(record.index, {
        provider: this.provider,
        httpClient: this.httpClient,
      })
      // Resolve the exact nonce/gas/fee fields with a one-wei probe. No transaction is submitted.
      // Every derived destination is an EOA, so changing only its address and value does not alter
      // the calldata execution cost.
      const probe = await signer.buildAndSignCall(
        quoteDestination,
        BigInt(1),
        quoteCalldata,
        params.overrides,
      )
      const feePerGas = probe.maxFeePerGas ?? probe.gasPrice
      if (feePerGas === undefined) {
        throw new Error('Unable to determine a maximum fee for stamp payment')
      }
      const quotedGasLimit = params.overrides?.gasLimit ?? probe.gasLimit
      const feeReserveWei = quotedGasLimit * feePerGas
      const capacityWei =
        balance > feeReserveWei ? balance - feeReserveWei : BigInt(0)
      quotes.push({
        index: record.index,
        address: record.address,
        balanceWei: balance,
        capacityWei,
        resolvedOverrides: {
          nonce: probe.nonce,
          // A caller-supplied limit is deliberate. Otherwise each final child is estimated with
          // its actual commitment bytes; the capacity quote above reserves the worst-case
          // zero/nonzero calldata variance.
          gasLimit: params.overrides?.gasLimit,
          maxFeePerGas: probe.maxFeePerGas,
          maxPriorityFeePerGas: probe.maxPriorityFeePerGas,
          gasPrice: probe.gasPrice,
          chainId: probe.chainId,
        },
      })
    }

    const selected = selectStampAccounts({
      amountWei: params.stampValueWei,
      accounts: quotes,
      maxTransactions: MAX_STAMP_PAYMENTS,
    })
    if (selected.length > MAX_STAMP_PAYMENTS) {
      throw new Error(
        `Stamp payment requires ${selected.length} accounts; relay maximum is ${MAX_STAMP_PAYMENTS}`,
      )
    }
    const quoteByIndex = new Map(quotes.map(quote => [quote.index, quote]))
    const handles: AccountLeaseHandle[] = []
    const signedTxs: SignedMonadTx[] = []
    try {
      // Claim the complete selected set synchronously before the first signing `await`, so no
      // concurrent sender in this process can take a later member between transactions.
      for (const selection of selected) {
        handles.push(this.leaseManager.acquireForIndex(selection.index))
      }
      // Make account reservations durable before producing any signed transaction. If the process
      // dies while signing, startup recovery retires these unjournaled reservations rather than
      // making an uncertain nonce available again.
      await this.pool.flush()
      for (const [paymentIndex, selection] of selected.entries()) {
        const handle = handles[paymentIndex]
        const signer = this.pool.getSigner(handle.index, {
          provider: this.provider,
          httpClient: this.httpClient,
        })
        const destination = deriveMonadStampChildPublic({
          payloadHash,
          recipientPublicKey: params.recipientPublicKey,
          paymentIndex,
        })
        const quote = quoteByIndex.get(selection.index)
        if (quote === undefined)
          throw new Error('Selected account lost its quote')
        const signedTx = await signer.buildAndSignCall(
          destination.address,
          selection.paymentValueWei,
          buildMonadStampCalldata(
            computeMonadStampPaymentCommitment(payloadHash, paymentIndex),
          ),
          quote.resolvedOverrides,
        )
        const feePerGas = signedTx.maxFeePerGas ?? signedTx.gasPrice
        if (
          feePerGas === undefined ||
          signedTx.value + signedTx.gasLimit * feePerGas > quote.balanceWei
        ) {
          throw new Error(
            `Final stamp payment at funding index ${selection.index} exceeds its quoted account capacity`,
          )
        }
        signedTxs.push(signedTx)
      }
    } catch (err) {
      for (const handle of handles) {
        this.leaseManager.releaseLease(handle, 'failed')
      }
      await this.pool.flush()
      throw err
    }

    const message: MonadStampedMessageProto = {
      stampPayments: signedTxs.map((signedTx, childIndex) => ({
        childIndex,
        rawTx: getBytes(signedTx.rawTx),
      })),
      encryptedPayload: params.encryptedPayload,
      payloadHash,
    }
    const encodedMessage = encodeMonadStampedMessage(message)
    if (encodedMessage.byteLength > MAX_MONAD_STAMPED_MESSAGE_BYTES) {
      for (const handle of handles) {
        this.leaseManager.releaseLease(handle, 'failed')
      }
      await this.pool.flush()
      throw new Error(
        `Encoded Monad stamped message is ${encodedMessage.byteLength} bytes; maximum is ${MAX_MONAD_STAMPED_MESSAGE_BYTES}`,
      )
    }
    try {
      await this.attemptJournal?.put({
        payloadHashHex,
        messageBytes: Array.from(encodedMessage),
        leaseIndices: handles.map(handle => handle.index),
      })
    } catch (err) {
      for (const handle of handles) {
        this.leaseManager.releaseLease(handle, 'failed')
      }
      await this.pool.flush()
      throw err
    }
    const releaseAll = async (
      outcome: 'confirmed' | 'failed' | 'stuck',
    ): Promise<Array<ChangeSweepOutcome | undefined>> => {
      const sweeps: Array<ChangeSweepOutcome | undefined> = []
      for (const handle of handles) {
        const signer = this.pool.getSigner(handle.index, {
          provider: this.provider,
          httpClient: this.httpClient,
        })
        const released = await releaseLeaseAndSweepChange({
          manager: this.leaseManager,
          handle,
          outcome,
          sweep:
            this.changePool === undefined
              ? undefined
              : {
                  changePool: this.changePool,
                  burnAccountSigner: signer,
                  provider: this.provider,
                },
        })
        sweeps.push(released.sweep)
        if (
          released.sweep?.swept === false &&
          released.sweep.reason !== 'below-dust-threshold'
        ) {
          break
        }
      }
      return sweeps
    }

    let stored: StoredMonadMessageProto
    try {
      stored = await this.putStampedMessage(
        message,
        encodedMessage,
        params.putRetry,
      )
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        const { status, data } = err.response
        const retained = exactSetRetained(data)
        const detail = relayRejectionDetail(data)
        if (status === 404) {
          // No mailbox routes: the relay never saw or admitted these bytes.
          await releaseAll('failed')
          await this.attemptJournal?.delete(payloadHashHex)
          throw new MonadMailboxUnavailableError(
            'PUT /message/monad: HTTP 404: the relay has no Monad mailbox (disabled or too old); the message was not sent',
            404,
          )
        }
        const terminal = terminalCode(status, data)
        if (terminal !== undefined) {
          // The exact set is dead at the relay: never re-send it, never reuse its accounts.
          await releaseAll(retained === false ? 'failed' : 'stuck')
          await this.attemptJournal?.delete(payloadHashHex)
          throw new MonadStampTerminalError(
            `Relay ended this Monad-stamped payment set (HTTP ${status} ${terminal})${
              detail ? `: ${detail}` : ''
            }; build a new message to retry`,
            status,
            terminal,
            retained,
            data,
          )
        }
        if (retained === false) {
          await releaseAll('failed')
          await this.attemptJournal?.delete(payloadHashHex)
          throw new MonadStampRejectedError(
            `Relay rejected the Monad-stamped message before retaining its payment set (HTTP ${status})${
              detail ? `: ${detail}` : ''
            }`,
            status,
            data,
          )
        }
        if (this.attemptJournal !== undefined) {
          // The relay may own this exact set (or a prefix of it was accepted). Keep the journal and
          // reservations so `resumePendingAttempts` can re-PUT the identical bytes; presenting
          // this as a terminal rejection could prompt a caller to create a second salted payment
          // and pay twice.
          throw new MonadStampPendingAttemptError([payloadHashHex])
        }
        if (isRetryablePutResponse(status, data)) {
          await releaseAll('stuck')
          throw new MonadStampAbandonedError(
            `Monad stamp submission abandoned: the relay kept answering HTTP ${status}${
              detail ? ` (${detail})` : ''
            } through the retry budget`,
            payloadHashHex,
          )
        }
        await releaseAll('failed')
        throw new MonadStampRejectedError(
          `Relay rejected the Monad-stamped message (HTTP ${status})${
            detail ? `: ${detail}` : ''
          }`,
          status,
          data,
        )
      }

      // No HTTP response (or an unverifiable 2xx) through the whole idempotent-retry budget: the
      // relay may still own the exact bytes, so retire the accounts rather than guess.
      await releaseAll('stuck')
      throw new MonadStampAbandonedError(
        'Monad stamp submission abandoned: no usable response from the relay through ' +
          `the retry budget for PUT /message/monad (${payloadHashHex})`,
        payloadHashHex,
      )
    }

    const changeSweeps = await releaseAll('confirmed')
    if (
      changeSweeps.some(
        sweep =>
          sweep?.swept === false && sweep.reason !== 'below-dust-threshold',
      )
    ) {
      throw new MonadStampPendingAttemptError([payloadHashHex])
    }
    await this.attemptJournal?.delete(payloadHashHex)
    return {
      stored,
      payloadHashHex,
      txHashes: signedTxs.map(signedTx => signedTx.txHash),
      leaseIndices: handles.map(handle => handle.index),
      changeSweeps,
    }
  }

  /** Replay crash-surviving attempts byte-for-byte. Exact-set relay binding makes this safe when
   * only a prefix of the transactions landed before the previous process stopped. */
  async resumePendingAttempts(retry?: PutRetryOptions): Promise<string[]> {
    if (this.attemptJournal === undefined) return []
    const completed: string[] = []
    for (const attempt of this.attemptJournal.getAll()) {
      // The journal write and pool-status writes live in separate LevelDBs. A hard crash can make
      // the durable raw set visible before one of the earlier `in-use` status writes. Reassert the
      // reservation before any network await so the wallet can never return an apparently
      // available account that belongs to this pending set.
      for (const index of attempt.leaseIndices) {
        const record = this.pool.getRecord(index)
        if (record?.status === 'available') this.pool.setStatus(index, 'in-use')
      }
      await this.pool.flush()
      try {
        const message = decodeMonadStampedMessage(
          Uint8Array.from(attempt.messageBytes),
        )
        await this.putStampedMessage(message, undefined, retry)
        for (const index of attempt.leaseIndices) {
          const record = this.pool.getRecord(index)
          if (record !== undefined && record.status !== 'spent') {
            this.pool.setStatus(index, 'spent')
            await this.pool.flush()
          }
          if (record !== undefined && this.changePool !== undefined) {
            const signer = this.pool.getSigner(index, {
              provider: this.provider,
              httpClient: this.httpClient,
            })
            const sweep = await this.changePool.sweepToChange({
              burnIndex: index,
              burnAddress: record.address,
              burnAccountSigner: signer,
              provider: this.provider,
            })
            if (!sweep.swept && sweep.reason === 'sweep-pending') {
              throw new MonadStampPendingAttemptError([attempt.payloadHashHex])
            }
          }
        }
        await this.attemptJournal.delete(attempt.payloadHashHex)
        completed.push(attempt.payloadHashHex)
      } catch (err) {
        if (
          axios.isAxiosError(err) &&
          err.response &&
          (exactSetRetained(err.response.data) === false ||
            terminalCode(err.response.status, err.response.data) !== undefined)
        ) {
          for (const index of attempt.leaseIndices) {
            const record = this.pool.getRecord(index)
            if (record !== undefined && record.status !== 'spent') {
              this.pool.setStatus(index, 'retired')
            }
          }
          await this.pool.flush()
          await this.attemptJournal.delete(attempt.payloadHashHex)
        }
        // Otherwise retain the raw set and keep its accounts unavailable for a later retry.
      }
    }
    return completed
  }
}
