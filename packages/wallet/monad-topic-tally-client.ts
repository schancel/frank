/**
 * Client-side read/tally functions for Monad topic posts (ticket #33): fetch every post under a
 * topic, and fetch a single post by its `payload_hash` -- each response already carries the
 * relay's own tallied `vote_weight`. Also home to [`fetchDiscoveredTopics`] (ticket #72), the
 * client for the relay's topic-discovery index (`GET /message/monad/topics/discover`) -- grouped
 * here rather than a new file since it hits the same `/message/monad/topics*` route family and
 * decodes the same `topic_message_pb` bindings as the rest of this file.
 *
 * This is the last piece of the topic-broadcast feature (#26/#30/#31/#32/#40, see `PLAN.md`'s M8
 * section): the Lotus reference this mirrors, `app/src/cashweb/registry/index.ts`'s
 * `getBroadcastMessages`/`getBroadcastMessage`, has to *derive* each message's vote weight
 * client-side from its attached burn transactions (`calculateBurnAmount`, summing up-votes minus
 * down-votes) because Lotus's registry never verifies vote burns itself. On Monad, every vote
 * (a post's own initial vote, or a later `MonadTopicVote`) is verified and tallied server-side
 * before it's ever stored (`process_monad_topic_post`/`process_monad_topic_vote`,
 * `http/monad_topics.rs`) -- so this file's job is much simpler than its Lotus counterpart: decode
 * the wire response and hand back the weight the relay already computed, never re-derive it from
 * raw burn txs (this client never even sees the burn txs behind votes it didn't cast itself).
 *
 * ## Which files this mirrors, and why
 *
 * - The list half (`fetchMonadTopicPostsSince`) is structurally `monad-message-feed.ts` (ticket
 *   #37's `GET /message/monad?since=` client) with `topic` added as a required query param and
 *   `MonadTopicPostViews`/`MonadTopicPostView` swapped in for `StoredMonadMessages`/
 *   `StoredMonadMessage` -- including that file's own decode-inline-rather-than-import-a-decoder
 *   style (it imports only the *type* `StoredMonadMessageProto` from `monad-stamp-client.ts`, not
 *   a decode function), which this file follows for the same reason: a `list` response's elements
 *   arrive as already-parsed nested `jspb.Message` instances (`MonadTopicPostViews.getViewsList()`
 *   returns `MonadTopicPostView[]`, not raw bytes each), so there's no `bytes -> decoded` function
 *   to reuse from a bytes-only decoder anyway.
 * - The single-fetch half (`fetchMonadTopicPostView`) mirrors `monad-topic-post-client.ts`'s
 *   private `fetchStoredTopicPostView`/`pollForStoredPost` machinery, which already hits this same
 *   `GET /message/monad/topics/:payload_hash` route -- but purely as ticket #31's own internal
 *   network-failure disambiguation poll (`MonadTopicPostClient.submitTopicPost`'s "no HTTP
 *   response at all" fallback), never exposed as a general read API. This ticket's own task
 *   description calls that out explicitly: write a fresh, public-facing version here rather than
 *   exporting or reusing that private one, since its home file's contract belongs entirely to
 *   ticket #31's post-submission flow, not to general topic reading. This file's
 *   `fetchMonadTopicPostView` and that file's `fetchStoredTopicPostView` end up structurally
 *   similar (same route, same decode shape, same 404-means-"not found" convention) by necessity of
 *   decoding the same wire response, not by importing one from the other.
 *
 * Both functions import only the *types* `MonadTopicPostViewProto`/`StoredMonadTopicPostProto`/
 * `MonadTopicPostProto` from `./monad-topic-post-client` (already defined there for ticket #31),
 * so callers get one consistent plain-object shape for a topic-post view regardless of which
 * client function produced it -- without this file needing to touch that ticket's file at all.
 *
 * ## Route contract (read directly from the Rust source, not assumed)
 *
 * - `GET /message/monad/topics?topic=<topic>&since=<timestamp>`
 *   (`handle_list_monad_topic_posts`, `backend/cashweb/cashweb-registry/src/http/
 *   monad_topics.rs`): its `ListMonadTopicPostsQuery` struct declares `topic: String` (no
 *   `Option`) -- a **required** query param, unlike `since`. Its own doc comment explains why:
 *   "there's no meaningful 'every topic' default the way `GET /message/monad?since=` has one
 *   global feed; topic posts are always browsed per-topic." `since: Option<i64>` defaults to `0`
 *   server-side when omitted (every stored post under `topic`). No gate/auth check at all --
 *   `handle_list_monad_topic_posts` never touches `monad_topic_gate()`, unlike the `PUT` handlers
 *   in the same file. Response body: a serialized `MonadTopicPostViews { repeated
 *   MonadTopicPostView views = 1; }`.
 * - `GET /message/monad/topics/:payload_hash` (`handle_get_monad_topic_post`, same file):
 *   `:payload_hash` is decoded via plain `hex::decode` (the Rust `hex` crate, no `0x`-prefix
 *   handling) -- the path segment must be bare hex, matching every other client in this directory
 *   that builds this same style of URL (`monad-stamp-client.ts`/`monad-topic-post-client.ts`'s own
 *   `toBareHex` helpers). No gate/auth check here either. Response body: a serialized
 *   `MonadTopicPostView { post: StoredMonadTopicPost, vote_weight: sint64 }`. 404 (empty body) if
 *   no post is stored under that hash (`GetMonadTopicPostError::NotFound`).
 *
 * ## Ordering / cursor semantics (read directly from `store/monad_topics.rs`, not assumed)
 *
 * `DbMonadTopicPosts::list_by_topic(topic, since)` scans a secondary index keyed by
 * `SHA256(topic) ++ timestamp.to_be_bytes() ++ payload_hash`, starting from `since`'s encoded key
 * and stopping once the topic-digest prefix no longer matches. Consequences a caller can rely on:
 *
 * - Ordered by `timestamp` ascending (oldest first) -- **not** insertion order, and not reverse-
 *   chronological the way a typical "feed" UI might expect; a caller wanting newest-first must
 *   sort client-side.
 * - `since` is **inclusive** (`timestamp >= since`, matching `ListMonadTopicPostsQuery::since`'s
 *   own doc comment) -- polling again with `since` set to the last-seen post's own `timestamp`
 *   would re-fetch that same post; callers that want to avoid re-processing it should poll with
 *   `since = lastSeenTimestamp + 1`.
 * - The topic filter hashes `topic` (`SHA256`) rather than using it as a raw prefix, specifically
 *   so one topic can never be a false-positive prefix match for another (`store/monad_topics.rs`'s
 *   own module docs: `"topic.one"` vs. `"topic.one.sub"`) -- this file's `topic` param is always
 *   matched exactly, never as a prefix.
 */
import axios from 'axios'

import __pb_topic_message_pb from './topic_message_pb'
const { MonadTopicPostView, MonadTopicPostViews, ListTopicsResponse } =
  __pb_topic_message_pb
import {
  MonadTopicPostProto,
  MonadTopicPostViewProto,
  StoredMonadTopicPostProto,
} from './monad-topic-post-client'

/** Decode a single, already-parsed `MonadTopicPostView` protobuf message (as returned by both
 * `MonadTopicPostView.deserializeBinary` and `MonadTopicPostViews.getViewsList()`'s elements) into
 * a {@link MonadTopicPostViewProto}. Field-for-field mirror of
 * `monad-topic-post-client.ts`'s private (unexported) `decodeStoredMonadTopicPostPb`/
 * `decodeMonadTopicPostView` -- written fresh here rather than imported, per this ticket's own
 * task description (see this file's header). */
function decodeMonadTopicPostViewPb(
  pb: InstanceType<typeof MonadTopicPostView>,
): MonadTopicPostViewProto {
  const storedPb = pb.getPost()
  let post: StoredMonadTopicPostProto | undefined
  if (storedPb) {
    const nested = storedPb.getPost()
    const nestedPost: MonadTopicPostProto | undefined = nested
      ? {
          topic: nested.getTopic(),
          parentPostHash: nested.getParentPostHash_asU8(),
          rawBurnTx: nested.getRawBurnTx_asU8(),
          encryptedPayload: nested.getEncryptedPayload_asU8(),
          payloadHash: nested.getPayloadHash_asU8(),
        }
      : undefined
    post = {
      post: nestedPost,
      senderAddress: storedPb.getSenderAddress_asU8(),
      txHash: storedPb.getTxHash_asU8(),
      timestamp: storedPb.getTimestamp(),
      networkTag: storedPb.getNetworkTag_asU8(),
    }
  }
  return {
    post,
    voteWeight: pb.getVoteWeight(),
  }
}

/** `GET /message/monad/topics?topic=<topic>&since=<sinceMs>`: every stored `MonadTopicPostView`
 * under `topic` at or after `sinceMs` (milliseconds since the Unix epoch; omit for every stored
 * post under `topic`), ordered by `timestamp` ascending -- the server's own contract, see this
 * file's header. Each returned view already carries the relay's tallied `voteWeight`; this
 * function never sums vote entries itself. */
export async function fetchMonadTopicPostsSince(params: {
  relayBaseUrl: string
  topic: string
  sinceMs?: number
}): Promise<MonadTopicPostViewProto[]> {
  const response = await axios({
    method: 'get',
    url: `${params.relayBaseUrl.replace(/\/+$/, '')}/message/monad/topics`,
    params: { topic: params.topic, since: params.sinceMs },
    responseType: 'arraybuffer',
  })
  const decoded = MonadTopicPostViews.deserializeBinary(
    new Uint8Array(response.data),
  )
  return decoded.getViewsList().map(decodeMonadTopicPostViewPb)
}

/** `GET /message/monad/topics/:payload_hash`: the stored `MonadTopicPostView` for a single post,
 * identified by its bare-hex (no `0x` prefix) `payload_hash` -- mirrors Lotus's
 * `getBroadcastMessage` (see this file's header). Returns `undefined` on a `404` (no post stored
 * under that hash); any other non-2xx response, or a network-level failure, propagates as a thrown
 * error (same 404-vs-everything-else convention `monad-topic-post-client.ts`'s own
 * `fetchStoredTopicPostView` uses for this same route). */
export async function fetchMonadTopicPostView(params: {
  relayBaseUrl: string
  payloadHashHex: string
}): Promise<MonadTopicPostViewProto | undefined> {
  try {
    const response = await axios({
      method: 'get',
      url: `${params.relayBaseUrl.replace(/\/+$/, '')}/message/monad/topics/${
        params.payloadHashHex
      }`,
      responseType: 'arraybuffer',
    })
    return decodeMonadTopicPostViewPb(
      MonadTopicPostView.deserializeBinary(new Uint8Array(response.data)),
    )
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      return undefined
    }
    throw err
  }
}

/** A single discovered topic, as returned by [`fetchDiscoveredTopics`] -- decoded from a
 * `TopicDiscoveryEntry` (ticket #72). */
export type DiscoveredTopic = {
  topic: string
  postCount: number
  lastActivityMs: number
}

/** `GET /message/monad/topics/discover` (ticket #72): every distinct topic name the relay has
 * stored at least one post for, each paired with its post count and last-activity timestamp,
 * ordered by `lastActivityMs` descending -- the server's own contract
 * (`handle_list_topics`/`ListTopicsResponse`, `backend/cashweb/cashweb-registry/src/http/
 * monad_topics.rs`).
 *
 * Per the design decision recorded on GitHub issue #72, topics stay emergent/tag-based: there is
 * no separate topic-registration flow, and no separate anti-spam gate for a topic name showing up
 * here -- a topic post already requires a real burn transaction to store, so this endpoint is
 * simply exposing the relay's own bookkeeping of topic names it has observed a post for. No
 * `since`/pagination parameter -- the route returns everything (see the Rust handler's own docs
 * for why: a small keyspace, not something that needs pagination yet).
 *
 * Fail-soft: unlike [`fetchMonadTopicPostView`]/[`fetchMonadTopicPostsSince`] above (which throw
 * on anything but a 404), this swallows *any* failure (network error, non-2xx response, or a
 * malformed/undecodable response body) and returns `[]`, logging the failure via `console.error`.
 * This mirrors ticket #49's `fetchCuratedDefaultContacts` (`monad-identity.ts`) fail-soft
 * convention: discovery is purely additive on top of `app/src/stores/topics.ts`'s hardcoded
 * `defaultTopics` fallback, so a broken/unreachable relay should degrade to "just the defaults",
 * not break the Forum page. */
export async function fetchDiscoveredTopics(params: {
  relayBaseUrl: string
}): Promise<DiscoveredTopic[]> {
  try {
    const response = await axios({
      method: 'get',
      url: `${params.relayBaseUrl.replace(
        /\/+$/,
        '',
      )}/message/monad/topics/discover`,
      responseType: 'arraybuffer',
    })
    const decoded = ListTopicsResponse.deserializeBinary(
      new Uint8Array(response.data),
    )
    return decoded.getEntriesList().map(entry => ({
      topic: entry.getTopic(),
      postCount: entry.getPostCount(),
      lastActivityMs: entry.getLastActivityMs(),
    }))
  } catch (err) {
    console.error(
      'monad-topic-tally-client: failed to fetch discovered topics',
      err,
    )
    return []
  }
}
