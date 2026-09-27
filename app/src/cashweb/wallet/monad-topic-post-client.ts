/**
 * Client-side topic post + initial burn-weighted vote, over Monad (ticket #31).
 *
 * Mirrors `createBroadcast` from Lotus's `app/src/cashweb/registry/index.ts`: serialize the post
 * payload, hash it, build a burn transaction whose value is the initial vote's weight, and submit
 * payload + burn tx together to the registry. Structurally this file is `monad-stamp-client.ts`
 * (#13) with a topic-specific payload shape and calldata layout swapped in — same sub-account
 * leasing, same value+calldata signing primitive, same lease-release contract. Read that file's
 * header first; only the differences are called out below.
 *
 * ## What this does
 *
 * 1. Builds the post's payload by reusing this app's existing Lotus-broadcast wire shape
 *    (`../registry/broadcast_pb`'s `BroadcastMessage`/`BroadcastEntry`/`TopicPost`, and
 *    `../types/forum`'s `ForumMessageEntry`) rather than inventing a new payload encoding — see
 *    "Payload encoding, and why there's no encryption here" below.
 * 2. Computes `payload_hash = SHA256(serialized payload)`.
 * 3. Builds the calldata commitment as `<lokad_id: TOPIC_VOTE_LOKAD_ID><version:
 *    TOPIC_COMMITMENT_VERSION_TAG><direction: 0x01 up / 0x00 down><commitment: 32 bytes>` (38
 *    bytes total) — the exact layout `cashweb_registry::monad_topic_verify::
 *    parse_topic_calldata` decodes (see `backend/cashweb/cashweb-registry/src/
 *    monad_topic_verify.rs` lines 26-38 for the field-by-field doc, and its `TOPIC_VOTE_LOKAD_ID`/
 *    `TOPIC_COMMITMENT_VERSION_TAG`/`VoteDirection::{UP_BYTE,DOWN_BYTE}` constants for the exact
 *    byte values this module hardcodes below). Distinct from `monad-stamp-client.ts`'s 37-byte
 *    `<POND><0x01><commitment>` layout by exactly the one extra direction byte.
 * 4. Leases a sub-account (`SubAccountLeaseManager`, #18) and builds+signs the burn tx via
 *    `MonadAccountTxSigner.buildAndSignCall` (#11): value → the initial vote's weight (wei), to →
 *    the same `MONAD_STAMP_BURN_ADDRESS` the backend's `MonadTopicGateConfig` reads (see
 *    `backend/cashweb/cashweb-registry/src/http/monad_topics.rs`'s module doc: a topic vote burns to the
 *    *same* configured Stamp burn address, just tagged with a different LOKAD ID in its calldata —
 *    there is deliberately no separate topic burn-address env var).
 * 5. Assembles a `MonadTopicPost { topic, parent_post_hash, raw_burn_tx, encrypted_payload,
 *    payload_hash }` and `PUT`s it to `/message/monad/topics`, expecting a `StoredMonadTopicPost`
 *    back.
 * 6. Releases the lease per the exact same three-way outcome mapping `monad-stamp-client.ts`
 *    documents in its own "Lease release policy" section (2xx → `'confirmed'`; HTTP error response
 *    → `'failed'`; network/transport failure → fall back to polling `GET
 *    /message/monad/topics/:payload_hash` before deciding `'confirmed'`/`'stuck'`) — see that
 *    section below for why this file repeats rather than imports that logic.
 *
 * ## Payload encoding, and why there's no encryption here
 *
 * `MonadTopicPost.encrypted_payload`'s doc comment (`topic_message.proto`) says it's "opaque to
 * the relay exactly like `MonadStampedMessage.encrypted_payload`" — but a topic *post* is
 * public by nature (unlike a Stamp/direct message, which has one or more specific recipients), so
 * there is no counterparty key to encrypt it for. Lotus's own `createBroadcast` (the function this
 * ticket explicitly mirrors) confirms this: it serializes its `BroadcastMessage` protobuf and
 * hashes/signs/burns against it directly, with no encryption step at all — the "opaque to the
 * relay" framing there is about the relay not needing to parse the payload to do its job, not
 * about confidentiality. This module follows that precedent: `buildTopicPostPayload` produces
 * plain (unencrypted) serialized `BroadcastMessage` bytes, reusing the app's *existing* topic
 * payload shape (`../registry/broadcast_pb`'s generated `BroadcastMessage`/`BroadcastEntry`/
 * `TopicPost` classes, and `../types/forum`'s `ForumMessageEntry`/`TextPost` types) rather than
 * `monad-message-envelope.ts`'s (#9) ECDH-encrypted envelope, which is specifically a
 * recipient-addressed direct-message convention with no meaning for a public topic post. Per this
 * ticket's own instructions: reuse an existing payload type if one exists (it does — this one),
 * don't invent a new encryption scheme for content that was never encrypted upstream either.
 *
 * ## Protobuf encoding
 *
 * Uses the real generated bindings already committed to `main` ahead of both #31 and #32:
 * `./proto/topic_message.proto` → `./topic_message_pb.js`/`.d.ts` (ticket #30/#39's toolchain —
 * see `monad-stamp-client.ts`'s header for why hand-rolled `jspb.BinaryWriter`/`BinaryReader` was
 * rejected and replaced with a real `protoc`/`protoc-gen-js`/`protoc-gen-ts` toolchain). This file
 * does not regenerate or edit those bindings — confirmed they already carry every field this
 * ticket needs (`MonadTopicPost.parent_post_hash`, `StoredMonadTopicPost.network_tag`, etc.).
 *
 * ## Lease release policy
 *
 * Same three-outcome contract as `monad-stamp-client.ts` (`SubAccountLeaseManager.releaseLease`,
 * #18, corrected by #34: `'confirmed'` → `'in-use' -> 'spent'`, `'failed'`/`'stuck'` →
 * `'in-use' -> 'retired'`, **never** back to `'available'`):
 *
 *   - **Build/sign the burn tx throws** (before any network call to the relay): released as
 *     `'failed'`. No transaction was ever broadcast, so the account's nonce isn't actually at
 *     risk, but `releaseLease` has no "never attempted" outcome to say so — same documented
 *     trade-off `monad-stamp-client.ts` makes.
 *   - **`PUT /message/monad/topics` returns 2xx**: `process_monad_topic_post` (`http/monad_topics.rs`) only
 *     reaches its success response after `TopicVoteRelayOutcome::Verified` — every other outcome
 *     is a rejection before any store happens. → `'confirmed'`.
 *   - **`PUT /message/monad/topics` returns an HTTP error response** (relay reached and
 *     definitively responded): per the same handler, a stored post only ever exists after
 *     `Verified`, so an HTTP-level error means the post was never accepted/stored. → `'failed'`
 *     (retiring rather than risking the rare "verified but the final store call itself 500'd"
 *     case — same conservative choice `monad-stamp-client.ts` documents for its own `PUT`, for the
 *     same reason: distinguishing that case would mean parsing `ProcessTopicPostError`'s variant
 *     out of the JSON error body, which is needlessly fragile).
 *   - **No HTTP response at all** (network/transport failure, genuinely unknown whether the relay
 *     ever received/broadcast/stored the post before the connection dropped): falls back to
 *     polling `GET /message/monad/topics/:payload_hash` (`pollForStoredPost`) — that route already
 *     exists server-side (`handle_get_monad_topic_post`, `http/monad_topics.rs`) purely as an internal
 *     disambiguation mechanism here, the same way `monad-stamp-client.ts` uses its own `GET
 *     /message/monad/:payload_hash` fallback poll; this is *not* the "read back posts" feature
 *     (ticket #33's scope) — it never surfaces a general read API, only resolves this one
 *     ambiguous case. Found → `'confirmed'`. Still not found after the poll budget is exhausted →
 *     `'stuck'`, and `MonadTopicPostAbandonedError` is thrown.
 */
import { Provider, concat, getBytes, hexlify, sha256 } from 'ethers'
import axios from 'axios'

// Ticket #51 (Vite migration): see cashweb/pop.ts's comment for why generated `*_pb.js` files
// need a default import + destructure rather than direct named imports -- all six of these are
// used as real runtime values (`new MonadTopicPost()`, `.deserializeBinary(...)`, etc.), not just
// types, so (unlike that file) this can't simplify down to `import type`.
import __pb_topic_message_pb from './topic_message_pb'
const { MonadTopicPost, MonadTopicPostView, StoredMonadTopicPost } =
  __pb_topic_message_pb
import __pb_broadcast_pb from '../registry/broadcast_pb'
const {
  BroadcastEntry,
  BroadcastMessage,
  ForumPost: BroadcastForumPostPayload,
} = __pb_broadcast_pb
import { ForumMessageEntry } from '../types/forum'
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
import { MonadWalletHandle } from './monad-wallet-handle'

/** `cashweb_registry::monad_topic_verify::TOPIC_VOTE_LOKAD_ID` (that file, line 94: `*b"TPIC"`) —
 * distinct from both `monad-stamp-client.ts`'s `"POND"` and Lotus's private-message LOKAD ID. */
const TOPIC_VOTE_LOKAD_ID = new Uint8Array([0x54, 0x50, 0x49, 0x43]) // "TPIC"

/** `cashweb_registry::monad_topic_verify::TOPIC_COMMITMENT_VERSION_TAG` (that file, line 99:
 * `0x01`). Independent of `monad-stamp-client.ts`'s own `COMMITMENT_VERSION_TAG` (both currently
 * `0x01`, but they version their own calldata layouts separately). */
const TOPIC_COMMITMENT_VERSION_TAG = new Uint8Array([0x01])

/** `cashweb_registry::monad_topic_verify::VoteDirection::{UP_BYTE, DOWN_BYTE}` (that file, lines
 * 118-119). An up-vote burns with direction byte `0x01`; a down-vote with `0x00` — mirroring
 * Lotus's `OP_1`/`OP_0` vote-direction convention (see that file's own module doc). */
export type TopicVoteDirection = 'up' | 'down'

const TOPIC_VOTE_DIRECTION_BYTE: Record<TopicVoteDirection, number> = {
  up: 0x01,
  down: 0x00,
}

/** Total calldata length: `<lokad_id: 4><version: 1><direction: 1><commitment: 32>` = 38 bytes.
 * One byte longer than `monad-stamp-client.ts`'s `MONAD_STAMP_CALLDATA_LENGTH` (37) — the extra
 * direction byte a topic vote's calldata carries that a plain Stamp burn's doesn't. Exported for
 * tests that want to assert on the exact calldata length independent of this module's other
 * constants. */
export const MONAD_TOPIC_VOTE_CALLDATA_LENGTH =
  TOPIC_VOTE_LOKAD_ID.length +
  TOPIC_COMMITMENT_VERSION_TAG.length +
  1 /* direction */ +
  32 /* commitment */

/**
 * `MonadTopicPost` from `topic_message.proto`, decoded/encoded here in plain-object form (field
 * names match the `.proto` exactly: `topic = 1`, `parent_post_hash = 2`, `raw_burn_tx = 3`,
 * `encrypted_payload = 4`, `payload_hash = 5`).
 */
export interface MonadTopicPostProto {
  topic: string
  parentPostHash: Uint8Array
  rawBurnTx: Uint8Array
  encryptedPayload: Uint8Array
  payloadHash: Uint8Array
}

/**
 * `StoredMonadTopicPost` from `topic_message.proto` — what `PUT /message/monad/topics` returns on
 * success, and what `GET /message/monad/topics/:payload_hash` wraps in a `MonadTopicPostView`.
 */
export interface StoredMonadTopicPostProto {
  post: MonadTopicPostProto | undefined
  senderAddress: Uint8Array
  txHash: Uint8Array
  /** Milliseconds since the Unix epoch. See `monad-stamp-client.ts`'s
   * `StoredMonadMessageProto.timestamp` doc for why a plain JS `number` is safe here. */
  timestamp: number
  /** Frank-specific network tag (ticket #39, see PLAN.md constraint 9) — see
   * `monad-stamp-client.ts`'s `StoredMonadMessageProto.networkTag` doc; the same "exists, decodes,
   * never asserted by the client" scope applies here. */
  networkTag: Uint8Array
}

/** `MonadTopicPostView` from `topic_message.proto` — `GET /message/monad/topics/:payload_hash`'s
 * response shape, used here only as this module's internal network-failure disambiguation poll
 * (see this file's header, "Lease release policy"); reading a post's tally for its own sake is
 * ticket #33's scope, not this one's. */
export interface MonadTopicPostViewProto {
  post: StoredMonadTopicPostProto | undefined
  voteWeight: number
}

function encodeMonadTopicPost(msg: MonadTopicPostProto): Uint8Array {
  const pb = new MonadTopicPost()
  pb.setTopic(msg.topic)
  pb.setParentPostHash(msg.parentPostHash)
  pb.setRawBurnTx(msg.rawBurnTx)
  pb.setEncryptedPayload(msg.encryptedPayload)
  pb.setPayloadHash(msg.payloadHash)
  return pb.serializeBinary()
}

/** Decode protobuf wire-format bytes into a {@link MonadTopicPostProto}. Round-trips with
 * {@link encodeMonadTopicPost}. Exported for tests. */
export function decodeMonadTopicPost(bytes: Uint8Array): MonadTopicPostProto {
  const pb = MonadTopicPost.deserializeBinary(bytes)
  return {
    topic: pb.getTopic(),
    parentPostHash: pb.getParentPostHash_asU8(),
    rawBurnTx: pb.getRawBurnTx_asU8(),
    encryptedPayload: pb.getEncryptedPayload_asU8(),
    payloadHash: pb.getPayloadHash_asU8(),
  }
}

function decodeStoredMonadTopicPostPb(
  pb: StoredMonadTopicPost,
): StoredMonadTopicPostProto {
  const nested = pb.getPost()
  return {
    post: nested
      ? {
          topic: nested.getTopic(),
          parentPostHash: nested.getParentPostHash_asU8(),
          rawBurnTx: nested.getRawBurnTx_asU8(),
          encryptedPayload: nested.getEncryptedPayload_asU8(),
          payloadHash: nested.getPayloadHash_asU8(),
        }
      : undefined,
    senderAddress: pb.getSenderAddress_asU8(),
    txHash: pb.getTxHash_asU8(),
    timestamp: pb.getTimestamp(),
    networkTag: pb.getNetworkTag_asU8(),
  }
}

/** Decode protobuf wire-format bytes into a {@link StoredMonadTopicPostProto} — what
 * `PUT /message/monad/topics` returns on success. */
export function decodeStoredMonadTopicPost(
  bytes: Uint8Array,
): StoredMonadTopicPostProto {
  return decodeStoredMonadTopicPostPb(
    StoredMonadTopicPost.deserializeBinary(bytes),
  )
}

/** Decode protobuf wire-format bytes into a {@link MonadTopicPostViewProto} — what
 * `GET /message/monad/topics/:payload_hash` returns (used here only for the fallback poll). */
export function decodeMonadTopicPostView(
  bytes: Uint8Array,
): MonadTopicPostViewProto {
  const pb = MonadTopicPostView.deserializeBinary(bytes)
  const nested = pb.getPost()
  return {
    post: nested ? decodeStoredMonadTopicPostPb(nested) : undefined,
    voteWeight: pb.getVoteWeight(),
  }
}

/**
 * Serializes a topic post's payload using this app's existing Lotus-broadcast wire shape (see
 * this file's header, "Payload encoding, and why there's no encryption here"): a `BroadcastMessage`
 * carrying `topic`, `timestamp`, `entries` (one `BroadcastEntry` per {@link ForumMessageEntry}),
 * and `parentDigest`. Mirrors `createBroadcast`'s own payload-construction loop
 * (`app/src/cashweb/registry/index.ts`) field-for-field, including its `assert(false, 'unsupported
 * entry type')` behavior for any entry kind other than `'post'` (the only kind
 * `ForumMessageEntry`/`TextPost` currently defines).
 *
 * @param timestampMs Defaults to `Date.now()`; overridable for deterministic tests.
 */
export function buildTopicPostPayload(params: {
  topic: string
  entries: ForumMessageEntry[]
  parentPostHash?: Uint8Array
  timestampMs?: number
}): Uint8Array {
  const broadcastMessage = new BroadcastMessage()
  broadcastMessage.setTopic(params.topic)
  broadcastMessage.setTimestamp(params.timestampMs ?? Date.now())
  if (params.parentPostHash && params.parentPostHash.length > 0) {
    broadcastMessage.setParentDigest(params.parentPostHash)
  }

  const protoEntries: BroadcastEntry[] = []
  for (const entry of params.entries) {
    if (entry.kind !== 'post') {
      throw new Error(`unsupported topic entry kind: ${entry.kind}`)
    }
    const textEntry = new BroadcastEntry()
    textEntry.setKind(entry.kind)
    const payload = new BroadcastForumPostPayload()
    if (entry.title) payload.setTitle(entry.title)
    if (entry.url) payload.setUrl(entry.url)
    if (entry.message) payload.setMessage(entry.message)
    textEntry.setPayload(payload.serializeBinary())
    protoEntries.push(textEntry)
  }
  broadcastMessage.setEntriesList(protoEntries)

  return broadcastMessage.serializeBinary()
}

/** `payload_hash = SHA256(serialized payload)` — both `MonadTopicPost.payload_hash` and the
 * on-chain commitment the initial-vote burn tx's calldata must carry. Returns the raw 32-byte
 * hash, not hex. */
export function computeTopicPostCommitment(payload: Uint8Array): Uint8Array {
  return getBytes(sha256(payload))
}

/** Build the exact `<lokad_id: TOPIC_VOTE_LOKAD_ID><version:
 * TOPIC_COMMITMENT_VERSION_TAG><direction: 1 byte><commitment: 32 bytes>` calldata layout
 * `monad_topic_verify::parse_topic_calldata` decodes (see this file's header), as a `0x`-prefixed
 * hex string ready to pass straight into `MonadAccountTxSigner.buildAndSignCall`. */
export function buildTopicVoteCalldata(
  direction: TopicVoteDirection,
  commitment: Uint8Array,
): string {
  if (commitment.length !== 32) {
    throw new Error(
      `Topic vote commitment must be exactly 32 bytes, got ${commitment.length}`,
    )
  }
  return concat([
    TOPIC_VOTE_LOKAD_ID,
    TOPIC_COMMITMENT_VERSION_TAG,
    new Uint8Array([TOPIC_VOTE_DIRECTION_BYTE[direction]]),
    commitment,
  ])
}

/** Hex-encode `bytes` with no `0x` prefix — the shape Rust's `hex::decode` (used by
 * `handle_get_monad_topic_post`'s `:payload_hash` path segment) expects. */
function toBareHex(bytes: Uint8Array): string {
  return hexlify(bytes).slice(2)
}

/** Base class for every error this module throws. */
export class MonadTopicPostError extends Error {}

/** Thrown when `PUT /message/monad/topics` returns an HTTP-level error response (the relay was
 * reached and definitively rejected the post — see this file's header, "Lease release policy"). */
export class MonadTopicPostRejectedError extends MonadTopicPostError {
  readonly status: number | undefined
  readonly detail: unknown

  constructor(message: string, status: number | undefined, detail: unknown) {
    super(message)
    this.status = status
    this.detail = detail
  }
}

/** Thrown when a network-level failure left the outcome genuinely unknown, and polling
 * `GET /message/monad/topics/:payload_hash` never turned up a stored post within the configured
 * budget (see this file's header, "Lease release policy"). The lease has already been released as
 * `'stuck'` (retired) by the time this is thrown. */
export class MonadTopicPostAbandonedError extends MonadTopicPostError {
  readonly payloadHashHex: string

  constructor(message: string, payloadHashHex: string) {
    super(message)
    this.payloadHashHex = payloadHashHex
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Options for the `GET /message/monad/topics/:payload_hash` fallback poll used when a `PUT`
 * attempt fails with no HTTP response at all (see this file's header, "Lease release policy"). */
export interface AbandonPollOptions {
  /** Delay between poll attempts, in ms. Default 2000. */
  intervalMs?: number
  /** Number of `GET` attempts before giving up. Default 5. */
  maxAttempts?: number
  /** Injectable in place of the real `setTimeout`-based delay, for deterministic tests. */
  sleep?: (ms: number) => Promise<void>
}

/** Params for `MonadTopicPostClient.submitTopicPost`. */
export interface SubmitTopicPostParams {
  topic: string
  entries: ForumMessageEntry[]
  /** SHA256 digest of the parent post this is replying to, if any. Omit (or pass an empty array)
   * for a top-level post. */
  parentPostHash?: Uint8Array
  /** This post's initial vote direction — even a post's own first vote can be up or down. */
  direction: TopicVoteDirection
  /** `0x`-prefixed Monad burn address (see `frank/.env.example`'s `MONAD_STAMP_BURN_ADDRESS`,
   * reused as-is for topic votes per `http/monad_topics.rs`'s module doc — there is no separate topic
   * burn-address var). Passed explicitly rather than read from `process.env` here, matching
   * `monad-http.ts`'s established convention. */
  burnAddress: string
  /** Value, in wei, to burn — this post's initial vote weight. */
  voteWeightWei: bigint
  overrides?: MonadTxOverrides
  /** If provided, waits (`acquireLeaseWhenAvailable`) for a sub-account to free up instead of
   * failing immediately when the pool is fully leased. Omit for the default immediate-reject
   * behavior (`SubAccountLeaseManager.acquireLease`). */
  waitForLease?: AcquireLeaseWhenAvailableOptions
  /** Overrides the default fallback poll used only when a `PUT` attempt fails with no HTTP
   * response at all (see this file's header, "Lease release policy"). */
  abandonPoll?: AbandonPollOptions
  /** Overrides `Date.now()` for the payload's `timestamp` field — for deterministic tests. */
  timestampMs?: number
}

/** Outcome of a successful `submitTopicPost` call. */
export interface SubmitTopicPostResult {
  stored: StoredMonadTopicPostProto
  /** Bare (no `0x`) hex of `payload_hash` — also `GET /message/monad/topics/:payload_hash`'s path
   * segment. */
  payloadHashHex: string
  txHash: string
  leaseIndex: number
}

/**
 * Ties together sub-account leasing (#14/#18), burn-tx construction (#11), and the live
 * `PUT /message/monad/topics` / `GET /message/monad/topics/:payload_hash` HTTP surface (#30) into
 * one call: "post this topic message, with its initial burn-weighted vote, to Monad and hand it to
 * the relay." See this file's header for the full payload/calldata/lease-release design.
 */
export class MonadTopicPostClient {
  private readonly pool: MonadSubAccountPool
  private readonly leaseManager: SubAccountLeaseManager
  private readonly provider: Provider
  private readonly httpClient: MonadTxSubmitter
  /** Base URL of the `cashweb-registry` relay, e.g. `https://relay.example.com` — no trailing
   * slash. `/message/monad/topics` (`PUT`) and `/message/monad/topics/:payload_hash` (`GET`) are
   * appended to it. */
  private readonly relayBaseUrl: string

  constructor(params: MonadWalletHandle) {
    this.pool = params.pool
    this.leaseManager = params.leaseManager
    this.provider = params.provider
    this.httpClient = params.httpClient
    this.relayBaseUrl = params.relayBaseUrl.replace(/\/+$/, '')
  }

  /** Fetch a previously-stored post view by its bare-hex `payload_hash` via
   * `GET /message/monad/topics/:payload_hash`. Returns `undefined` on a `404` (not yet
   * stored/found) — any other non-2xx response, or a network-level failure, propagates as a
   * thrown error. Used internally as this module's network-failure disambiguation poll — see this
   * file's header, "Lease release policy". */
  async fetchStoredTopicPostView(
    payloadHashHex: string,
  ): Promise<MonadTopicPostViewProto | undefined> {
    try {
      const response = await axios({
        method: 'get',
        url: `${this.relayBaseUrl}/message/monad/topics/${payloadHashHex}`,
        responseType: 'arraybuffer',
      })
      return decodeMonadTopicPostView(new Uint8Array(response.data))
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        return undefined
      }
      throw err
    }
  }

  private async pollForStoredPost(
    payloadHashHex: string,
    options?: AbandonPollOptions,
  ): Promise<StoredMonadTopicPostProto | undefined> {
    const intervalMs = options?.intervalMs ?? 2000
    const maxAttempts = options?.maxAttempts ?? 5
    const sleep = options?.sleep ?? defaultSleep
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) await sleep(intervalMs)
      // A single poll attempt failing is not itself proof of abandonment -- only exhausting the
      // whole poll budget without ever finding the post is. See `monad-stamp-client.ts`'s
      // identically-shaped `pollForStoredMessage` for the same reasoning.
      const view = await this.fetchStoredTopicPostView(payloadHashHex).catch(
        () => undefined,
      )
      if (view?.post !== undefined) return view.post
    }
    return undefined
  }

  private async putTopicPost(
    post: MonadTopicPostProto,
  ): Promise<StoredMonadTopicPostProto> {
    const response = await axios({
      method: 'put',
      url: `${this.relayBaseUrl}/message/monad/topics`,
      data: encodeMonadTopicPost(post),
      // Content-Type must be exactly `application/x-protobuf` -- `cashweb_http_utils::protobuf::
      // Protobuf` (the extractor `handle_put_monad_topic_post` uses) rejects anything else with a 400,
      // the same bug ticket #8's e2e demo found and fixed for `monad_message.rs`; see
      // `monad-stamp-client.ts`'s header for the full story.
      headers: { 'Content-Type': 'application/x-protobuf' },
      responseType: 'arraybuffer',
    })
    return decodeStoredMonadTopicPost(new Uint8Array(response.data))
  }

  /**
   * Posts `params.topic`/`params.entries` (with `params.direction`/`params.voteWeightWei` as its
   * initial vote) to Monad end-to-end: builds the payload, computes its hash, builds the topic
   * calldata, leases a sub-account, builds+signs the burn tx, `PUT`s the assembled
   * `MonadTopicPost` to the relay, and releases the lease per this file's header's documented
   * policy. Throws {@link MonadTopicPostRejectedError} if the relay definitively rejected the
   * post, or {@link MonadTopicPostAbandonedError} if a network failure left the outcome unresolved
   * even after the fallback `GET` poll.
   */
  async submitTopicPost(
    params: SubmitTopicPostParams,
  ): Promise<SubmitTopicPostResult> {
    if (params.entries.length === 0) {
      throw new Error('entries must not be empty')
    }

    const parentPostHash = params.parentPostHash ?? new Uint8Array(0)
    const payload = buildTopicPostPayload({
      topic: params.topic,
      entries: params.entries,
      parentPostHash,
      timestampMs: params.timestampMs,
    })
    const payloadHash = computeTopicPostCommitment(payload)
    const calldata = buildTopicVoteCalldata(params.direction, payloadHash)
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
        params.voteWeightWei,
        calldata,
        params.overrides,
      )
    } catch (err) {
      // No transaction was ever broadcast, so the sub-account's nonce isn't actually at risk -- see
      // this file's header, "Lease release policy", for why this deliberately still retires rather
      // than guessing.
      this.leaseManager.releaseLease(handle, 'failed')
      throw err
    }

    const post: MonadTopicPostProto = {
      topic: params.topic,
      parentPostHash,
      rawBurnTx: getBytes(signedTx.rawTx),
      encryptedPayload: payload,
      payloadHash,
    }

    try {
      const stored = await this.putTopicPost(post)
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
        throw new MonadTopicPostRejectedError(
          `Relay rejected the Monad topic post (HTTP ${err.response.status})`,
          err.response.status,
          err.response.data,
        )
      }

      // No HTTP response at all: genuinely unknown whether the relay received/broadcast/stored the
      // post before the connection dropped. Fall back to polling the read side before giving up.
      const stored = await this.pollForStoredPost(
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
      throw new MonadTopicPostAbandonedError(
        'Monad topic post submission abandoned: no response from the relay, and ' +
          `GET /message/monad/topics/${payloadHashHex} never found a stored post`,
        payloadHashHex,
      )
    }
  }
}
