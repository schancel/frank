/**
 * Client-side burn-weighted topic vote submission over Monad (ticket #32).
 *
 * Casts an up/down vote against an existing topic post — identified by that post's
 * `payload_hash` — as a Monad burn transaction whose exact value *is* the vote's weight, then
 * submits it to the relay's `PUT /message/monad/topics/vote` route. Mirrors Lotus's
 * `app/src/cashweb/registry/index.ts`'s `addOfferings` (cast additional burn-weight against
 * already-broadcast content, no new payload), and mirrors this repo's own `monad-stamp-client.ts`
 * (ticket #13) closely for everything downstream of calldata construction — read that file's
 * header first; only the differences are re-explained below.
 *
 * ## Scope
 *
 * This module only casts *additional* votes against an already-posted `payload_hash` (a
 * `MonadTopicVote`, `PUT /message/monad/topics/vote`). Posting a brand-new topic message (whose
 * `raw_burn_tx` doubles as its own initial vote, `MonadTopicPost`, `PUT /message/monad/topics`) is
 * ticket #31's scope, implemented in its own sibling file — deliberately not touched here to avoid
 * two concurrently-landing tickets editing the same file. Reading back posts/tallies
 * (`GET /message/monad/topics/:payload_hash`) is ticket #33's scope, blocked on both #31 and #32.
 *
 * ## Calldata layout (`cashweb_registry::monad_topic_verify`, ticket #30)
 *
 * ```text
 * <lokad_id: 4 bytes = "TPIC"><version: 1 byte><direction: 1 byte><commitment: 32 bytes>
 * ```
 *
 * 38 bytes total — `monad-stamp-client.ts`'s `<lokad_id><version><commitment>` (37 bytes) layout
 * with a single extra direction byte spliced in between `version` and `commitment`. Read directly
 * from `backend/cashweb/cashweb-registry/src/monad_topic_verify.rs`, not guessed:
 *
 * - `lokad_id` is `TOPIC_VOTE_LOKAD_ID` (`monad_topic_verify.rs` line 94): `*b"TPIC"` — distinct
 *   from Stamp's `"POND"` (`BROADCAST_MESSAGE_LOKAD_ID`) and plain Stamp's `"STMP"`
 *   (`ADDRESS_METADATA_LOKAD_ID`), so an indexer never confuses this calldata shape with either.
 * - `version` is `TOPIC_COMMITMENT_VERSION_TAG` (line 99): `0x01`. Numerically the same as Stamp's
 *   `COMMITMENT_VERSION_TAG`, but a distinct constant of a distinct wire format per that file's own
 *   docs — versioned independently going forward.
 * - `direction` is `VoteDirection::UP_BYTE` (line 118, `0x01`) for an up-vote, or
 *   `VoteDirection::DOWN_BYTE` (line 120, `0x00`) for a down-vote — mirrors Lotus's `OP_1`/`OP_0`
 *   vote-opcode convention numerically.
 * - `commitment` is the *target* post's `payload_hash` itself (32 bytes, unhashed further) — per
 *   that file's module docs, a topic vote has no pubkey to bind (identity is `ecrecover`-only), so
 *   there's no preimage to construct the way Stamp's commitment would need one. This module never
 *   computes a new hash for a vote; it's handed the target's `payload_hash` directly by the caller.
 *
 * ## Value = weight, exactly (the load-bearing difference from Stamp)
 *
 * `monad_topic_verify.rs`'s own docs are explicit: "there is deliberately no `min_value_wei` --
 * any nonnegative value burned to `burn_address` with the right recipient/commitment is accepted,
 * and its exact value becomes the vote's weight." Stamp's burn only has to clear a minimum
 * threshold (`CASHWEB_STAMP_MIN_BURN_VALUE_WEI`) and the exact amount burned is discarded once the
 * threshold check passes. A topic vote has no such threshold at all — whatever wei value is passed
 * to `buildAndSignCall` as `value` is read back byte-for-byte server-side (`tx.value` in
 * `TopicVoteBurnVerification::Verified`) and becomes this vote's signed weight
 * (`VoteDirection::signed_weight`). This module therefore never rounds, floors, or adds any
 * "minimum clearance" margin to `voteWeightWei` — it's passed straight through as the tx's `value`.
 *
 * ## Burn address
 *
 * `http/monad_topics.rs`'s module docs confirm the topic-vote gate reuses the *same* `.env.example` var
 * the Stamp gate reads (`MONAD_STAMP_BURN_ADDRESS`) rather than a separate topic-specific one —
 * "there's no reason for a second, easy-to-typo burn-address var." This module therefore takes
 * `burnAddress` as an explicit caller-supplied param (same convention `monad-stamp-client.ts` and
 * `monad-http.ts` already use: never read `process.env` directly from inside `app/src/cashweb`),
 * with the expectation that callers pass the very same configured value they already use for
 * Stamp.
 *
 * ## Wire submission: `PUT /message/monad/topics/vote`
 *
 * `handle_put_monad_topic_vote` (`http/monad_topics.rs`) decodes a `MonadTopicVote { target_payload_hash: 1,
 * raw_burn_tx: 2 }` protobuf body and, on success, returns a `StoredMonadTopicVoteEntry
 * { target_payload_hash: 1, sender_address: 2, tx_hash: 3, timestamp: 4, weight: 5 }` protobuf
 * body — read directly from that handler and `proto/topic_message.proto`, not assumed. Uses the
 * real generated bindings (`./topic_message_pb.js`/`.d.ts`, already generated and committed ahead
 * of this ticket — see `proto/topic_message.proto`'s own header), never hand-rolled
 * `jspb.BinaryWriter`/`BinaryReader` calls (see `monad-stamp-client.ts`'s header for why that
 * matters: an earlier ticket's hand-rolled encoding was rejected outright once a working `protoc`
 * toolchain was available). Content-Type is `application/x-protobuf` — `application/octet-stream`
 * 400s against every real `cashweb_http_utils::protobuf::Protobuf` extractor in this crate, topics
 * included.
 *
 * ## Lease acquisition and release policy
 *
 * Identical contract to `monad-stamp-client.ts`'s `submitStampedMessage` — see that file's header,
 * "Lease release policy", for the full reasoning; restated here for this module's own call:
 *
 *   - No sub-account currently `'available'`: `acquireLease()` throws `NoAvailableSubAccountError`
 *     immediately (abort), or — if `waitForLease` is supplied — `acquireLeaseWhenAvailable` polls
 *     for one to free up (retry) instead of ever signing without a lease.
 *   - Building/signing the burn tx throws (before any network call to the relay at all): release
 *     as `'failed'` (`'in-use' -> 'retired'`). No tx was ever broadcast, so the nonce isn't at
 *     risk, but `releaseLease` has no "never attempted" outcome to say so — same documented
 *     trade-off `monad-stamp-client.ts` accepts.
 *   - `PUT /message/monad/topics/vote` returns 2xx: the relay only reaches its success response
 *     after `TopicVoteRelayOutcome::Verified` (see `process_monad_topic_vote` in `http/monad_topics.rs` — every
 *     other outcome is a rejection *before* `add_monad_topic_vote` is ever called), i.e. the burn is
 *     already confirmed on-chain. → `'confirmed'` (`'in-use' -> 'spent'`, never `'available'`
 *     again per ticket #34's correction).
 *   - `PUT /message/monad/topics/vote` returns an HTTP error response (relay reached and responded,
 *     4xx/5xx): per that same handler, a vote entry is only ever recorded after `Verified`, so an
 *     HTTP-level error means the vote was never recorded. → `'failed'` (retire, for the same
 *     conservative "never silently reuse" reason `monad-stamp-client.ts` documents — this module
 *     has no reliable way to distinguish "never touched the network" from "burn landed but the
 *     relay's own storage write failed after verifying it" without fragile JSON-error-body
 *     parsing).
 *   - No HTTP response at all (network/transport failure, relay never definitively reached): this
 *     is the case the ticket calls out as "likely different" from an HTTP error response — unlike
 *     `monad-stamp-client.ts`, there is no `GET /message/monad/topics/:payload_hash` read-back route
 *     available to this ticket's scope to disambiguate (that's #33's route, not yet built), so this
 *     module cannot poll its way to a `'confirmed'` outcome the way Stamp's client does. It
 *     therefore releases as `'stuck'` (retire, nonce not reused) and throws
 *     `MonadTopicVoteAbandonedError` so the caller knows the outcome is genuinely unresolved —
 *     never silently assumed confirmed or failed.
 */
import { Provider, concat, getBytes, hexlify } from 'ethers'
import axios from 'axios'

import __pb_topic_message_pb from './topic_message_pb'
const { MonadTopicVote, StoredMonadTopicVoteEntry } = __pb_topic_message_pb
import { MonadSubAccountPool } from './monad-account-pool'
import {
  AccountLeaseHandle,
  AcquireLeaseWhenAvailableOptions,
  BurnNotSentError,
  SubAccountLeaseManager,
  acquireLeaseWhenAvailable,
} from './monad-account-lease'
import {
  MonadTxOverrides,
  MonadTxSubmitter,
  SignedMonadTx,
} from './monad-account-tx'
import { MonadWalletHandle } from './monad-wallet-handle'

/** `cashweb_registry::monad_topic_verify::TOPIC_VOTE_LOKAD_ID` (`monad_topic_verify.rs` line 94,
 * `*b"TPIC"`) — distinct from Stamp's `"POND"`/`"STMP"` LOKAD IDs. */
const TOPIC_VOTE_LOKAD_ID = new Uint8Array([0x54, 0x50, 0x49, 0x43]) // "TPIC"

/** `cashweb_registry::monad_topic_verify::TOPIC_COMMITMENT_VERSION_TAG` (that file, line 99:
 * `0x01`). Independent of `monad_stamp_verify::COMMITMENT_VERSION_TAG`, even though it shares the
 * same numeric value. */
const TOPIC_COMMITMENT_VERSION_TAG = new Uint8Array([0x01])

/** A topic vote's direction, mirroring `cashweb_registry::monad_topic_verify::VoteDirection`'s
 * `UP_BYTE`/`DOWN_BYTE` convention (`monad_topic_verify.rs` lines 118/120) exactly: `1` = up,
 * `0` = down (Lotus's `OP_1`/`OP_0` numerically). */
export type TopicVoteDirection = 'up' | 'down'

const DIRECTION_BYTE: Record<TopicVoteDirection, number> = {
  up: 0x01,
  down: 0x00,
}

/** `cashweb_registry::monad_topic_verify::{CALLDATA_PREFIX_LEN, CALLDATA_COMMITMENT_LEN}`
 * (`monad_topic_verify.rs` lines 102/104: `6 + 32 = 38` total):
 * `<lokad_id: 4><version: 1><direction: 1><commitment: 32>`. Exported for tests that want to
 * assert on the exact calldata length independent of this module's other constants. */
export const MONAD_TOPIC_VOTE_CALLDATA_LENGTH =
  TOPIC_VOTE_LOKAD_ID.length + TOPIC_COMMITMENT_VERSION_TAG.length + 1 + 32

/** Build the exact `<lokad_id: TPIC><version: 0x01><direction><commitment: 32>` calldata layout
 * `monad_topic_verify::parse_topic_vote_calldata` decodes (see this file's header), as a `0x`-
 * prefixed hex string ready to pass straight into `MonadAccountTxSigner.buildAndSignCall`.
 *
 * `commitment` must be the *target* post's `payload_hash` — this function never hashes anything
 * itself, since a vote carries no payload of its own to hash (see this file's header). */
export function buildMonadTopicVoteCalldata(
  direction: TopicVoteDirection,
  commitment: Uint8Array,
): string {
  if (commitment.length !== 32) {
    throw new Error(
      `Monad topic vote commitment (target payload_hash) must be exactly 32 bytes, got ${commitment.length}`,
    )
  }
  return concat([
    TOPIC_VOTE_LOKAD_ID,
    TOPIC_COMMITMENT_VERSION_TAG,
    new Uint8Array([DIRECTION_BYTE[direction]]),
    commitment,
  ])
}

/**
 * `MonadTopicVote` from `topic_message.proto`, decoded/encoded here in plain-object form. Field
 * numbers match the `.proto` exactly: `target_payload_hash = 1`, `raw_burn_tx = 2`.
 */
export interface MonadTopicVoteProto {
  targetPayloadHash: Uint8Array
  rawBurnTx: Uint8Array
}

/**
 * `StoredMonadTopicVoteEntry` from `topic_message.proto` — what `PUT /message/monad/topics/vote`
 * returns on success (`handle_put_monad_topic_vote`, `http/monad_topics.rs`). Field numbers:
 * `target_payload_hash = 1`, `sender_address = 2`, `tx_hash = 3`, `timestamp = 4`, `weight = 5`.
 */
export interface StoredMonadTopicVoteEntryProto {
  targetPayloadHash: Uint8Array
  senderAddress: Uint8Array
  txHash: Uint8Array
  /** Milliseconds since the Unix epoch. Decoded via `jspb.BinaryReader.readInt64`, which returns a
   * plain JS `number` (not `bigint`) — safe here for the same reason `monad-stamp-client.ts`'s
   * `StoredMonadMessageProto.timestamp` documents. */
  timestamp: number
  /** Signed vote weight: `+value_wei` for an up-vote, `-value_wei` for a down-vote, exactly as
   * burned on-chain (never thresholded). Decoded via `jspb.BinaryReader.readSint64` into a plain
   * JS `number` — see `proto/topic_message.proto`'s own doc on `StoredMonadTopicVoteEntry.weight`
   * for why `sint64` is a safe simplification at this repo's Stamp/vote burn magnitudes (~1e12
   * wei), many orders of magnitude below `Number.MAX_SAFE_INTEGER`/`i64::MAX`. */
  weight: number
}

/** Encode a {@link MonadTopicVoteProto} to protobuf wire-format bytes, via the generated
 * `MonadTopicVote` class. */
export function encodeMonadTopicVote(vote: MonadTopicVoteProto): Uint8Array {
  const pb = new MonadTopicVote()
  pb.setTargetPayloadHash(vote.targetPayloadHash)
  pb.setRawBurnTx(vote.rawBurnTx)
  return pb.serializeBinary()
}

/** Decode protobuf wire-format bytes into a {@link MonadTopicVoteProto}. Round-trips with
 * {@link encodeMonadTopicVote}. */
export function decodeMonadTopicVote(bytes: Uint8Array): MonadTopicVoteProto {
  const pb = MonadTopicVote.deserializeBinary(bytes)
  return {
    targetPayloadHash: pb.getTargetPayloadHash_asU8(),
    rawBurnTx: pb.getRawBurnTx_asU8(),
  }
}

/** Decode protobuf wire-format bytes into a {@link StoredMonadTopicVoteEntryProto} — what
 * `PUT /message/monad/topics/vote` returns on success. */
export function decodeStoredMonadTopicVoteEntry(
  bytes: Uint8Array,
): StoredMonadTopicVoteEntryProto {
  const pb = StoredMonadTopicVoteEntry.deserializeBinary(bytes)
  return {
    targetPayloadHash: pb.getTargetPayloadHash_asU8(),
    senderAddress: pb.getSenderAddress_asU8(),
    txHash: pb.getTxHash_asU8(),
    timestamp: pb.getTimestamp(),
    weight: pb.getWeight(),
  }
}

/** Hex-encode `bytes` with no `0x` prefix — the shape this repo's other Monad clients use for
 * display/logging (matches `monad-stamp-client.ts`'s `toBareHex`). */
function toBareHex(bytes: Uint8Array): string {
  return hexlify(bytes).slice(2)
}

/** Base class for every error this module throws. */
export class MonadTopicVoteError extends Error {}

/** Thrown when `PUT /message/monad/topics/vote` returns an HTTP-level error response (the relay was
 * reached and definitively rejected the vote — see this file's header, "Lease acquisition and
 * release policy"). */
export class MonadTopicVoteRejectedError extends MonadTopicVoteError {
  readonly status: number | undefined
  readonly detail: unknown

  constructor(message: string, status: number | undefined, detail: unknown) {
    super(message)
    this.status = status
    this.detail = detail
  }
}

/** Thrown when a network/transport-level failure left the outcome genuinely unknown — the relay
 * was never definitively reached, and (unlike `monad-stamp-client.ts`) this ticket's scope has no
 * read-back route available to disambiguate (that's #33's job). The lease has already been
 * released as `'stuck'` (retired) by the time this is thrown. */
export class MonadTopicVoteAbandonedError extends MonadTopicVoteError {
  readonly targetPayloadHashHex: string

  constructor(message: string, targetPayloadHashHex: string) {
    super(message)
    this.targetPayloadHashHex = targetPayloadHashHex
  }
}

/** Params for `MonadTopicVoteClient.castVote`. */
export interface CastTopicVoteParams {
  /** The target post's `payload_hash` (32 raw bytes, not hex) — the post being voted on. This
   * module never computes or re-derives this; it must be the exact value the target post was
   * originally stored under. */
  targetPayloadHash: Uint8Array
  /** Up or down — encoded as calldata's `direction` byte (see this file's header). */
  direction: TopicVoteDirection
  /** `0x`-prefixed Monad burn address — reuses `MONAD_STAMP_BURN_ADDRESS` (see `.env.example` and
   * this file's header, "Burn address"). Passed explicitly rather than read from `process.env`
   * here, matching `monad-http.ts`/`monad-stamp-client.ts`'s established convention. */
  burnAddress: string
  /** Value, in wei, to burn to `burnAddress` — this vote's exact weight (see this file's header,
   * "Value = weight, exactly"). Passed through untouched as the signed tx's `value`; never
   * thresholded, rounded, or padded by this module. */
  voteWeightWei: bigint
  overrides?: MonadTxOverrides
  /** If provided, waits (`acquireLeaseWhenAvailable`) for a sub-account to free up instead of
   * failing immediately when the pool is fully leased. Omit for the default immediate-reject
   * behavior (`SubAccountLeaseManager.acquireLease`). */
  waitForLease?: AcquireLeaseWhenAvailableOptions
  /** Lease exactly this (already funded, `'available'`) sub-account -- see
   * `SubmitTopicPostParams.leaseIndex`. Takes precedence over `waitForLease`. */
  leaseIndex?: number
}

/** Outcome of a successful `castVote` call — the burn tx confirmed on-chain and the relay recorded
 * the vote (a 2xx `PUT /message/monad/topics/vote` response is the only way to reach this — see
 * this file's header: there is deliberately no network-failure fallback poll in this ticket's
 * scope). */
export interface CastTopicVoteResult {
  stored: StoredMonadTopicVoteEntryProto
  /** Bare (no `0x`) hex of the target post's `payload_hash`. */
  targetPayloadHashHex: string
  txHash: string
  leaseIndex: number
}

/**
 * Ties together sub-account leasing (#14/#18), burn-tx construction (#11), and the live
 * `PUT /message/monad/topics/vote` HTTP surface (#30) into one call: "cast this burn-weighted vote
 * against an already-posted topic message and hand it to the relay." See this file's header for
 * the full calldata/protobuf/lease-release design.
 */
export class MonadTopicVoteClient {
  private readonly pool: MonadSubAccountPool
  private readonly leaseManager: SubAccountLeaseManager
  private readonly provider: Provider
  private readonly httpClient: MonadTxSubmitter
  /** Base URL of the `cashweb-registry` relay, e.g. `https://relay.example.com` — no trailing
   * slash. `/message/monad/topics/vote` (`PUT`) is appended to it. */
  private readonly relayBaseUrl: string

  constructor(params: MonadWalletHandle) {
    this.pool = params.pool
    this.leaseManager = params.leaseManager
    this.provider = params.provider
    this.httpClient = params.httpClient
    this.relayBaseUrl = params.relayBaseUrl.replace(/\/+$/, '')
  }

  private async putTopicVote(
    vote: MonadTopicVoteProto,
  ): Promise<StoredMonadTopicVoteEntryProto> {
    const response = await axios({
      method: 'put',
      url: `${this.relayBaseUrl}/message/monad/topics/vote`,
      data: encodeMonadTopicVote(vote),
      // Same bug class `monad-stamp-client.ts` documents fixing for `PUT /message/monad`:
      // `handle_put_monad_topic_vote` decodes its body via the same `cashweb_http_utils::protobuf::
      // Protobuf` extractor every protobuf route in this crate uses, which unconditionally
      // requires exactly `application/x-protobuf` — `application/octet-stream` 400s.
      headers: { 'Content-Type': 'application/x-protobuf' },
      responseType: 'arraybuffer',
    })
    return decodeStoredMonadTopicVoteEntry(new Uint8Array(response.data))
  }

  /**
   * Casts `params.direction`-weighted vote of `params.voteWeightWei` against
   * `params.targetPayloadHash`: builds the calldata, leases a sub-account, builds+signs the burn
   * tx (value = `voteWeightWei` exactly), `PUT`s the assembled `MonadTopicVote` to the relay, and
   * releases the lease per this file's header's documented policy. Throws
   * {@link MonadTopicVoteRejectedError} if the relay definitively rejected the vote, or
   * {@link MonadTopicVoteAbandonedError} if a network failure left the outcome unresolved (no
   * read-back fallback is available in this ticket's scope — see header).
   */
  async castVote(params: CastTopicVoteParams): Promise<CastTopicVoteResult> {
    if (params.targetPayloadHash.length !== 32) {
      throw new Error(
        `targetPayloadHash must be exactly 32 bytes, got ${params.targetPayloadHash.length}`,
      )
    }
    if (params.voteWeightWei < 0n) {
      throw new Error(
        `voteWeightWei must be nonnegative, got ${params.voteWeightWei}`,
      )
    }

    const calldata = buildMonadTopicVoteCalldata(
      params.direction,
      params.targetPayloadHash,
    )
    const targetPayloadHashHex = toBareHex(params.targetPayloadHash)

    const handle: AccountLeaseHandle =
      params.leaseIndex !== undefined
        ? this.leaseManager.acquireForIndex(params.leaseIndex)
        : params.waitForLease
        ? await acquireLeaseWhenAvailable(
            this.leaseManager,
            params.waitForLease,
          )
        : this.leaseManager.acquireLease()

    let signedTx: SignedMonadTx
    try {
      const signer = this.pool.getSigner(handle.index, {
        provider: this.provider,
        httpClient: this.httpClient,
      })
      // `value` is the vote's exact weight, not merely a minimum-clearing burn (see this file's
      // header, "Value = weight, exactly") — passed through untouched.
      signedTx = await signer.buildAndSignCall(
        params.burnAddress,
        params.voteWeightWei,
        calldata,
        params.overrides,
      )
    } catch (err) {
      // Nothing was signed, broadcast or sent to the relay, so the account still holds its funds
      // and an untouched nonce: hand it back so a retry reuses it instead of funding another.
      this.leaseManager.releaseLease(handle, 'unused')
      throw new BurnNotSentError(
        err instanceof Error ? err.message : String(err),
        err,
      )
    }

    const vote: MonadTopicVoteProto = {
      targetPayloadHash: params.targetPayloadHash,
      rawBurnTx: getBytes(signedTx.rawTx),
    }

    try {
      const stored = await this.putTopicVote(vote)
      this.leaseManager.releaseLease(handle, 'confirmed')
      return {
        stored,
        targetPayloadHashHex,
        txHash: signedTx.txHash,
        leaseIndex: handle.index,
      }
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        this.leaseManager.releaseLease(handle, 'failed')
        throw new MonadTopicVoteRejectedError(
          `Relay rejected the Monad topic vote (HTTP ${err.response.status})`,
          err.response.status,
          err.response.data,
        )
      }

      // No HTTP response at all: genuinely unknown whether the relay received/broadcast/recorded
      // the vote before the connection dropped. Unlike `monad-stamp-client.ts`, there is no
      // `GET /message/monad/topics/:payload_hash` route in this ticket's scope to poll for
      // disambiguation (ticket #33, not yet built) — retire and surface the ambiguity rather than
      // guessing either way.
      this.leaseManager.releaseLease(handle, 'stuck')
      throw new MonadTopicVoteAbandonedError(
        'The relay did not respond, so it is unknown whether your vote was recorded. ' +
          'Check the post before voting again: a retry could burn a second time. ' +
          `(target ${targetPayloadHashHex})`,
        targetPayloadHashHex,
      )
    }
  }
}
