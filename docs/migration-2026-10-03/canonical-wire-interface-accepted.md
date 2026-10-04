# #777 canonical R/T wire-interface freeze — concrete proposal for acceptance

Prepared read-only from final private owner `eb027f88136131fe5283dd81754bc7fb6fd2fcf6`, reviewed main `9885b07dfac5c2725ce9296320df1b2175d226b8`, fresh #777 body/comments, and `/private/tmp/frank-777-canonical-feature-dispatch.md`. Coordinated wallet constraints with `/root/review_financial_c0`. No source, claim, test, install, activation or tracker mutation. PR822 landing/claim completion and finite canonical financial authority remain dispatch prerequisites. Names below are ordinary HTTP/API runtime values, not new FRNK allocations, signatures or crypto domains.

## 1. Exact submission and comparator

Freeze the accepted PUT route `/message/monad/cbor`, `multipart/form-data`, ordered exactly `delivery`, `context`, `transactions` with the contract's three media types. Transactions is existing deterministic CBOR array of1..64 raw byte strings, each<=128KiB, in exact type1 member order. Context<=4096bytes, whole body INCLUDING framing<=8MiB. Exactly one of each part, no filename, content-transfer encoding, extra/duplicate part, preamble, epilogue or bytes after closing boundary. CRLF framing; require final `--boundary--\r\n` and EOF. Freeze complete body bytes and exact Content-Type before first effect; retry encoder never invokes FormData or generates a new boundary. Generated boundary is at most70 ASCII characters, chosen once with no delimiter collision in any exact part; headers per part are at most4096bytes, with bounded name/media-type vocabulary. All framing/header charges count toward8MiB.

Ordinary `submission_identity` = lowercase hex SHA256 of deterministic-CBOR `[delivery_bytes, context_bytes, [raw_tx_bytes_in_order]]`. It is an index, never authority or a substitute for a full comparison. Use existing generic canonical encoder and SHA256; introduce no protocol transcript/domain. Multipart boundary is excluded from this semantic index but remains part of exact frozen request equality.

Server row lookup comparator checks byte-equality of delivery, context, EACH raw transaction/order/count, original entire multipart body, Content-Type boundary, network, recipient P identity, sender/recipient admitted T1 references and frozen economic policy. Same index with any differing immutable field is409 `canonical_submission_conflict`, with zero replay/broadcast. Policy comparison uses the row's original admitted policy on retries, rather than adopting later live minimum/key/config; later config is not a false conflict. The exact body/boundary check deliberately rejects a rebuilt multipart body even if it contains the same semantic parts. Two authorized relays receive the same frozen request; each independently retains that request under its installed network/policy.

Keep distinct identifiers:
- Prepared identity: exact B payload/context plus wallet account/network/sender+recipient T1 binding; lookup before reservation/signing. B result alone is not a transport request.
- Submission identity: complete delivery/context/ordered raw transaction tuple above.
- Recovery `payload_hash`: canonical existing T3 recipient-payload digest from type1 field3, computed by existing `recipient_payload_digest(network, exact_type5_frame)`; NOT submission_identity and NOT legacy SHA256(opaque protobuf payload).
- `obligation_id`: existing32byte immutable generation semantics; never regenerated merely by querying.
- Workflow outcome acknowledgement: wallet attempt ref+consumer identity, distinct from recipient sweep/recovery HTTP acknowledgement.

Server owner key should bind `(network, recipient P identity, T3)` to one retained exact submission. An alternate signed set for the same prepared envelope is a conflict, not another financial attempt. Collision/index handling always reaches the complete comparator.

## 2. Ordinary accepted response and status

No new status route is needed for R/T start. Repeated exact PUT is the idempotent status/reconciliation operation. It may charge an existing replay only through the same outbox scheduling/lease policy; receipt polling/replay remain explicit wallet start after restart correlation. A future effect-free lookup route is not silently authorized by this freeze.

Content-Type `application/json`; response body<=16KiB, no provider/raw diagnostic blobs. Exact version1 objects:

```ts
interface CanonicalSubmissionEcho {
  submission_identity: string       //64 lowercase hex, ordinary index
  payload_hash: string              //64 lowercase hex, existing T3
  network: string
  recipient: string                 //0x+40 lowercase hex P address
  sender_t1: string                 //64 lowercase hex, exact context ref
  recipient_t1: string              //64 lowercase hex, exact context ref
  delivery_sha256: string           //64 lowercase hex of exact delivery bytes
  context_sha256: string            //64 lowercase hex of exact context bytes
  transaction_hashes: readonly string[] //0x+64lowercase Keccak(raw), exact order
}
type CanonicalAcceptedBody =
  | { version: 1; phase: 'retained'; identity: CanonicalSubmissionEcho }
  | { version: 1; phase: 'delivered'; identity: CanonicalSubmissionEcho;
      mailbox_committed_at_ms: number }
  | { version: 1; phase: 'dead'; identity: CanonicalSubmissionEcho;
      reason: CanonicalTerminalReason }
type CanonicalTerminalReason =
  | 'stale_nonce' | 'verification_failed' | 'broadcast_rejected'
  | 'corrupt_reference' | 'insufficient_total' | 'expired' | 'attempts_exhausted'
```

HTTP202 retained means exact request/frozen ownership durably retained, NOT mailbox delivery. HTTP200 delivered is emitted only after durable atomic canonical inbox publication+terminal economic transfer; timestamp is an integer safe milliseconds value from that publication, not transaction block time. HTTP200 dead is emitted only for a matching durable existing terminal decision under current policy; listed vocabulary does not create new terminal transitions (notably nonce advancement without a proven competing identity remains pending).

T decodes a small strict object, exact known version/phase, requires every echo field equal to its frozen request's computed descriptor, safe timestamp, no duplicate JSON member keys and bounded transaction count. Wrong status/phase, extra terminal fields, missing/malformed/mismatched identity, redirect, stale reply, echo-only200, receipt-only200, invalid body, network abort or interrupted send becomes `uncertain` locally: retained journal/leases survive, never delivered/dead or fresh payment. Remote `uncertain` is not a persisted terminal phase. Nonterminal errors use bounded `{version:1,error:<fixedcode>}` without an accepted identity and never clear the attempt.

Pre-retention classifications:400 invalid canonical shape/order/context/directory/raw financial binding;413 byte/cardinality limits;409 `canonical_directory_predecessor_missing` or `canonical_submission_conflict`;429 capacity with bounded Retry-After;503 unavailable/retryable. Missing predecessor fails before RPC. No response to a conflict may report another owner's accepted identity as acceptance of this request. T preserves exact request for retries; it neither selects/signs transactions nor creates durable wallet outcomes. Wallet independently rechecks echo and commits terminal result before live cleanup.

A matching small response is trusted relay transport evidence of audited durable publication, not cryptographic proof of chain finality. Server's full-byte comparator is mandatory; hashes in the response alone are not that comparator.

## 3. Bounded canonical private inbox framing

Fixed routes under `/message/monad/cbor`: POST `/auth/:recipient`; GET `/inbox/:recipient`; GET `/recovery/:recipient`; POST `/recovery/:recipient/:payload_hash/:obligation_id/ack`. No unauthenticated global/exact GET or legacy decode fallback.

Inbox response: `multipart/mixed; boundary=<server-boundary>`, max100records and8MiB COMPLETE wire page. Each outer part is named `record`, Content-Type `multipart/mixed; boundary=<record-boundary>`, with bounded headers `X-Frank-Submission-Identity` (64lowerhex) and `X-Frank-Mailbox-Timestamp-Ms` (safe decimal integer). Each record contains exactly two ordered parts: `delivery` application/vnd.frank.cbor and `context` application/cbor; original byte-exact stored values, no protobuf projection. EOF follows final closing boundary; no extras/trailing data. Empty inbox is a valid closed multipart body with zero record parts. Next cursor is only the existing `x-frank-mailbox-next-cursor` opaque header; no synthetic checkpoint/type3 fact. Query defaults:limit50,max_bytes8MiB,since0; limit1..100,max_bytes1..8MiB, signed exactly. A record that cannot fit the caller's requested page budget returns explicit413 `mailbox_record_exceeds_page_budget` rather than being skipped. Budget includes nested multipart headers/boundaries and cursor header size in total accounting.

T consumes a bounded body stream, aborting at actual byte count>budget regardless of Content-Length; allocation/staging/header/part-count limits enforced incrementally. The existing Axios ArrayBuffer default is not a bounded streaming proof. Canonical functions may use a bounded fetch/stream adapter in the already-owned mailbox client; caller test hooks must retain real-byte caps. Stage only complete valid records; truncated/malformed page is protocol uncertainty, no partial cursor advancement. Only page APIs are frozen now: any multi-page collector must take finite aggregate record/byte bounds and account across pages.

Inbox record identity header is relay index metadata. A delivery/context pair alone cannot recompute submission_identity, because raw signed transactions are not in the inbox. For a locally known outgoing request compare its exact pair and stored index; for a new recipient record, public B opening validates actual context/admitted history/payload, but does not manufacture a full submission identity or chain receipt. This read format does not claim recipient-side payment verification from absent raw bytes.

## 4. Canonical recovery and acknowledgement framing

Use the same bounded multipart page, defaults20records, limits1..100/8MiB; recovery since is0. Each record contains ordered `delivery`, `context`, `transactions` (original accepted values) and fourth `recovery` application/json metadata<=16KiB:
`{version:1, submission_identity, payload_hash, obligation_id, confirmed_children:[indices], lifecycle}`.
Lifecycle preserves current pending/fully_confirmed/delivered/terminal:<existingreason> meaning. Confirmed indices are unique, ordered and within the exact raw/member list; no caller-supplied value or new sweep authority. Original exact context contains canonical stamp proof/provenance; no legacy canonicalMessage protobuf conversion. Complete record/frame/context/raw identities must validate before durable sweep import. If policy/provenance beyond these existing fields proves required by real recovery consumer, return exact finite interface amendment instead of silently adding authority.

Ack signs existing RecoveryAck resource with T3 payload_hash and obligation_id32, same resource semantics. Request body empty.200 `{version:1,acknowledged:true,payload_hash,obligation_id}` only after durable same-recipient exact-obligation transition; foreign/stale/active obligation cannot be retired. Workflow result acknowledgement is a separate wallet operation. Existing sweep import-before-ack rule and confirmed-prefix retention remain unchanged.

## 5. Authentication isolation and actual missing facade

Retain EXACT existing P signature preimage/domain/resource tags/logical `/message/monad/{inbox|recovery|recovery-ack}` strings. These are fixed in Rust MailboxRequestBinding::append_canonical and TS buildMailboxAuthPreimage; rewriting them to `/cbor` would allocate a different transcript and is not this proposal. Canonical functions choose canonical URL namespace while using that frozen logical transcript.

Add one separate canonical MailboxAuthState (random epoch32+secret32), challenge/token/cursor issuer/verifier inside the existing EnabledMonadMailboxRuntime. Share its ORIGINAL transport,reconcile,financial permit pool and private-read budget; do not instantiate a second enabled runtime or broadcaster. Canonical state only issues/verifies canonical challenges/cursors; legacy state only handles legacy. Wrong epoch/MAC rejects before signer work/read. Both signers use existing mailbox challenge JSON/header fields with the same domain and resource vocabulary. Consumption remains epoch+recipient+nonce single-use with existing bounded capacity/lifetime, durable in the canonical sidecar namespace rather than making canonical records an eager legacy schema dependency. A successfully P-authenticated canonical request MAY lazily initialize an auth-only sidecar to durably consume its nonce; invalid/unauthenticated requests and ordinary unauthenticated reads may not create it. Stateless challenge issuance does not create storage, and absent sidecar never permits skipping nonce consumption. Prove cross-route challenge/cursor rejection both directions, restart invalidation and correct canonical fresh-challenge retry.

Concrete source blocker: existing P parsing/preimage/authentication helpers in http/monad_message.rs are private, tied to `server.monad_mailbox`'s legacy auth and Registry's registered-profile key lookup. This file is NOT owned by canonical C list. New canonical HTTP sibling cannot call those helpers directly. Propose finite amendment of this file only to expose/extract a shared crate-private authentication facade parameterized by the existing runtime's namespace auth view, key verification/challenge consumption owner; keep legacy route behavior/preflight/error precedence/tests unchanged. No copied ad-hoc signature parser/verifier in new canonical handler.

Coordinator resolved canonical P authority: use actual fresh admitted Directory Current, NOT the legacy profile database or a profile writer. Freeze canonical-only header `x-frank-mailbox-subject`: exactly66 lowercase hex bytes encoding a compressed33byte P public point (02/03 prefix), on challenge and signed read/ack requests. It is a public locator hint, not authority. Validate bounded point shape, derive its ordinary EVM address and require equality to :recipient; reserve the actual installed directory key for the configured canonical network and that full compressed point; obtain genuine fresh Current through the typed facade below; require its admitted subject/key/network/address match. Missing/not-current/forked/expired/wrong subject takes uniform401 after the same dummy-key strict ECC work; preserve old error/probing behavior. P alone signs; M/P-prime never substitute.

Canonical network uses the EXISTING authoritative `MonadNetworkDescriptor`: `monad_network(runtime.network_tag())` / `cbor_network_identifier(runtime.network_tag())`, never UTF-8 reinterpretation or an invented alias. Actual reviewed mapping is MONT -> monad-testnet / chain10143 and MON1 -> monad-mainnet / chain143. Require descriptor.evm_chain_id == runtime.expected_chain_id(), every signed raw member's chain, and frame/context/Directory Current network == descriptor.cbor_identifier; mismatch fails before financial effects. Daemon currently accepts only MONT/MON1 and rejects a canonical string as its configured tag, so no startup/config scope addition or replacement tag is proposed.

Canonical challenge's existing `network_tag` field retains EXACT runtime MONT/MON1 bytes covered by the unchanged P signature preimage. Legacy policy/rows/tags remain unchanged. T separately pins the installed relay's expected four-byte authentication tag AND its canonical network/chain descriptor; it validates both challenge tag and request/directory canonical network rather than treating these two names as equal strings. The subject hint needs no added signed field: derived-address equality binds it to the already-signed recipient, unchanged configured tag pins the authoritative descriptor, and genuine Directory Current binds the canonical network/installation. Do not add a reverse installed-address map or infer one from profiles. Recovery obligations remain retained if fresh directory eligibility is unavailable; failure must never delete/ack/reinterpret them.

Actual third missing path is `src/directory_runtime.rs`. Existing public reserve(network,compressed_subject) accepts the locator, but Operation::Current/Historical returns Evidence{attestation,historical} and discards genuine Current status/generations/previousStamp. Existing `monad_dm_verify::CanonicalStampCheckInput` requires real &Current/&HistoricalEvidence; stable type2 bytes cannot be decoded/cast into that authority. Propose one finite typed runtime seam:

```rust
pub enum SnapshotOperation { Current, Historical([u8;32]) }
pub enum AdmittedSnapshot {
    Current(crate::directory_admission::Current),
    Historical(crate::directory_admission::HistoricalEvidence),
}
pub fn submit_snapshot(&self, reservation: Reservation, operation: SnapshotOperation)
    -> SnapshotSubmission;
// SnapshotSubmission::wait(self) -> Result<AdmittedSnapshot>
```

Results are copy-owned domain snapshots produced ONLY by the same native public Directory.current/historical_evidence operations in the existing serialized runtime owner. Current passes the existing continuity/floor fsync/trusted-clock/expiry/installed-relay completion checks before returning; Historical retains its explicit non-current classification and exact hash/statement/attestation. No public constructor claiming admission, no structural Current, no second directory/database/worker owner. Existing Evidence/submit HTTP APIs remain unchanged; typed reply shares the same admission capacity, generation reservations,60s waiter/recovery semantics, reload/control queue/shutdown lifetime. No queue/config/budget policy changes. Snapshot returned at one point in time is rechecked where required and never becomes an unbounded stale trust token. This finite path must be accepted/claimed before R implementation.

## 6. Sidecar lifetime, allowed owner hookup and finite path blocker

Canonical owner is lazy isolated store in src/store/monad_dm_cbor.rs, one process lifetime per Registry/database, original exact parts and frozen policy retained once, member rows reference them, atomic confirmed-publication/terminal transfer in its own DB. Prefer one original body owner plus validated bounded part/member byte ranges and exact Content-Type, rather than duplicating raw signed transactions in body, part rows and member rows; ranges are revalidated on reopen and return the original byte slices, never a reencoded FRNK frame. Ordinary unauthenticated reads of absent sidecar must not create it; successfully authenticated canonical read/ack may initialize auth-only storage solely to durably consume its challenge as accepted above. Admission first validates request/directory/CPU facts, then lazily opens/claims store before first RPC. Populated startup must reopen existing sidecar and reconcile with the SAME process-owned permit/config/private financial owner, not a detached second worker. Stop-new-sends rollback retains files/obligations; old binary ordinary legacy reopen proof separate from forbidden old-code operation on live canonical pending state.

Concrete blocker at eb027 AND reviewedmain9885: Registry.db is private; Db::owned_path() is crate-private but there is NO Registry Db/path accessor. RegistryServer cannot obtain that path using existing public facades. Forum owner has its own private path, not a DM storage injection seam. Adding a RegistryServer public field would require excluded caller/constructor files.

Propose finite `src/registry.rs` amendment ONLY: (a) add a private canonical DM owner initialized in Registry::new from existing db.owned_path(), expose crate-private owner accessor (no public Registry/Db getter), update same-file Registry test literals; (b) narrowly extract the existing strict ECC recipient verification primitive into a shared crate-private helper accepting an optional already-admitted P key plus the exact recipient-address binding. Canonical callers supply P only from genuine admitted Directory Current after subject/network/derived-address checks. The legacy registered-profile wrapper still obtains its original profile key and invokes the same primitive, preserving policy, unknown/malformed dummy-key verification work, errors and original tests. Missing P never skips the existing uniform dummy verification. No alternate ad-hoc signature verifier, public ECC/root getter or new signature domain. This follows existing private lazy Forum lifetime without changing Forum ownership. Sidecar type/module remains in already-listed store/monad_dm_cbor.rs; existing scoped server.rs can attach an Arc/private owner facade+DirectoryRuntime when composing canonical router; existing scoped monad_mailbox.rs can manage shared lifecycle. No store/db.rs, cashwebd main, manifests or broad constructor edits are needed under this narrow amendment. If owner cannot be shared this way with current RegistryServer Arc ownership, return exact compiler/caller evidence first.

## Acceptance/dispatch checklist — finite decisions only

1. Accept identity/comparator, JSON phase/status vocabulary and multipart inbox/recovery shapes above as one R/T contract; no independent worker variants.
2. After PR822 reviewed landing/claim completion, accept canonical financial.rs adaptation beyond extraction-only authority; reconcile60/258 narrowly, preserve all held/signed obligations.
3. Add only demonstrated missing paths: registry.rs private owner lifetime plus shared strict admitted-P ECC helper with original legacy profile wrapper/dummy work preserved; monad_message.rs shared auth facade with unchanged legacy behavior; directory_runtime.rs typed genuine admitted Current/Historical snapshot facade preserving existing runtime policies. Exact R ownership must include these finite amendments before source edits. They are proposals, not claimed current authority.
4. Canonical P lookup is resolved to the bounded compressed-point hint + actual fresh admitted Directory Current, derived-address/network checked, using the unchanged strict ECC/dummy-unknown work. Network binding is the existing authoritative descriptor and signed-chain match, with exact MONT/MON1 authentication tags preserved; no startup/config edits, legacy profile prerequisite or new crypto decision. R/T encoding/shape work need not wait for wallet bundle transfer.
5. W waits770 reviewed owner/claim transfer; owns journal/reservation/body freeze/terminal-before-cleanup/ack. R/T do not create a competing wallet owner. Existing B/public codec/hash/directory facades remain read-only inputs. Rust frank-cbor supports structural validation, not stage10.1–10.5 finality; canonical adapter must perform actual existing T3/DLEQ/T4/raw+receipt policy in the same private financial owner using public admitted historical evidence, not structural Current or protobuf authority.

Required paired proofs at final feature candidate: R/T exact byte-identical retry body/boundary/order and descriptor across two installed relays; malformed parts/bounds/identity/directory fails pre-RPC; hostile status/receipt/redirect remains uncertain; real P namespace challenge/cursor replay refusal; exact sidecar reopen/publication race/confirmed recovery; bounded streamed page and oversize-row error; original financial C0 equivalence. Joined W/R/T durable actual wallet→Rust→chain fixture→canonical private read plus killed-child journal/terminal recovery is later feature proof. This read-only freeze runs no gates and asserts none of those runtime outcomes yet.

## Final correction freeze

Coordinator-selected final choices incorporate the bounded independent wire review: genuine typed runtime snapshots; compressed P locator plus admitted Current; auth-only sidecar creation only after successful P authentication; existing authoritative MonadNetworkDescriptor mapping with exact original signature tag bytes; registry private lifetime plus shared strict supplied-admitted-P verifier preserving the old profile wrapper. Exactly three demonstrated additional paths beyond the canonical dispatch list: registry.rs, monad_message.rs and directory_runtime.rs. financial.rs still needs its separately named canonical adaptation amendment. This document grants no implementation authority by itself.
