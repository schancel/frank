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
 * 1. Computes `h_m = SHA256(encrypted_payload)` — this is both `MonadStampedMessage.payload_hash`
 *    *and* the on-chain commitment the burn tx's calldata must carry. Unlike Lotus's
 *    `SHA256(SHA256(pubkey) || payload_hash)` preimage, there is deliberately no pubkey folded in
 *    here — see `monad_message.proto`'s module doc and `monad_stamp_verify.rs`'s
 *    `calc_expected_commitment` doc comment (that function documents the *Lotus-mirroring* preimage
 *    math used for the Lotus-style `ADDRESS_METADATA_LOKAD_ID` path elsewhere in that module; the
 *    live `PUT /message/monad` handler, `process_monad_message` in `http/monad_message.rs`, never
 *    calls it — it builds `ExpectedBurn { commitment: declared_hash, .. }` directly from
 *    `SHA256(encrypted_payload)`, confirmed by reading that function's body).
 * 2. Builds the burn tx's calldata as `<BROADCAST_MESSAGE_LOKAD_ID: 4 bytes><version: 1
 *    byte><h_m: 32 bytes>` (37 bytes total) — the exact layout
 *    `cashweb_registry::monad_stamp_verify::parse_commitment_calldata` decodes (see
 *    `backend/cashweb/cashweb-registry/src/monad_stamp_verify.rs` lines 139-172:
 *    `CALLDATA_PREFIX_LEN = 5` for `<lokad_id><version>`, then `CALLDATA_COMMITMENT_LEN = 32` for
 *    the commitment, checked byte-range-exact, no padding/trailing bytes tolerated). The LOKAD ID
 *    used is `BROADCAST_MESSAGE_LOKAD_ID = *b"POND"`, defined in
 *    `backend/cashweb/cashweb-payload/src/verify.rs:15` and threaded into the live handler via
 *    `http/monad_message.rs`'s `use cashweb_payload::verify::BROADCAST_MESSAGE_LOKAD_ID;` /
 *    `ExpectedBurn { commitment_id: BROADCAST_MESSAGE_LOKAD_ID, .. }` (not the Lotus private-message
 *    LOKAD ID, and not `ADDRESS_METADATA_LOKAD_ID` — reused for symmetry with the broadcast path per
 *    #27's own reasoning, not because this is conceptually a broadcast message). The version byte is
 *    `monad_stamp_verify::COMMITMENT_VERSION_TAG = 0x01`.
 * 3. Leases a sub-account (`SubAccountLeaseManager`, #18) and builds+signs the raw burn tx via
 *    `MonadAccountTxSigner.buildAndSignCall` (#11): value → the configured burn address (see
 *    `frank/.env.example`'s `MONAD_STAMP_BURN_ADDRESS`, decided in #7), the calldata from step 2.
 * 4. Assembles a `MonadStampedMessage { raw_burn_tx, encrypted_payload, payload_hash }` and encodes
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
 * This app already has an established pattern for wire-format protobuf: a `.proto` file compiled
 * via `protoc --js_out=...,binary:. --ts_out=.` into a generated `*_pb.js`/`*_pb.d.ts` pair built on
 * `google-protobuf`'s `jspb.Message`/`BinaryWriter`/`BinaryReader` (see e.g.
 * `../registry/broadcast_pb.js`, `../registry/generate_protobufs.sh`). This module deliberately does
 * NOT add a new `proto/monad_message.proto` + generated pair here, because that toolchain could not
 * actually be exercised in this environment: the `protoc` npm package (`app/node_modules/protoc`,
 * v1.0.4) bundles a 32-bit (`i386`) `protoc` binary that cannot execute at all on a modern macOS
 * host (arm64 or x86_64 — 32-bit binaries have been unsupported since Catalina), and the system
 * `protoc` available via Homebrew (v33.4) no longer bundles the `--js_out` codegen at all (the
 * `protoc-gen-js` plugin was split out of upstream `protobuf` years ago and isn't installed here
 * either). Rather than commit an unverified, never-actually-run "generated" file, this module hand-
 * encodes the two messages it needs directly against `google-protobuf`'s `jspb.BinaryWriter`/
 * `BinaryReader` primitives — the same runtime the generated files themselves are built on, and
 * already a project dependency (`google-protobuf` in `app/package.json`). Wire-format correctness
 * only depends on using the right field numbers/wire types (both `bytes` and embedded-message
 * fields use protobuf wire type 2 — length-delimited — so a nested message can be read generically
 * via `readBytes()` and decoded recursively), which are transcribed 1:1 from
 * `backend/cashweb/cashweb-registry/proto/monad_message.proto` below. If/when this environment's
 * protoc toolchain is fixed, these functions can be swapped for a real generated
 * `wallet/proto/monad_message.proto` + `monad_message_pb.js` without changing this file's public
 * API (`encodeMonadStampedMessage`/`decodeStoredMonadMessage` intentionally mirror the
 * `serializeBinary`/`deserializeBinary` shape generated code would expose).
 *
 * ## Lease release policy
 *
 * `SubAccountLeaseManager.releaseLease` (#18) only accepts three outcomes: `'confirmed'`
 * (`'in-use' -> 'available'`), or `'failed'`/`'stuck'` (`'in-use' -> 'retired'`, never reused with a
 * guessed nonce). This module maps the three ways a `submitStampedMessage` call can end onto those:
 *
 *   - **`PUT /message/monad` returns 2xx**: the relay only reaches its success response after
 *     `StampRelayOutcome::Verified` (see `process_monad_message` in `http/monad_message.rs` — every
 *     other outcome is a rejection *before* any store happens), i.e. the burn tx is already
 *     confirmed on-chain by the time this resolves. → `'confirmed'`.
 *   - **`PUT /message/monad` returns an HTTP error response** (4xx/5xx — the relay was reached and
 *     definitively responded): per the same handler, a stored message only ever exists after
 *     `Verified`, so any HTTP-level error here means the message was never accepted/stored. →
 *     `'failed'` (retire rather than risk the rare case where the underlying burn nonetheless landed
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
 *   - **Building/signing the burn tx itself throws** (before any network call to the relay at all —
 *     e.g. a bad address, or a transient RPC failure while `MonadAccountTxSigner` reads
 *     gas/fee/nonce from the chain): also released as `'failed'`. No transaction was ever broadcast
 *     in this case, so the sub-account's nonce is not actually at risk — but `releaseLease` has no
 *     "never attempted, fully safe to reuse immediately" outcome to distinguish this from a genuine
 *     failure, and this module's ownership rules forbid adding one to `monad-account-lease.ts`. This
 *     trades a small amount of pool capacity (a healthy sub-account gets retired on what might be a
 *     one-off transient error) for staying strictly within the existing three-outcome contract
 *     rather than guessing; documented here as a known, deliberate trade-off.
 */
import { Provider, concat, getBytes, hexlify, sha256 } from 'ethers'
import axios from 'axios'
import * as jspb from 'google-protobuf'

import { MonadSubAccountPool } from './monad-account-pool'
import {
  AccountLeaseHandle,
  AcquireLeaseWhenAvailableOptions,
  SubAccountLeaseManager,
  acquireLeaseWhenAvailable,
} from './monad-account-lease'
import {
  MonadTxOverrides,
  MonadTxSubmitter,
  SignedMonadTx,
} from './monad-account-tx'

/** `cashweb_payload::verify::BROADCAST_MESSAGE_LOKAD_ID` (`backend/cashweb/cashweb-payload/src/
 * verify.rs:15`, `*b"POND"`) — the LOKAD ID the live `PUT /message/monad` handler requires
 * (`http/monad_message.rs`'s `ExpectedBurn { commitment_id: BROADCAST_MESSAGE_LOKAD_ID, .. }`). */
const BROADCAST_MESSAGE_LOKAD_ID = new Uint8Array([0x50, 0x4f, 0x4e, 0x44]) // "POND"

/** `cashweb_registry::monad_stamp_verify::COMMITMENT_VERSION_TAG` (that file, line 66: `0x01`). */
const COMMITMENT_VERSION_TAG = new Uint8Array([0x01])

/** `cashweb_registry::monad_stamp_verify::{CALLDATA_PREFIX_LEN, CALLDATA_COMMITMENT_LEN}` (5 + 32 =
 * 37 total): `<lokad_id: 4><version: 1><commitment: 32>`. Exported for tests that want to assert on
 * the exact calldata length independent of this module's other constants. */
export const MONAD_STAMP_CALLDATA_LENGTH =
  BROADCAST_MESSAGE_LOKAD_ID.length + COMMITMENT_VERSION_TAG.length + 32

/**
 * `MonadStampedMessage` from `monad_message.proto`, decoded/encoded here in plain-object form
 * (rather than a `jspb.Message` subclass — see this file's header on why there's no generated
 * class). Field numbers match the `.proto` exactly: `raw_burn_tx = 1`, `encrypted_payload = 2`,
 * `payload_hash = 3`.
 */
export interface MonadStampedMessageProto {
  rawBurnTx: Uint8Array
  encryptedPayload: Uint8Array
  payloadHash: Uint8Array
}

/**
 * `StoredMonadMessage` from `monad_message.proto` — what both `PUT /message/monad`'s success
 * response and `GET /message/monad/:payload_hash` return. Field numbers: `message = 1`,
 * `sender_address = 2`, `tx_hash = 3`, `timestamp = 4`.
 */
export interface StoredMonadMessageProto {
  message: MonadStampedMessageProto | undefined
  senderAddress: Uint8Array
  txHash: Uint8Array
  /** Milliseconds since the Unix epoch. Decoded via `jspb.BinaryReader.readInt64`, which returns a
   * plain JS `number` (not `bigint`) — safe here since a millisecond timestamp is far below
   * `Number.MAX_SAFE_INTEGER` for a very long time yet. */
  timestamp: number
}

/** Encode a {@link MonadStampedMessageProto} to protobuf wire-format bytes, matching
 * `monad_message.proto`'s `MonadStampedMessage` field-for-field. */
export function encodeMonadStampedMessage(
  msg: MonadStampedMessageProto,
): Uint8Array {
  const writer = new jspb.BinaryWriter()
  if (msg.rawBurnTx.length > 0) writer.writeBytes(1, msg.rawBurnTx)
  if (msg.encryptedPayload.length > 0)
    writer.writeBytes(2, msg.encryptedPayload)
  if (msg.payloadHash.length > 0) writer.writeBytes(3, msg.payloadHash)
  return writer.getResultBuffer()
}

/** Decode protobuf wire-format bytes into a {@link MonadStampedMessageProto}. Round-trips with
 * {@link encodeMonadStampedMessage}. */
export function decodeMonadStampedMessage(
  bytes: Uint8Array,
): MonadStampedMessageProto {
  const reader = new jspb.BinaryReader(bytes)
  let rawBurnTx = new Uint8Array()
  let encryptedPayload = new Uint8Array()
  let payloadHash = new Uint8Array()
  while (reader.nextField()) {
    if (reader.isEndGroup()) break
    switch (reader.getFieldNumber()) {
      case 1:
        rawBurnTx = reader.readBytes()
        break
      case 2:
        encryptedPayload = reader.readBytes()
        break
      case 3:
        payloadHash = reader.readBytes()
        break
      default:
        reader.skipField()
    }
  }
  return { rawBurnTx, encryptedPayload, payloadHash }
}

/** Decode protobuf wire-format bytes into a {@link StoredMonadMessageProto} — what the relay
 * returns from both `PUT /message/monad` and `GET /message/monad/:payload_hash`. The nested
 * `message` field (field 1) is read generically via `readBytes()` and decoded recursively with
 * {@link decodeMonadStampedMessage}: an embedded-message field and a `bytes` field share the same
 * length-delimited wire type (2), so this is a correct, general way to read a submessage without
 * needing `jspb`'s `readMessage(..)` callback machinery. */
export function decodeStoredMonadMessage(
  bytes: Uint8Array,
): StoredMonadMessageProto {
  const reader = new jspb.BinaryReader(bytes)
  let message: MonadStampedMessageProto | undefined
  let senderAddress = new Uint8Array()
  let txHash = new Uint8Array()
  let timestamp = 0
  while (reader.nextField()) {
    if (reader.isEndGroup()) break
    switch (reader.getFieldNumber()) {
      case 1:
        message = decodeMonadStampedMessage(reader.readBytes())
        break
      case 2:
        senderAddress = reader.readBytes()
        break
      case 3:
        txHash = reader.readBytes()
        break
      case 4:
        timestamp = reader.readInt64()
        break
      default:
        reader.skipField()
    }
  }
  return { message, senderAddress, txHash, timestamp }
}

/** `h_m = SHA256(encrypted_payload)` — both `MonadStampedMessage.payload_hash` and the on-chain
 * commitment the burn tx's calldata must carry (see this file's header). Returns the raw 32-byte
 * hash, not hex. */
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

/** Hex-encode `bytes` with no `0x` prefix — the shape Rust's `hex::decode` (used by
 * `handle_get_monad_message`'s `:payload_hash` path segment) expects. */
function toBareHex(bytes: Uint8Array): string {
  return hexlify(bytes).slice(2)
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

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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
  /** `0x`-prefixed Monad burn address (see `frank/.env.example`'s `MONAD_STAMP_BURN_ADDRESS`,
   * decided in ticket #7). Passed explicitly rather than read from `process.env` here, matching
   * `monad-http.ts`'s established convention of never reading env itself (see that file's header). */
  burnAddress: string
  /** Value, in wei, to burn to `burnAddress`. */
  burnValueWei: bigint
  overrides?: MonadTxOverrides
  /** If provided, waits (`acquireLeaseWhenAvailable`) for a sub-account to free up instead of
   * failing immediately when the pool is fully leased. Omit for the default immediate-reject
   * behavior (`SubAccountLeaseManager.acquireLease`). */
  waitForLease?: AcquireLeaseWhenAvailableOptions
  /** Overrides the default fallback poll used only when a `PUT` attempt fails with no HTTP response
   * at all (see this file's header, "Lease release policy"). */
  abandonPoll?: AbandonPollOptions
}

/** Outcome of a successful `submitStampedMessage` call — the burn tx confirmed on-chain and the
 * relay stored the message (see this file's header: a 2xx `PUT /message/monad` response, or a
 * found `GET` after the network-failure fallback poll, are the only two ways to reach this). */
export interface StampMonadMessageResult {
  stored: StoredMonadMessageProto
  /** Bare (no `0x`) hex of `h_m` — also `GET /message/monad/:payload_hash`'s path segment. */
  payloadHashHex: string
  txHash: string
  leaseIndex: number
}

/**
 * Ties together sub-account leasing (#14/#18), burn-tx construction (#11), and the live
 * `PUT /message/monad` / `GET /message/monad/:payload_hash` HTTP surface (#27) into one call:
 * "stamp this encrypted payload onto Monad and hand it to the relay." See this file's header for
 * the full commitment/calldata/protobuf/lease-release design.
 */
export class MonadStampClient {
  private readonly pool: MonadSubAccountPool
  private readonly leaseManager: SubAccountLeaseManager
  private readonly provider: Provider
  private readonly httpClient: MonadTxSubmitter
  /** Base URL of the `cashweb-registry` relay, e.g. `https://relay.example.com` — no trailing
   * slash. `/message/monad` (`PUT`) and `/message/monad/:payload_hash` (`GET`) are appended to it. */
  private readonly relayBaseUrl: string

  constructor(params: {
    pool: MonadSubAccountPool
    leaseManager: SubAccountLeaseManager
    provider: Provider
    httpClient: MonadTxSubmitter
    relayBaseUrl: string
  }) {
    this.pool = params.pool
    this.leaseManager = params.leaseManager
    this.provider = params.provider
    this.httpClient = params.httpClient
    this.relayBaseUrl = params.relayBaseUrl.replace(/\/+$/, '')
  }

  /** Fetch a previously-stored message by its bare-hex `payload_hash` via
   * `GET /message/monad/:payload_hash`. Returns `undefined` on a `404` (not yet stored/found) — any
   * other non-2xx response, or a network-level failure, propagates as a thrown error. */
  async fetchStoredMessage(
    payloadHashHex: string,
  ): Promise<StoredMonadMessageProto | undefined> {
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
    options?: AbandonPollOptions,
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
        () => undefined,
      )
      if (stored !== undefined) return stored
    }
    return undefined
  }

  private async putStampedMessage(
    message: MonadStampedMessageProto,
  ): Promise<StoredMonadMessageProto> {
    const response = await axios({
      method: 'put',
      url: `${this.relayBaseUrl}/message/monad`,
      data: encodeMonadStampedMessage(message),
      headers: { 'Content-Type': 'application/octet-stream' },
      responseType: 'arraybuffer',
    })
    return decodeStoredMonadMessage(new Uint8Array(response.data))
  }

  /**
   * Stamps `params.encryptedPayload` onto Monad end-to-end: computes `h_m`, builds the calldata,
   * leases a sub-account, builds+signs the burn tx, `PUT`s the assembled `MonadStampedMessage` to
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

    const payloadHash = computeMonadStampCommitment(params.encryptedPayload)
    const calldata = buildMonadStampCalldata(payloadHash)
    const payloadHashHex = toBareHex(payloadHash)

    const handle: AccountLeaseHandle = params.waitForLease
      ? await acquireLeaseWhenAvailable(this.leaseManager, params.waitForLease)
      : this.leaseManager.acquireLease()

    let signedTx: SignedMonadTx
    try {
      const signer = this.pool.getSigner(handle.index, {
        provider: this.provider,
        httpClient: this.httpClient,
      })
      signedTx = await signer.buildAndSignCall(
        params.burnAddress,
        params.burnValueWei,
        calldata,
        params.overrides,
      )
    } catch (err) {
      // No transaction was ever broadcast, so the sub-account's nonce isn't actually at risk — but
      // `releaseLease` has no "never attempted" outcome to say so precisely. See this file's header,
      // "Lease release policy", for why this deliberately still retires rather than guessing.
      this.leaseManager.releaseLease(handle, 'failed')
      throw err
    }

    const message: MonadStampedMessageProto = {
      rawBurnTx: getBytes(signedTx.rawTx),
      encryptedPayload: params.encryptedPayload,
      payloadHash,
    }

    try {
      const stored = await this.putStampedMessage(message)
      this.leaseManager.releaseLease(handle, 'confirmed')
      return {
        stored,
        payloadHashHex,
        txHash: signedTx.txHash,
        leaseIndex: handle.index,
      }
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        this.leaseManager.releaseLease(handle, 'failed')
        throw new MonadStampRejectedError(
          `Relay rejected the Monad-stamped message (HTTP ${err.response.status})`,
          err.response.status,
          err.response.data,
        )
      }

      // No HTTP response at all: genuinely unknown whether the relay received/broadcast/stored the
      // message before the connection dropped. Fall back to polling the read side before giving up.
      const stored = await this.pollForStoredMessage(
        payloadHashHex,
        params.abandonPoll,
      )
      if (stored !== undefined) {
        this.leaseManager.releaseLease(handle, 'confirmed')
        return {
          stored,
          payloadHashHex,
          txHash: signedTx.txHash,
          leaseIndex: handle.index,
        }
      }

      this.leaseManager.releaseLease(handle, 'stuck')
      throw new MonadStampAbandonedError(
        'Monad stamp submission abandoned: no response from the relay, and ' +
          `GET /message/monad/${payloadHashHex} never found a stored message`,
        payloadHashHex,
      )
    }
  }
}
