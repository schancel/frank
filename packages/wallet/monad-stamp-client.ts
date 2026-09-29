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
 *    when/how, since `PUT /message/monad`'s handler is itself synchronous end-to-end (broadcast +
 *    poll-for-confirmation happens server-side, inside the request), which changes what "success"
 *    means for the lease compared to a fire-and-forget submit.
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
 * ## Lease release policy
 *
 * `SubAccountLeaseManager.releaseLease` (#18) only accepts three outcomes: `'confirmed'`
 * (`'in-use' -> 'spent'`, corrected by ticket #34 — see that file's own header for why this never
 * goes back to `'available'`), or `'failed'`/`'stuck'` (`'in-use' -> 'retired'`, never reused with a
 * guessed nonce). This module maps the three ways a `submitStampedMessage` call can end onto those:
 *
 *   - **`PUT /message/monad` returns 2xx**: the relay only reaches its success response after
 *     `StampRelayOutcome::Verified` (see `process_monad_message` in `http/monad_message.rs` — every
 *     other outcome is a rejection *before* any store happens), i.e. every payment is already
 *     confirmed on-chain by the time this resolves. → `'confirmed'`.
 *   - **`PUT /message/monad` returns an HTTP error response** (4xx/5xx — the relay was reached and
 *     definitively responded): per the same handler, a stored message only ever exists after
 *     `Verified`, so any HTTP-level error here means the message was never accepted/stored. →
 *     `'failed'` (retire rather than risk the rare case where an underlying payment nonetheless landed
 *     on-chain but the relay's own bookkeeping failed after verifying it — a real possibility for a
 *     `500` from a storage-layer error in `process_monad_message`'s final `put_monad_message` call —
 *     but this module has no way to distinguish that case from "never touched the network" without
 *     parsing the relay's `ProcessMonadMessageError` variant out of its JSON error body, which is
 *     needlessly fragile; retiring is the conservative, "never silently reuse" choice this
 *     codebase's lease module already documents as its default).
 *   - **No HTTP response at all** (network/timeout failure — genuinely unknown whether the relay
 *     ever received/broadcast/stored the message before the connection dropped): falls back to
 *     polling `GET /message/monad/:payload_hash` (`pollForStoredMessage`) a bounded number of times.
 *     Found → `'confirmed'`. Still not found after the poll budget is exhausted → `'stuck'` (the
 *     documented abandonment path this ticket calls for), and `MonadStampAbandonedError` is thrown
 *     so the caller knows the outcome is unresolved (not confirmed-failed, just abandoned).
 *   - **Building/signing a payment itself throws** (before any network call to the relay at all —
 *     e.g. a bad address, or a transient RPC failure while `MonadAccountTxSigner` reads
 *     gas/fee/nonce from the chain): also released as `'failed'`. No transaction was ever broadcast
 *     in this case, so the sub-account's nonce is not actually at risk — but `releaseLease` has no
 *     "never attempted, fully safe to reuse immediately" outcome to distinguish this from a genuine
 *     failure, and this module's ownership rules forbid adding one to `monad-account-lease.ts`. This
 *     trades a small amount of pool capacity (a healthy sub-account gets retired on what might be a
 *     one-off transient error) for staying strictly within the existing three-outcome contract
 *     rather than guessing; documented here as a known, deliberate trade-off.
 */
import {
  Provider,
  SigningKey,
  Transaction,
  computeAddress,
  concat,
  getAddress,
  getBytes,
  hexlify,
  sha256,
  toUtf8Bytes,
} from 'ethers'
import axios from 'axios'

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
import {
  type MonadStampWalletHandle,
  type MonadWalletHandle,
  isMonadStampWalletHandle,
  unsafeCreateMonadStampWalletHandleForTests,
} from './monad-wallet-handle'
import type { StampAttemptJournal } from './storage/stamp-attempt-journal'
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
  /** Exact nested wire bytes as retained by the relay. Unknown protobuf fields are authoritative
   * for retry identity and must not be erased by decode/re-encode comparison. */
  messageBytes?: Uint8Array
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
  msg: MonadStampedMessageProto
): Uint8Array {
  const pb = new MonadStampedMessage()
  pb.setEncryptedPayload(msg.encryptedPayload)
  pb.setPayloadHash(msg.payloadHash)
  pb.setStampPaymentsList(
    msg.stampPayments.map((payment) => {
      const paymentPb = new MonadStampPayment()
      paymentPb.setChildIndex(payment.childIndex)
      paymentPb.setRawTx(payment.rawTx)
      return paymentPb
    })
  )
  return pb.serializeBinary()
}

/** Decode protobuf wire-format bytes into a {@link MonadStampedMessageProto}. Round-trips with
 * {@link encodeMonadStampedMessage}. */
export function decodeMonadStampedMessage(
  bytes: Uint8Array
): MonadStampedMessageProto {
  const pb = MonadStampedMessage.deserializeBinary(bytes)
  return {
    stampPayments: pb.getStampPaymentsList().map((payment) => ({
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
  bytes: Uint8Array
): StoredMonadMessageProto {
  const pb = StoredMonadMessage.deserializeBinary(bytes)
  const nested = pb.getMessage()
  return {
    message: nested
      ? {
          stampPayments: nested.getStampPaymentsList().map((payment) => ({
            childIndex: payment.getChildIndex(),
            rawTx: payment.getRawTx_asU8(),
          })),
          encryptedPayload: nested.getEncryptedPayload_asU8(),
          payloadHash: nested.getPayloadHash_asU8(),
        }
      : undefined,
    messageBytes: extractLengthDelimitedField(bytes, 1),
    timestamp: pb.getTimestamp(),
    networkTag: pb.getNetworkTag_asU8(),
  }
}

function extractLengthDelimitedField(
  bytes: Uint8Array,
  wantedField: number
): Uint8Array | undefined {
  let offset = 0
  let found: Uint8Array | undefined
  const readVarint = (): bigint => {
    let value = BigInt(0)
    let shift = BigInt(0)
    for (let count = 0; count < 10 && offset < bytes.length; count++) {
      const byte = bytes[offset++]
      // A protobuf uint64 may use all ten bytes, but its tenth byte can carry only bit zero.
      if (count === 9 && (byte & 0xfe) !== 0) {
        throw new Error('Invalid protobuf varint in stored Monad message')
      }
      value |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return value
      shift += BigInt(7)
    }
    throw new Error('Invalid protobuf varint in stored Monad message')
  }
  const scanFields = (endGroupField?: bigint): void => {
    while (offset < bytes.length) {
      const tag = readVarint()
      const field = tag >> BigInt(3)
      const wireType = Number(tag & BigInt(7))
      if (field < BigInt(1) || field > BigInt(0x1fffffff)) {
        throw new Error('Invalid protobuf field tag')
      }
      if (wireType === 4) {
        if (endGroupField === undefined || field !== endGroupField) {
          throw new Error(
            'Mismatched protobuf end group in stored Monad message'
          )
        }
        return
      }
      if (wireType === 0) {
        readVarint()
      } else if (wireType === 1) {
        offset += 8
      } else if (wireType === 2) {
        const encodedLength = readVarint()
        if (encodedLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error('Invalid protobuf length in stored Monad message')
        }
        const length = Number(encodedLength)
        const end = offset + length
        if (!Number.isSafeInteger(length) || end > bytes.length) {
          throw new Error('Invalid protobuf length in stored Monad message')
        }
        // A same-numbered field nested in an unknown group is not the top-level stored message.
        if (endGroupField === undefined && field === BigInt(wantedField)) {
          found = bytes.slice(offset, end)
        }
        offset = end
      } else if (wireType === 3) {
        scanFields(field)
      } else if (wireType === 5) {
        offset += 4
      } else {
        throw new Error(
          'Unsupported protobuf wire type in stored Monad message'
        )
      }
      if (offset > bytes.length) {
        throw new Error('Truncated protobuf stored Monad message')
      }
    }
    if (endGroupField !== undefined) {
      throw new Error('Truncated protobuf group in stored Monad message')
    }
  }
  scanFields()
  return found
}

/** Spendable recipient-side view of one verified stamp-payment child. This is intentionally
 * produced only by an explicit recovery call; private keys are never added to ordinary stored
 * message/feed objects. */
export interface RecoveredMonadStampPayment {
  childIndex: number
  address: string
  privateKey: Uint8Array
  txHash: string
  rawTx: string
  recipientPublicKeyHex: string
  envelopeRecipientAddress: string
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
  envelopeRecipientAddress?: string
}): RecoveredMonadStampPayment[] {
  assertMonadStampPaymentCount(params.message.stampPayments.length)
  if (
    hexlify(computeMonadStampCommitment(params.message.encryptedPayload)) !==
    hexlify(params.message.payloadHash)
  ) {
    throw new Error(
      'Stamp-payment payload hash does not match encrypted payload'
    )
  }
  const recipientPublicKeyHex = SigningKey.computePublicKey(
    hexlify(params.recipientPrivateKey),
    true
  )
  const derivedRecipientAddress = computeAddress(recipientPublicKeyHex)
  if (
    params.envelopeRecipientAddress !== undefined &&
    getAddress(params.envelopeRecipientAddress) !==
      getAddress(derivedRecipientAddress)
  ) {
    throw new Error('Retained envelope recipient does not match its key')
  }
  const seenChildren = new Set<number>()
  return params.message.stampPayments.map((payment, paymentIndex) => {
    if (payment.childIndex !== paymentIndex) {
      throw new Error('Stamp-payment children are not in canonical order')
    }
    if (seenChildren.has(payment.childIndex)) {
      throw new Error(
        `Duplicate stamp-payment child index ${payment.childIndex}`
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
        }, expected ${child.address}`
      )
    }
    if (tx.hash === null) {
      throw new Error(
        `Stamp payment child ${payment.childIndex} is not a signed transaction`
      )
    }
    if (tx.value <= BigInt(0)) {
      throw new Error(`Stamp payment child ${payment.childIndex} has no value`)
    }
    const expectedCalldata = buildMonadStampCalldata(
      computeMonadStampPaymentCommitment(
        params.message.payloadHash,
        payment.childIndex
      )
    )
    if (tx.data.toLowerCase() !== expectedCalldata.toLowerCase()) {
      throw new Error(
        `Stamp payment child ${payment.childIndex} has invalid commitment calldata`
      )
    }
    return {
      childIndex: payment.childIndex,
      address: child.address,
      privateKey: child.privateKey,
      txHash: tx.hash,
      rawTx: hexlify(payment.rawTx),
      recipientPublicKeyHex,
      envelopeRecipientAddress:
        params.envelopeRecipientAddress ?? derivedRecipientAddress,
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
      `Recovered stamp-payment key resolves to ${signer.address}, expected ${params.payment.address}`
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
    params.overrides
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
  encryptedPayload: Uint8Array
): Uint8Array {
  return getBytes(sha256(encryptedPayload))
}

/** Build the exact `<lokad_id: 4><version: 1><commitment: 32>` calldata layout
 * `monad_stamp_verify::parse_commitment_calldata` decodes (see this file's header), as a `0x`-
 * prefixed hex string ready to pass straight into `MonadAccountTxSigner.buildAndSignCall`. */
export function buildMonadStampCalldata(commitment: Uint8Array): string {
  if (commitment.length !== 32) {
    throw new Error(
      `Monad stamp commitment must be exactly 32 bytes, got ${commitment.length}`
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
    params.overrides
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
  childIndex: number
): Uint8Array {
  if (payloadHash.length !== 32) {
    throw new Error(
      `Monad stamp payload hash must be exactly 32 bytes, got ${payloadHash.length}`
    )
  }
  if (
    !Number.isInteger(childIndex) ||
    childIndex < 0 ||
    childIndex > 0xffffffff
  ) {
    throw new Error(
      `Stamp payment child index must be a uint32, got ${childIndex}`
    )
  }
  const indexBytes = Uint8Array.from([
    (childIndex >>> 24) & 0xff,
    (childIndex >>> 16) & 0xff,
    (childIndex >>> 8) & 0xff,
    childIndex & 0xff,
  ])
  return getBytes(
    sha256(concat([PAYMENT_COMMITMENT_DOMAIN, payloadHash, indexBytes]))
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
  if (detail && typeof detail === 'object' && 'error' in detail) {
    const error = (detail as { error?: unknown }).error
    if (typeof error === 'string') return error
  }
  return undefined
}

/** Thrown when a network-level failure left the outcome genuinely unknown, and polling
 * `GET /message/monad/:payload_hash` never turned up a stored message within the configured
 * budget (see this file's header, "Lease release policy"). The lease has already been released as
 * `'stuck'` (retired) by the time this is thrown. */
export class MonadStampAbandonedError extends MonadStampError {
  readonly payloadHashHex: string

  constructor(message: string, payloadHashHex: string) {
    super(message)
    this.payloadHashHex = payloadHashHex
  }
}

/** A previous exact payment set still needs reconciliation. Building a fresh salted envelope
 * while it is pending could pay twice under a different payload hash. */
export class MonadStampPendingAttemptError extends MonadStampError {
  readonly payloadHashes: string[]

  constructor(payloadHashes: string[]) {
    super(
      `Cannot create another stamp payment while ${payloadHashes.length} prior attempt(s) remain pending`
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

export const MAX_STAMP_PAYMENTS = 64
export const MAX_MONAD_STAMPED_MESSAGE_BYTES = 2 * 1024 * 1024

export function assertMonadStampPaymentCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_STAMP_PAYMENTS) {
    throw new Error(
      `Monad stamped messages require 1..${MAX_STAMP_PAYMENTS} payments`
    )
  }
}

function exactSetRetained(responseData: unknown): boolean | undefined {
  let parsed = responseData
  if (responseData instanceof ArrayBuffer || ArrayBuffer.isView(responseData)) {
    try {
      const bytes =
        responseData instanceof ArrayBuffer
          ? new Uint8Array(responseData)
          : new Uint8Array(
              responseData.buffer,
              responseData.byteOffset,
              responseData.byteLength
            )
      parsed = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      return undefined
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const value = (parsed as Record<string, unknown>).exact_set_retained
  return typeof value === 'boolean' ? value : undefined
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Options for the `GET /message/monad/:payload_hash` fallback poll used when a `PUT` attempt fails
 * with no HTTP response at all (see this file's header, "Lease release policy"). */
export interface AbandonPollOptions {
  /** Delay between poll attempts, in ms. Default 2000. */
  intervalMs?: number
  /** Number of `GET` attempts before giving up. Default 5. */
  maxAttempts?: number
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
  /** Overrides the default fallback poll used only when a `PUT` attempt fails with no HTTP response
   * at all (see this file's header, "Lease release policy"). */
  abandonPoll?: AbandonPollOptions
}

/** Outcome of a successful `submitStampedMessage` call — all payment transactions confirmed and the
 * relay stored the message (see this file's header: a 2xx `PUT /message/monad` response, or a
 * found `GET` after the network-failure fallback poll, are the only two ways to reach this). */
export interface StampMonadMessageResult {
  stored: StoredMonadMessageProto
  /** Bare (no `0x`) hex of `h_m` — also `GET /message/monad/:payload_hash`'s path segment. */
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
 * `PUT /message/monad` / `GET /message/monad/:payload_hash` HTTP surface (#27) into one call:
 * "stamp this encrypted payload onto Monad and hand it to the relay." See this file's header for
 * the full commitment/calldata/protobuf/lease-release design.
 */
export class MonadStampClient {
  private readonly pool: MonadSubAccountPool
  private readonly leaseManager: SubAccountLeaseManager
  private readonly provider: Provider
  private readonly httpClient: MonadTxSubmitter
  private readonly changePool: MonadChangePool | undefined
  private readonly attemptJournal: StampAttemptJournal
  private readonly walletState: MonadStampWalletHandle['walletState']
  private activeSubmissions = 0
  /** Base URL of the `cashweb-registry` relay, e.g. `https://relay.example.com` — no trailing
   * slash. `/message/monad` (`PUT`) and `/message/monad/:payload_hash` (`GET`) are appended to it. */
  private readonly relayBaseUrl: string

  constructor(params: MonadStampWalletHandle) {
    if (!isMonadStampWalletHandle(params)) {
      throw new Error(
        'MonadStampClient requires a factory-produced complete wallet handle'
      )
    }
    const walletState = params.walletState
    walletState.assertOpen()
    this.pool = walletState.pool
    this.leaseManager = walletState.leaseManager
    this.provider = params.provider
    this.httpClient = params.httpClient
    this.changePool = walletState.changePool
    this.walletState = walletState
    this.attemptJournal = walletState.stampAttemptJournal
    this.relayBaseUrl = params.relayBaseUrl.replace(/\/+$/, '')
  }

  static unsafeCreateForTests(params: MonadWalletHandle): MonadStampClient {
    return new MonadStampClient(
      unsafeCreateMonadStampWalletHandleForTests(params)
    )
  }

  /** Fetch a previously-stored message by its bare-hex `payload_hash` via
   * `GET /message/monad/:payload_hash`. Returns `undefined` on a `404` (not yet stored/found) — any
   * other non-2xx response, or a network-level failure, propagates as a thrown error. */
  async fetchStoredMessage(
    payloadHashHex: string
  ): Promise<StoredMonadMessageProto | undefined> {
    this.walletState.assertOpen()
    try {
      const response = await axios({
        method: 'get',
        url: `${this.relayBaseUrl}/message/monad/${payloadHashHex}`,
        responseType: 'arraybuffer',
      })
      return decodeStoredMonadMessage(new Uint8Array(response.data))
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        return undefined
      }
      throw err
    }
  }

  private async pollForStoredMessage(
    payloadHashHex: string,
    expectedMessageBytes: Uint8Array,
    options?: AbandonPollOptions
  ): Promise<StoredMonadMessageProto | undefined> {
    const intervalMs = options?.intervalMs ?? 2000
    const maxAttempts = options?.maxAttempts ?? 5
    const sleep = options?.sleep ?? defaultSleep
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) await sleep(intervalMs)
      // A single poll attempt failing (another network hiccup, a transient 5xx, ...) is not itself
      // proof of abandonment -- only exhausting the whole poll budget without ever finding the
      // message is. Swallow per-attempt errors here and let the loop keep trying; the overall
      // "genuinely unknown" -> `'stuck'` outcome is decided by the caller once every attempt in the
      // budget has been spent.
      const stored = await this.fetchStoredMessage(payloadHashHex).catch(
        () => undefined
      )
      if (
        stored?.messageBytes !== undefined &&
        bytesEqual(stored.messageBytes, expectedMessageBytes)
      ) {
        return stored
      }
    }
    return undefined
  }

  private async putStampedMessage(
    message: MonadStampedMessageProto,
    encoded = encodeMonadStampedMessage(message)
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
      stored.messageBytes === undefined ||
      !bytesEqual(stored.messageBytes, encoded)
    ) {
      // A 2xx only proves that an HTTP peer answered. It does not prove that the relay retained
      // this exact payment set. Treat a missing/different nested message like a lost response so
      // the caller keeps its journal and reservations until the exact read side confirms it.
      throw new Error(
        'Relay returned success without the exact submitted Monad-stamped message'
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
    params: StampMonadMessageParams
  ): Promise<StampMonadMessageResult> {
    this.walletState.assertOpen()
    if (params.encryptedPayload.length === 0) {
      throw new Error('encryptedPayload must not be empty')
    }
    if (params.encryptedPayload.length > MAX_MONAD_STAMPED_MESSAGE_BYTES) {
      throw new Error(
        `encryptedPayload exceeds the ${MAX_MONAD_STAMPED_MESSAGE_BYTES}-byte message limit`
      )
    }
    if (params.recipientPublicKey.length !== 33) {
      throw new Error('recipientPublicKey must be a compressed 33-byte key')
    }
    if (params.stampValueWei <= BigInt(0)) {
      throw new Error('stampValueWei must be positive')
    }
    await this.reconcilePendingOrThrow()
    this.activeSubmissions++
    try {
      return await this.submitStampedMessageAfterPreflight(params)
    } finally {
      this.activeSubmissions--
    }
  }

  private async submitStampedMessageAfterPreflight(
    params: StampMonadMessageParams
  ): Promise<StampMonadMessageResult> {
    const payloadHash = computeMonadStampCommitment(params.encryptedPayload)
    // Quote with an all-nonzero commitment. The RPC therefore applies the active network's
    // worst-case calldata schedule (including EIP-7623) without this client hardcoding gas-table
    // arithmetic that could become stale after another repricing.
    const quoteCalldata = buildMonadStampCalldata(
      new Uint8Array(STAMP_COMMITMENT_LENGTH).fill(0xff)
    )
    const payloadHashHex = toBareHex(payloadHash)
    const quoteDestination = deriveMonadStampChildPublic({
      payloadHash,
      recipientPublicKey: params.recipientPublicKey,
      paymentIndex: 0,
    }).address

    let availableRecords = this.pool
      .records()
      .filter((candidate) => candidate.status === 'available')
    if (availableRecords.length === 0 && params.waitForLease !== undefined) {
      const sleep = params.waitForLease.sleep ?? defaultSleep
      const now = params.waitForLease.now ?? Date.now
      const pollIntervalMs = params.waitForLease.pollIntervalMs ?? 250
      const deadline = now() + (params.waitForLease.timeoutMs ?? 30_000)
      while (availableRecords.length === 0 && now() < deadline) {
        await sleep(pollIntervalMs)
        availableRecords = this.pool
          .records()
          .filter((candidate) => candidate.status === 'available')
      }
    }
    if (availableRecords.length === 0) {
      throw new NoAvailableSubAccountError(
        'No available sub-account to quote for a stamp payment'
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
        params.overrides
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
    assertMonadStampPaymentCount(selected.length)
    const quoteByIndex = new Map(quotes.map((quote) => [quote.index, quote]))
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
            computeMonadStampPaymentCommitment(payloadHash, paymentIndex)
          ),
          quote.resolvedOverrides
        )
        const feePerGas = signedTx.maxFeePerGas ?? signedTx.gasPrice
        if (
          feePerGas === undefined ||
          signedTx.value + signedTx.gasLimit * feePerGas > quote.balanceWei
        ) {
          throw new Error(
            `Final stamp payment at funding index ${selection.index} exceeds its quoted account capacity`
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
        `Encoded Monad stamped message is ${encodedMessage.byteLength} bytes; maximum is ${MAX_MONAD_STAMPED_MESSAGE_BYTES}`
      )
    }
    try {
      await this.attemptJournal.put({
        payloadHashHex,
        messageBytes: Array.from(encodedMessage),
        leaseIndices: handles.map((handle) => handle.index),
        recipientPublicKeyHex: hexlify(params.recipientPublicKey),
      })
    } catch (err) {
      for (const handle of handles) {
        this.leaseManager.releaseLease(handle, 'failed')
      }
      await this.pool.flush()
      throw err
    }
    for (const [offset, handle] of handles.entries()) {
      const signedTx = signedTxs[offset]
      this.pool.recordSpendTransaction(handle.index, {
        rawTx: signedTx.rawTx,
        txHash: signedTx.txHash,
        valueWei: signedTx.value.toString(),
      })
    }
    await this.pool.flush()
    const releaseAll = async (
      outcome: 'confirmed' | 'failed' | 'stuck'
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
        if (released.sweep?.swept === true) {
          this.pool.recordRecoveryDisposition(handle.index, {
            kind: 'change',
            changeIndex: released.sweep.record.index,
            address: released.sweep.record.address,
            txHash: released.sweep.record.txHash,
            valueWei: released.sweep.record.sweptValueWei,
          })
          await this.pool.flush()
        } else if (released.sweep?.reason === 'below-dust-threshold') {
          this.pool.recordRecoveryDisposition(handle.index, {
            kind: 'dust',
            valueWei: (released.sweep.balanceWei ?? BigInt(0)).toString(),
            thresholdWei: (
              released.sweep.dustThresholdWei ?? BigInt(0)
            ).toString(),
          })
          await this.pool.flush()
        }
        if (
          released.sweep?.swept === false &&
          released.sweep.reason !== 'below-dust-threshold'
        ) {
          break
        }
      }
      return sweeps
    }

    try {
      const stored = await this.putStampedMessage(message, encodedMessage)
      const changeSweeps = await releaseAll('confirmed')
      if (
        changeSweeps.some(
          (sweep) =>
            sweep?.swept === false && sweep.reason !== 'below-dust-threshold'
        )
      ) {
        throw new MonadStampPendingAttemptError([payloadHashHex])
      }
      await this.attemptJournal.delete(payloadHashHex)
      return {
        stored,
        payloadHashHex,
        txHashes: signedTxs.map((signedTx) => signedTx.txHash),
        leaseIndices: handles.map((handle) => handle.index),
        changeSweeps,
      }
    } catch (err) {
      if (err instanceof MonadStampPendingAttemptError) throw err
      if (axios.isAxiosError(err) && err.response) {
        if (exactSetRetained(err.response.data) === false) {
          await releaseAll('failed')
          await this.attemptJournal.delete(payloadHashHex)
          const detail = relayRejectionDetail(err.response.data)
          throw new MonadStampRejectedError(
            `Relay rejected the Monad-stamped message before retaining its payment set (HTTP ${
              err.response.status
            })${detail ? `: ${detail}` : ''}`,
            err.response.status,
            err.response.data
          )
        }
        // The relay may have accepted a prefix of this exact payment set before returning an
        // error. Keep the journal and reservations intact so reconciliation can replay only the
        // already-authorized bytes; presenting this as a terminal rejection could prompt a
        // caller to create a second salted payment and pay twice.
        throw new MonadStampPendingAttemptError([payloadHashHex])
      }

      // A missing HTTP response or a semantically invalid 2xx is genuinely ambiguous: the relay
      // may still have received/broadcast/stored the exact message. Poll the read side before
      // giving up, and require byte-for-byte equality there too.
      const stored = await this.pollForStoredMessage(
        payloadHashHex,
        encodedMessage,
        params.abandonPoll
      )
      if (stored !== undefined) {
        const changeSweeps = await releaseAll('confirmed')
        if (
          changeSweeps.some(
            (sweep) =>
              sweep?.swept === false && sweep.reason !== 'below-dust-threshold'
          )
        ) {
          throw new MonadStampPendingAttemptError([payloadHashHex])
        }
        await this.attemptJournal.delete(payloadHashHex)
        return {
          stored,
          payloadHashHex,
          txHashes: signedTxs.map((signedTx) => signedTx.txHash),
          leaseIndices: handles.map((handle) => handle.index),
          changeSweeps,
        }
      }

      throw new MonadStampAbandonedError(
        'Monad stamp submission abandoned: no response from the relay, and ' +
          `GET /message/monad/${payloadHashHex} never found a stored message`,
        payloadHashHex
      )
    }
  }

  /** Single wallet-owned preflight for every operation that may fund or sign a new stamp. */
  async reconcileOrThrow(): Promise<void> {
    this.walletState.assertOpen()
    if (this.activeSubmissions > 0) {
      throw new MonadStampPendingAttemptError(
        this.attemptJournal.getAll().map((attempt) => attempt.payloadHashHex)
      )
    }
    await this.reconcilePendingOrThrow()
    this.pool.authorizeStampInventoryPreparation()
  }

  private async reconcilePendingOrThrow(): Promise<void> {
    await this.walletState.reconcileRestoreState()
    this.walletState?.assertNoOrphanedLeases()
    if (this.activeSubmissions > 0) return
    if (this.attemptJournal.getAll().length === 0) return
    const recovered = await this.resumePendingAttempts()
    if (recovered.length > 0) {
      throw new MonadStampRecoveredAttemptError(recovered)
    }
    const stillPending = this.attemptJournal
      .getAll()
      .map((attempt) => attempt.payloadHashHex)
    if (stillPending.length > 0) {
      throw new MonadStampPendingAttemptError(stillPending)
    }
  }

  /** Replay crash-surviving attempts byte-for-byte. Exact-set relay binding makes this safe when
   * only a prefix of the transactions landed before the previous process stopped. */
  async resumePendingAttempts(): Promise<string[]> {
    this.walletState.assertOpen()
    await this.walletState?.repairAttemptSpendLifecycles()
    this.walletState?.assertSemanticallyValid()
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
          Uint8Array.from(attempt.messageBytes)
        )
        for (const [offset, index] of attempt.leaseIndices.entries()) {
          const record = this.pool.getRecord(index)
          const payment = message.stampPayments[offset]
          if (record === undefined || payment === undefined) continue
          if (record.lifecycle?.spend === undefined) {
            const transaction = Transaction.from(hexlify(payment.rawTx))
            if (transaction.hash === null) {
              throw new Error(
                `Journaled stamp payment for sub-account ${index} is unsigned`
              )
            }
            this.pool.recordSpendTransaction(index, {
              rawTx: hexlify(payment.rawTx),
              txHash: transaction.hash,
              valueWei: transaction.value.toString(),
            })
          }
        }
        await this.pool.flush()
        await this.putStampedMessage(
          message,
          Uint8Array.from(attempt.messageBytes)
        )
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
            if (sweep.swept) {
              this.pool.recordRecoveryDisposition(index, {
                kind: 'change',
                changeIndex: sweep.record.index,
                address: sweep.record.address,
                txHash: sweep.record.txHash,
                valueWei: sweep.record.sweptValueWei,
              })
              await this.pool.flush()
            } else if (sweep.reason === 'below-dust-threshold') {
              this.pool.recordRecoveryDisposition(index, {
                kind: 'dust',
                valueWei: (sweep.balanceWei ?? BigInt(0)).toString(),
                thresholdWei: (sweep.dustThresholdWei ?? BigInt(0)).toString(),
              })
              await this.pool.flush()
            }
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
          exactSetRetained(err.response.data) === false
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
