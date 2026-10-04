# #770 readiness audit — source only, proposed contract

Status NEEDS_SPECIFICATION / dependency blocked. This is a draft for coordinator review, not a READY declaration, implementation claim or financial activation. Requested strong; actual inherited harness. Audit base: frozen `1b46f08c6f8f3cf7ff2d24d4b8f371e003cdb5a5` in `/Users/shammah/repos/frank/.worktrees/forum-current-20261003`. #769 still needs exact integrated native/hosted gates and landing; eventual dispatch base must be full reviewed main after that landing and any agreed test-pinning predecessor. No claim/source edits/native/browser/install/tracker writes performed here. Artifact written only under /private/tmp.

Authority inspected: fresh saved #770 body `/private/tmp/frank-resume-770-current.json` (NEEDS_SPECIFICATION, no comments); accepted #769 body `/private/tmp/frank-resume-769-current.json`; implemented `docs/protocol/forum-runtime-storage.md`, `docs/protocol/cbor/topic-http-coexistence.md`; fresh read-only #60 and #258 body/comments saved `/private/tmp/frank-770-claim60-read.json` and `...claim258-read.json`. #797 later owns archival/export/disposition; no recovery activation inferred.

## Actual normal consumer and authority map

- `app/src/stores/forum.ts` and `app/src/stores/topics.ts` call `activeChain.topics.post/vote/fetchOne/fetchByTopic/discoverTopics`. Forum refresh currently `Promise.allSettled`s topic queries, merges successes into existing arrays, updates only old message tally, and has no request-generation guard. Topic refresh uses lastUpdate/time windows and similarly incrementally merges. Neither is a complete retained-snapshot publisher. Updating only tally also misses newly selected earliest author.
- `packages/wallet/chain/active-chain.ts::TopicBroadcastClient` currently returns `@frank/cashweb/types/forum::ForumMessage`, a number-backed `satoshis` model and number discovery counts/timestamps. Only Monad has topic capability; ecash/solana topic capability false. `monad-chain.ts::topics` constructs post/vote clients, fetches protobuf tally responses and uses `viewToForumMessage` to decode BroadcastMessage/ForumPost protobuf content.
- `packages/wallet/monad-topic-post-client.ts` defaults to protobuf. Its opt-in CBOR path builds schema1 type9 containing opaque BroadcastMessage bytes. It cannot become schema2 by flipping `topicWriteFormat`. It owns signing, exact durable request journal, lease admission and old transport-loss GET polling. Its success and replay lease releases need replacement by exact type15 matching.
- `packages/wallet/monad-topic-vote-client.ts` likewise defaults protobuf; opt-in CBOR accepts old-target 204, not canonical type15. Cannot flip vote independently from canonical target creation/read flow.
- `packages/wallet/monad-topic-tally-client.ts` reads only protobuf; discovery swallows errors into empty success. No retained-page traversal or bounded accumulation exists.
- `packages/frank-codec/src/forum.ts` already supplies public `encodeForumPost`, `matchForumOperation`, `matchForumView`, `matchForumPage`, cursor transport and exact parsed types. Matchers compare claims; they explicitly do not recover signatures, prove node facts/finality or change leases. Public facade is sufficient; no codec/private import/vector/protocol allocation prerequisite identified.
- `packages/wallet/storage/topic-operation-journal.ts`: immutable version1 rows retain exact requestBytes, rawTx, txHash, leaseIndex, senderAddress, decimal valueWei, direction and post target. Missing writeFormat means protobuf; explicit cbor is historical schema1 and cannot identify canonical vote family by itself.
- `packages/wallet/storage/monad-wallet-bundle.ts:227–234,267–274` counts ALL journal lease indices for orphan guards and compaction references. Restore opens journal without request codec/network calls. Therefore old immutable authority can remain retained without a protobuf decoder or active recovery transport.
- Only post/vote clients define `resumePendingOperations`; repository production search found no caller. Current implementations parse/replay old requests and settle/delete on responses. New canonical reconciliation must be wired deliberately; do not mistake these exported methods for an existing normal crash-resume flow.
- Wide UI consumers: ForumMessage/ForumPost components, TopicMessage, CreatePost, Forum and Topic pages, both stores, sorting and chain-amount helpers. Current vote queues/offerings and threshold conversion use numbers; hot/top ranking subtracts numbers. Forum store JSON persistence cannot serialize bigint directly. Legacy cashweb registry constructs old ForumMessage for the inactive Lotus boundary; changing that shared type would widen scope unnecessarily.
- `packages/bot/demo/smoke-checks.ts` is the actual normal demo Forum writer/readback and CORS checker. It constructs a narrow client with no coherent walletState/topic journal and decodes BroadcastMessage readback. Its existing fake-rpc already exposes from/to, blockNumber, transactionIndex, transaction hash/input/value. `packages/wallet/monad-e2e-demo.livecheck.ts` and `packages/bot/monad-ui-verify.livecheck.ts` do not implement normal Forum flows. The `topicWire:'protobuf'` print at demo.ts:724 belongs to separately owned directory-only mode, not this consumer; do not mutate directory demo/runtime to satisfy normal Forum cutover.
- #769 HTTP normal routes live in `backend/cashweb/cashweb-registry/src/http/monad_topics.rs`; `http/server.rs` already wires the correct static paths. Format dispatch and predecessor callbacks are inside the HTTP module. #770 can remove their public-handler reachability without changing server routing, DB CFs or deleting legacy records.

## Retention-only old-operation disposition is viable

Proposed finite default: keep every old version1 row and associated pool authority byte-identical, expose it as unsupported-retained, and skip it before decoder, transport, funding, lease status, journal delete or compaction effects. No old-operation decode/rebroadcast/reconciliation activation. No mapping an old request into type15. No implicit terminal-row deletion even when the pool already says spent/retired. New canonical operations use an explicit `writeFormat:'forum-cbor'` discriminator in the existing closed version1 journal map; existing absent/protobuf/cbor values stay accepted and unchanged. No root/version rewrite or old-record conversion. Classification depends solely on persisted discriminant, never body sniffing. Generic journal byte checks remain available without importing protobuf.

All normal new post/reply/read/list/discovery/vote/status code uses CBOR only. Remove normal protobuf encoders/decoders, format switches, schema1 writer and old response polling from post/vote/tally/chain modules. Backend normal handlers accept/serve canonical family only; remove predecessor selection/callbacks from those handlers while leaving all ordinary DB CFs/bytes and Forum sidecar untouched. Reject unsupported old request media/schema deterministically before admission/broadcast. Retained legacy journal records no longer target those routes. Any lingering generated/storage helpers have explicitly dead/historical ownership and separate deletion follow-up; do not broaden into deleting all protobuf/legacy-cashweb/DM dependencies.

This intentionally sacrifices automatic recovery availability for old operations while preserving every obligation. #797 needs separate explicit authority to export/reconcile/retire them. No outstanding financial policy decision is needed for this conservative retention proposal.

## Cohesive canonical implementation behavior

1. Post/reply: encode schema2 content via facade, preserve optional parent T1 exactly, derive T1/T7/T8 once, locally validate before funding/signing; type10 post's own vote is up and amount 1..i64::MAX. Positive/negative votes are type11 against canonical T1s. Never silently reinterpret an old digest as a new target.
2. Use existing wallet operation gate, durable journal and pool spend authority. Require coherent production walletState/journal; demo must use a coherent isolated wallet bundle rather than bypass persistence. Journal exact signed request synchronously before network send. Normal status POST sends exactly retained requestBytes, never a reconstructed frame.
3. A type15 state2 must match exact network/request/T1/hash/sender/direction/value and retained raw signed transaction, chain/destination/calldata/lease owner. State0/1/3, shape-only 2xx, mismatched bytes/facts, above-ceiling echoes, failed/missing receipts and transport/storage uncertainty cannot release/delete/settle an operation or authorize replacement spend. State3 is allocated but server769 does not emit it; do not build a new state3 rejection policy. Pre-sign failures retain existing terminal retirement semantics; a post-send failure does not manufacture prebroadcast rejection. Exact canonical replay can submit the SAME retained bytes, with no new signing/funding.
4. Confirmation remains the accepted successful exact receipt observation, with no depth/finalized/reorg policy invented. If independent provider observation is used before releasing a lease, check receipt hash/success/from/to/block/index (zero valid), corresponding exact transaction hash/from/to/value/input and signed chain facts; pin that stricter observation as part of the contract rather than claiming a codec matcher supplies it. Historical missing receipt cannot authorize a new spend or erase authority. Do not require a new economic/finality decision merely to preserve the existing relay-observed successful-receipt policy with exact local bindings.
5. Add a small narrow shared operation/status helper used by both post and vote clients; no new signer, database adapter, worker or general event bus. Wire canonical pending reconciliation under existing wallet admission before a normal paid topic action and provide normal status refresh for retained canonical operations. Legacy discriminator is checked first and produces unsupported-retained classification. Existing orphan/compaction protections remain.
6. Each list/discovery attempt fetches explicit application/cbor and accumulates all pages privately. Use facade matchForumPage plus identical epoch/revision/query; exact continuation request echo; retained incarnation identity in cursor; strict unsigned tuple ordering and cross-page uniqueness, advancing last tuple and cursor, and rows bound to queried topic/since. Reject changed/reordered/duplicate/missing-link pages and terminal inconsistencies. Never mix fresh first page with an old cursor. Views match page epoch/revision and derive T1 from exact nested post bytes. Zero next on terminal; no treating a missing/failed continuation as a complete prefix.
7. Bound each server response before/while body accumulation at128rows/4MiB and shared codec budgets, with2MiB view/2048byte cursor constraints. Local staging max32768rows/64MiB charged buffers+projection/bookkeeping and original120s monotonic attempt lifetime; fail before publication. At most initial attempt plus TWO fresh whole-snapshot retries for recoverable expiry/incarnation or consistency races; no partial reuse, sliding renewal, infinite retries or unbounded Promise.all allocations. Permanent malformed/context/oversize results fail closed, not empty success. Bound concurrent topic/discovery staging, including aggregate refresh memory, rather than multiplying64MiB by arbitrary topic count.
8. Publish only complete query snapshots in one store mutation/transaction, including rows/index/replies/author/tally/metadata. Scope currentness by query/network/wallet identity and refresh generation; delayed old requests cannot replace data, clear newer loading/error state, advance cursor or trigger payment. A refreshed exact topic should replace that query's snapshot, not preserve old rows as current through merge. Multi-topic UI has independent server snapshots; do not claim all topics share a global snapshot. Discovery failure must remain distinguishable from verified empty discovery and must not silently declare a complete global topic refresh.
9. Introduce wallet-specific canonical UI projection, retaining exact decimal-string signed voteWeightWei and unsigned count/revision, exact timestamp seconds/nanos and epoch/T1/author facts. Keep legacy cashweb ForumMessage read-only. Decimal strings are JSON-persistable; arithmetic/threshold/top-order/vote accumulation use bigint. Formatting uses existing exact base-unit functions. Any approximate hot-score ranking stays an explicitly derived ranking scalar, never overwrites displayed/stored amount; deterministic tie/order tests required. On restore, old app number-backed cache is identified as stale/unverified and excluded from current canonical snapshots; no deletion/reset of financial journals or unrelated stores. Posts/replies must update full observed author/content metadata, not only weight.

## Smallest proposed exact-file candidate scope

Paths below are finite draft scope, to be frozen by coordinator after contract review. Existing source names retained where possible. New narrow helpers are justified by two real post/vote callers and page-model seam. No package manifest/lock changes needed.

Wallet production (existing unless marked new):
- `packages/wallet/monad-topic-post-client.ts`
- `packages/wallet/monad-topic-vote-client.ts`
- `packages/wallet/monad-topic-tally-client.ts`
- `packages/wallet/monad-forum-operation.ts` (new: exact canonical authority/status/reconciliation checks)
- `packages/wallet/forum-model.ts` (new: canonical observation projection/types, decimal-string persisted amounts; not generic adapters)
- `packages/wallet/storage/topic-operation-journal.ts` (new discriminant only, immutable old rows retained)
- `packages/wallet/monad-wallet-handle.ts` (remove normal format switch, preserve all unrelated fields)
- `packages/wallet/chain/active-chain.ts` (topic-only model/status seam)
- `packages/wallet/chain/monad-chain.ts` (topic-only composition, projection, canonical pending callsites; DM/account/transport byte-preserved)
Wallet tests:
- `packages/wallet/monad-topic-post-client.jest.test.ts`
- `packages/wallet/monad-topic-vote-client.jest.test.ts`
- `packages/wallet/monad-topic-tally-client.jest.test.ts`
- `packages/wallet/monad-forum-operation.jest.test.ts` (new)
- `packages/wallet/forum-model.jest.test.ts` (new)
- `packages/wallet/storage/topic-operation-journal.jest.test.ts` (new)
- `packages/wallet/storage/monad-wallet-bundle.jest.test.ts` (retention/orphan/compaction proof only; no bundle production change)
- `packages/wallet/chain/monad-chain.jest.test.ts`
- `packages/wallet/chain/monad-chain-topic-burn.jest.test.ts`
- `packages/wallet/chain/active-chain.jest.test.ts` (topic fixture/type changes only)
App production:
- `app/src/stores/forum.ts`
- `app/src/stores/topics.ts`
- `app/src/pages/CreatePost.vue`
- `app/src/pages/Forum.vue`
- `app/src/pages/Topic.vue`
- `app/src/components/forum/ForumMessage.vue`
- `app/src/components/forum/ForumPost.vue`
- `app/src/components/topic/TopicMessage.vue`
- `app/src/utils/chain-amount.ts` (Forum-facing helpers only)
- `app/src/utils/sorting.ts`
App tests:
- `app/src/stores/forum.jest.test.ts`
- `app/src/stores/topics.jest.test.ts`
- `app/src/pages/CreatePost.jest.test.ts`
- `app/src/pages/CreatePost.pinia.jest.test.ts`
- `app/src/components/forum/ForumMessage.vote.jest.test.ts`
- `app/src/utils/chain-amount.jest.test.ts`
- `app/src/utils/sorting.jest.test.ts`
- `app/test/forum-browser.mjs` (new: real rendered Forum/Post/CreatePost flow with intercepted canonical wire and isolated fixtures; follow existing browser launcher lifecycle without touching account custody harness)
Demo production/tests/docs:
- `packages/bot/demo/smoke-checks.ts` (only topic smoke/CORS/coherent topic wallet fixtures)
- `packages/bot/demo/smoke-checks.jest.test.ts`
- `packages/bot/demo/smoke.jest.test.ts` (topic result fixture changes only)
- `packages/bot/demo/README.md` (normal Forum wire/proof text only)
Backend:
- `backend/cashweb/cashweb-registry/src/http/monad_topics.rs` (canonical-only normal handlers and route tests; predecessor public-handler removal, no storage destruction)
Docs:
- `docs/protocol/cbor/topic-http-coexistence.md` (normal cutover and retention-only obligations; no active recovery claims)
- `docs/protocol/forum-runtime-storage.md` (server lifecycle unchanged, update client status/removal ownership)
- `docs/CASHWEB-PROTOCOL-SPEC.md` (narrow implemented client stage/normal protobuf reachability/remnant ownership link)

Forbidden: codec source/corpus/vector/pin regeneration; generated protobuf deletion or manifests; financial journals/root migration; wallet pool/lease/change/funding/native-attempt/DM production; accounts/custody; directory files/demo.mode; held258 envelope/crypto/CBC activation; ordinary DB/CF/store deletion/reset; real funds/credentials/network deployment. If a currently unlisted test fixture needs a mechanical type change, name exact path and obtain finite coordinator addition before editing; do not infer scope by extension.

## Required predecessors / ownership

- HARD dependency: independently reviewed, fully gated #769 landing and exact-main dispatch base. Current source seam is adequate; no codec prerequisite found.
- REQUIRED finite claim carve-out before any mutation: fresh #60 claims1e8cb948/d4a0f6b8 and held25891fe63c4 still reserve surrounding wallet work. Narrow release only canonical topic additions/removal, new journal discriminant, named topic test changes in monad-chain.ts/active-chain.ts/monad-wallet-handle.ts/topic journal and bundle-test characterization; preserve all DM/account/transport/envelope logic and historical artifacts. #60 CLOSED does not release a claim. Fresh #60 comment5976558205/#2585976558355 release only #776 C0 tests, not #770. Coordinator must record this exact new carve-out; no unresolved product design issue is implied.
- Recommended independently reviewable TEST-PINNING predecessor: unchanged production `storage/monad-wallet-bundle.jest.test.ts` plus new `storage/topic-operation-journal.jest.test.ts`, proving absent-format/protobuf/schema1-cbor rows survive real Level reopen unchanged, reference leases against orphan/compaction, and cannot be silently replaced. This pins preservation before cutting off old runtime routes. It can be a separate test-only landing; no behavior/refactor required. It is not permission to activate old replay.
- No independently required production refactor identified. A vote-only flip or a protobuf extraction/recovery service would be unsafe/wasteful predecessors. Implement canonical post/reply/read/list/discovery/vote/status and retention-only old classification in one cohesive candidate. If scale requires stacking, each intermediate must remain normal-protobuf until whole canonical flow is reviewed, or explicitly be a nonactivated helper/test layer; never activate partial vote-only migration.

## Acceptance proof and gates

Economic/retention: actual LevelDB restart with mixed missing/protobuf/cbor/forum-cbor rows; compare exact serialized old rows and pool lease lifecycle before/after status/normal action/new spend/compaction. Assert zero old decoder/network/funding/sign/release/delete invocations. Crash cuts before journal, after durable journal, after send, before/after lease flush and journal delete; pending resumes SAME signed bytes; wrong operation/T1/sender/value/network/hash/chain/destination/calldata/block/index/state mismatch never settles. Different burn same post cannot borrow another author observation. Two concurrent new/replay calls consume once under wallet admission. Missing/reverted/mismatched provider receipt never settles; later missing historical evidence never resets/releases/replaces. Abovei64/max/zero/down-post fail before funding/sign/send.

Paging debt5: deterministic actual client HTTP traversal of both type13/14 families >128rows and4MiB boundaries; exact query/cursor echo/inclusive signedms conversion; duplicate/reordered/empty-with-next/nonadvancing/missing/forged/crossquery/epoch/revision rows; true PAG1 expired-oldcursor→samequery/revision freshincarnation rejection; at most two bounded fresh retries; all32768row/64MiB/120s thresholds with monotonic fake clock and charged memory; staging discarded on failure and no partial prefix publication; bounded concurrent multi-topic staging. Real Pinia/UI delayed old fetch→new generation publication and old finally/result cannot mutate; wallet/route/topic changes invalidate; full author/tally replacement and persisted old cache exclusion. Shared codec conformance is not a substitute for these client proofs.

UI/browser/smoke: real rendered CreatePost→Forum list→single post→reply→positive/negative vote→status, exact CBOR Content-Type/Accept and type9schema2/10/11/12/13/14/15 wire assertions; no protobuf/BroadcastMessage imports in normal client bundle. Wide positive/negative256bit observation, u64count/revision and maximum admitted amount display/threshold/top sort remain exact; no BigInt JSON persistence failure. Zeroed aggregate formats correctly. Demo check reuses actual normal canonical clients/coherent isolated wallet authority, verifies exact title/body/parent/T1 and both votes/status, not mock-only encoder roundtrip. Synthetic signed transactions and localhost mockRPC only; browser fixture isolated and teardown proven; no real paid demo/credentials implied.

Gates: scoped wallet/chain/storage/Jest + app stores/component/rendered tests + bot topic smoke tests; codec public facade regression unchanged; applicable TypeScript builds/typechecks/app production build; scoped backend topic/actual-router tests/rustfmt/clippy/build; runtime import/reachability audit for old normal protobuf/schema1 writers/readers/format switches and generated remnant owner; full affected financial lifecycle tests only when justified by shared topic edits; final integrated hosted CI. Serialize native/browser under coordinator heavy lease and disk guard. Do not claim unexecuted browser/native/CI. Independent security/economic/persistence/paging/modelshape/testquality review exact final SHA; separate verification of findings.

## Remaining real decisions

No new wire allocation, destructive reset, finality depth, old-obligation retirement or legacy-recovery activation is needed for the retention-only proposal. Coordinator must accept exact scope, choose/freeze test-pinning predecessor and publish finite historical-claim carve-out, then wait for #769 gates/landing. If stronger independent chain finality than existing successful exact-receipt observation is desired, that is a separately pinned economic policy and prerequisite; do not invent it in #770. App scalar hot-score implementation and helper naming are routine bounded implementation choices, not user permission blockers.

Handoff required: exact base/tip/files/claim; normal consumer reachability map; old authority retained/noactive-recovery proof; economic exact-match and pending crash matrix; debt5 lifecycle/bounds/generation matrix; real rendered and demo wire evidence; requested strong/actual model; skipped gates/baseline failures; historical generated/legacy removal follow-up ownership; next integration action. No premature READY or completion claim.
