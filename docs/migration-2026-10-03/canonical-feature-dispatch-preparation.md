# #777 canonical feature dispatch partition — preparation only

Read-only source reference main `9885b07dfac5c2725ce9296320df1b2175d226b8`; private precursor frozen `94bb223cec6974320950652d9bf4cbd6db2ccd5e`, base `aed48ec32a0fecfb3d6851f58eb35e8dae12c202`. The precursor has known pending compile/import repairs and is not a dispatch base. Requested strong; actual inherited. No code, claim, install, gate, activation or tracker mutation performed. All source reads used Git blobs; dirty canonical checkout untouched.

Fresh read-only `gh issue view` obtained bodies/comments/state for #777/#703/#778/#770. #777 comments5977883303 (private extraction only),5977946524 (actual storage-completion proof),5978240482 (active private precursor claim) control current scope. #703 comment5971740301 makes reviewed #777 the concrete prerequisite, preserving held258/history without execution authority. #778 remains C+#703-dependent text cutover. #770 comments5977995691/5978005364 transfer bundle production/test composition exclusively to its consumer; checkpoint5978216774 records active integration/gates. Fresh claim-state reconciliation is still required at actual dispatch; a source handoff or merged-looking path does not terminate ownership.

## Preconditions and authority changes before dispatch

1. Repair/gate/independently review and land private precursor; record full actual landing SHA and claim completion. Re-read `financial.rs` and caller contracts at that SHA. Never implement on frozen94bb or assume its new views compile.
2. Accept finite **canonical feature** authority for `src/monad_outbox/financial.rs`: existing owner amendment accepts this path only for behavior-equivalent legacy extraction, while canonical body omits it. Canonical T3/T4/directory-bound adaptation cannot be smuggled under refactor scope. Keep child private, one confirmed constructor, no alternate broadcaster or second chain policy. Amend historical60/258 economic semantics narrowly for canonical feature; preserve held artifacts and already-signed obligations.
3. Sequence wallet bundle against reviewed #770 integrated existing-pool topic-owner seam and explicit claim transfer/carve-out. Consumer33c2205a owns both `monad-wallet-bundle.ts` and its test under5978005364. No parallel edits to that file/test or shared orphan/compaction/close semantics. #777 must preserve topic namespace rows, actual root/pool/lease identity, union old+canonical topic and stamp references before retirement, private lifetime/provenance and close-drain. If #770 cannot land before feature work, only pure transport/Rust work may start after precursor; wallet bundle edits wait.
4. Freeze ordinary HTTP response/status, multipart read/recovery framing, exact submission identity comparison and public TS API contract below before worker source writes. These are concrete runtime interface details, not new FRNK type/crypto allocation. Existing body specifies semantics/parts/bounds but not every response field or serialized status shape; workers must not independently invent incompatible envelopes.
5. Approve only finite missing seam paths if demonstrated: tests for actual child termination/reopen may need an owned fixture path; runtime wallet composition may need a handle/material path to expose the same durable owner. Current C list excludes `monad-wallet-handle.ts`, `monad-wallet-material.ts`, `chain/monad-chain.ts` and `store/db.rs`. Prefer existing bundle and `Db::owned_path()` seams; do not edit these silently. #778 owns eventual chain normal cutover, not #777 activation. Sidecar owner/location injection should use already-scoped server/store composition if feasible.
6. Assign fresh exclusive claims/worktrees against actual integrated base. Freeze sibling contract first; no activation until repaired refactor landed, current ownership reconciled and complete feature reviewed. Heavy Rust/browser/install work remains lease-controlled with owned caches; this packet runs none.

## Exclusive workers

| Worker | Exclusive paths | Owned result / forbidden overlap |
| --- | --- | --- |
| R: canonical relay owner | registry `src/monad_outbox.rs`, `src/monad_outbox/financial.rs` after amendment, `src/store/monad_outbox.rs`, `src/monad_mailbox.rs`, `src/http/monad_message_cbor.rs`, `src/http/monad_message_cbor_tests.rs`, `src/store/monad_dm_cbor.rs`, `src/monad_dm_economics_tests.rs`, `src/store/mod.rs`, `src/http/mod.rs`, `src/http/server.rs`, `src/lib.rs` | Bounded route+lazy sidecar+same financial owner+private mailbox namespace. Do not split financial adapter, reconciliation or locked finalization into competing Rust workers. Legacy HTTP preflight stays unchanged unless finite amendment needed. |
| W: durable wallet owner | `packages/wallet/monad-stamp-client.ts`/test, `monad-stamp-stealth.ts`/test, `storage/stamp-attempt-journal.ts`/test, `storage/monad-wallet-bundle.ts`/test after770 sequence | Versioned canonical journal, same account/pool/reservations, durable exact preparation/lookup/reconcile/replay/outcome/ack. No transport/mailbox source edits or topic owner overwrite. Own journal+bundle+client together; splitting these would invite a second journal or inconsistent cleanup ordering. |
| T: public transport/mailbox | `packages/cashweb/relay/canonical-dm-transport.ts`/test, `monad-mailbox-client.ts`/test | Exact frozen multipart construction/transmission, strict accepted status matching, bounded authenticated canonical inbox/recovery/ack decoding. No payment selection/signing, durable journal, directory authority or Rust edits. |

Coordinator exclusively integrates registrations/contracts, runs cross-language gate once, assigns exact test-only integration additions if needed, then independent review. Registrations are R-owned for source coherence, not a second worker's patch. Existing #775 canonical-dm.ts/canonical-dm-stamp.ts are read-only effect-free shared inputs, not a fourth implementation scope. #703/#778 consumers wait for actual reviewed seam; they can groom read-only without editing its API.

## Interface freeze to accept before edits

These names are **proposed task interfaces**, not claims that current APIs exist or owner-approved wire fields. Current `PreparedDirectMessage` supplies copy-owned payload/context/t3/messageId/contentDigest/content/revision/senderT1/recipientT1. It is not complete type1, raw signed set, immutable HTTP body, durable attempt or delivery evidence.

**Preparation input:** exact B-prepared opaque payload/context plus immutable account/network/sender+recipient directory identities and authenticated recipient stamp facts, passed through the reviewed public owner. Wallet validates same-byte binding before payment effects. Consumer must persist exact prepared identity before wallet preparation; no randomized rebuild during lookup.

**Wallet public operations:** propose `prepareCanonicalAttempt(prepared,binding) -> durableAttemptRef`, `lookupCanonicalAttempt(preparedIdentity,binding) -> exact ref | absent | held`, `enumerateCanonicalAttempts()`, `reconcileCanonicalAttempts(...)`, `startCanonicalReplay(ref,installedRelays)`, `canonicalAttemptOutcome(ref)`, `acknowledgeCanonicalOutcome(ref,consumerIdentity)`. Signature details freeze against actual producer implementation before #703 dispatch. Lookup validates bytes/context and never signs/reserves; duplicate prepare under one bundle returns original owner or conflict. Open does not replay. Reconcile/correlation runs before explicit start. Absent link does not imply absent wallet attempt.

**Durable record:** strict versioned canonical namespace with exact prepared payload/context, exact type1, raw signed members in order, immutable economic account/network/directory identity, reservation IDs, complete frozen multipart body and Content-Type boundary, submission identity and phase. Same prepared identity maps to one owner; full-byte/context mismatch holds. Legacy `outgoing-stamp-attempts` stays intact with its exact bytes and economic replay rules. No legacy decrypt activation or reset. Terminal result commits durably before lease/live cleanup; reopen recovers delivered/dead even after cleanup. Linked terminal evidence is bounded through backpressure and workflow acknowledgement frontier, never age-only eviction. Outcome ack and recipient sweep/recovery ack are separate authorities.

**Transport object:** copied exact body bytes + exact Content-Type plus exact delivery/context/raw-member identities. Multipart boundary generated once and persisted by wallet; T must not regenerate it per relay/retry. Targets may change only among independently installed authorized relays while body/order/set stays identical. No extra part, trailing data, >8MiB total, context>4KiB, member>128KiB, outside1..64 members. Enforce before allocation/signing as relevant. Delivery type1 references exact transaction IDs from signed raw set; never fabricate raw bytes from IDs.

**Transport result:** freeze discriminated retained/pending/delivered/dead/uncertain semantics and exact matching fields as ordinary HTTP runtime contract. Echo/receipt/2xx alone never delivered. Any contradiction/missing identity or interruption remains retained/held uncertainty. Delivery means relay durable mailbox publication for that complete submission identity. No generic workflow protocol, signature domain or new codec allocation.

**Rust adaptation:** canonical CPU checks resolve exact context T1 via public admitted historical evidence and validate stage10 before RPC. Missing predecessor409; invalid/mismatched raw order/hash/network/destination/value/input/commitment fails before broadcast. Adapter passes exact canonical bytes and normalized signed financial facts into the **same** private owner; avoid converting delivery into reserialized legacy protobuf authority. Keep CPU valid separate from receipt-confirmed `VerifiedSubmission`; finalization reconstructs/validates confirmed authority under lock and atomically commits exact mailbox publication plus economic terminal transfer. Shared replay/nonce/receipt/cancellation/permit policy retains current semantics. Legacy preflight error precedence and signed obligations remain unchanged.

**Storage/read seam:** lazy isolated canonical sidecar, owned once; never eagerly add unknown CFs to legacy Db. Store original delivery/context/transaction parts and immutable identity, recovery provenance and frozen policy. Canonical auth/inbox/recovery/ack routes reuse existing P signature challenge/resource/cursor transcript in separate route namespace; legacy challenge/cursor cannot cross. Bounded multipart private inbox <=100 records/8MiB; oversized individual explicit error. Recovery ack exact recipient/payload/obligation generation only, durable sweep import prerequisite unchanged. No new public mailbox or protobuf projection fallback.

## Dependency order and useful parallelism

After precursor landing/authority/claims: R and T can implement against frozen multipart/status contract in parallel. W can implement durable records/API against frozen T pure encoder/result types after #770 bundle prerequisite and explicit transfer. T's pure codec/transport handoff should freeze early; W does not copy its encoder or source. R/T paired fixture contract proves identical bounds/identities/status. W/T paired fixture proves durable exact-body gate; final joined R/W/T candidate proves actual wallet→route→financial owner→sidecar→private read. Independently land only a complete safe predecessor with its own accepted scope/review; worker commits are source transport into one canonical feature candidate, not partial activation.

The feature provides the usable public seam to #703; #703 performs Qwen correlation/terminal batch, and #778 performs typed UI/Qwen normal switch and operator trust readiness. Neither is included in feature worker source authority. Rollback stops new canonical sends and preserves sidecar/journals; older binary unused/populated legacy reopen compatibility is a separate proof from running old code against live canonical pending records, which is forbidden.

## Required proofs owned by the partition

- W: deterministic hold/reject **underlying actual journal write completion**, zero relay effects until completion; no C0 getAll-only substitute. Actual child termination before/after reservation and journaling, after relay retention/before terminal, after terminal/before cleanup, before consumer ack. Same signed set/body after reopen; concurrent duplicate prepares one reservation/payment set; lookup/correlation before replay; backpressure without linked-outcome eviction; old journal/leases untouched; #770 topic references/close lifecycle unchanged.
- R: malformed multipart/context/directory/raw identity fails pre-RPC, independent receipt contradiction matrix, advanced nonce without competing proof stays pending, cancellation exposure and exact reopen, confirmed-prefix/recovery retention and foreign/stale ack refusal, exact finalization race, lazy sidecar old-binary reopen unused/populated, separate challenge/cursor namespace and bounded page proof. No manufactured Current or confirmed token.
- T: complete wire bytes equal across retries/two relays, hostile response mismatch/unknown receipt remains uncertainty, no signing/payment effect, bounded streaming pages and aggregate staging, authentication namespace and exact recovery ack; preserve existing legacy APIs for already-owned obligations without new normal fallback.
- Joined: actual public wallet with persistent owner + loopback Rust route + signed synthetic fixture/provider + private read proves durable logical delivery; killed child reopen/correlation without re-signing or paying. Secret sentinel and exact unknown optional authenticated-field preservation. Applicable TS/Rust/browser/CI gates at frozen candidate with honest baseline/unrun evidence, then independent tier3 economic/security/persistence/authority/test-quality review.

Open finite decisions for coordinator: financial.rs feature amendment; #770 bundle sequencing/transfer; exact status/multipart-read fields and submission identity comparator; production sidecar lifetime through existing scoped composition; reachable public runtime owner facade; authorized killed-process fixture path if existing allowed tests cannot host it. No broad crypto/policy/provisioning proposal is requested.

## Immediate dispatch eligibility after repaired precursor landing

R's complete listed Rust path set and T's four listed transport/mailbox paths can be exclusively claimed immediately after precursor landing, finite financial.rs authority acceptance, historical-claim reconciliation and interface freeze. They do **not** wait for #770 bundle transfer. R remains the sole Rust economic owner; source writes do not imply route activation. T remains pure public transport/auth adaptation. W's `monad-wallet-bundle.ts` and test, and shared startup/compaction/close semantics, wait for reviewed #770 seam plus explicit transfer. W could prepare read-only until then; do not dispatch an incomplete journal worker that invents a competing pool owner to avoid that dependency.

Existing `src/http/monad_message.rs` legacy CPU/error adapter remains unchanged at the reviewed precursor landing. Its precursor claim must finish explicitly; no R ownership of this path is implied by the canonical feature path list. If actual compilation needs a change there, return the exact caller/import amendment first. The same legacy validation entrypoint remains supported for already-authorized economic obligations; no canonical-request-to-legacy-HTTP conversion.

Proposed finite authority text for owner publication before edits:

> Accept `backend/cashweb/cashweb-registry/src/monad_outbox/financial.rs` in the separately reviewed #777 canonical feature claim, beyond its prior behavior-equivalent extraction authority. Only adapt the existing private financial owner to exact canonical type1/context/raw signed-member facts and admitted directory T1/T3/T4 expectations. CPU preflight never grants confirmed authority; confirmed view construction remains private and revalidated inside durable finalization. Preserve legacy validator/error precedence, raw signed obligations, frozen retry/nonce/receipt/finality policy, leases/permits/exposure/recovery and original legacy HTTP adapter. No second broadcaster, new signature/crypto allocation, legacy decrypt activation, eager legacy CF/schema change or wallet/topic ownership expansion. Canonical-feature claims start only on repaired/gated/reviewed precursor landing and after historical60/258 reconciliation; unrelated held artifacts remain protected.

Concrete proposed interface names for the sibling contract (all in already-owned files; no new standalone type module):

```ts
// T owns these exports in canonical-dm-transport.ts; wallet stores their exact bytes.
interface CanonicalExactParts {
  readonly delivery: Uint8Array
  readonly context: Uint8Array
  readonly transactions: readonly Uint8Array[]
}
interface CanonicalExactRequest {
  readonly parts: CanonicalExactParts
  readonly body: Uint8Array
  readonly contentType: string
  readonly submissionIdentity: string
}
type CanonicalAcceptedStatus =
  | { phase: 'retained'; submissionIdentity: string }
  | { phase: 'delivered'; submissionIdentity: string; deliveryEvidence: Uint8Array }
  | { phase: 'dead'; submissionIdentity: string; reason: string }
// Malformed/contradictory/unavailable responses throw classified uncertainty;
// they cannot be promoted into a matching terminal status.
function freezeCanonicalRequest(parts: CanonicalExactParts): CanonicalExactRequest
function submitCanonicalRequest(input: {
  installedRelayOrigin: string
  request: CanonicalExactRequest
  signal?: AbortSignal
}): Promise<CanonicalAcceptedStatus>
// Existing MailboxAuthParams supplies P signer + installed identity/clock;
// canonical namespace is fixed by these functions, never caller-selected fallback.
function fetchCanonicalInboxPage(input: {
  auth: MailboxAuthParams; cursor?: string; limit?: number
}): Promise<{ records: readonly CanonicalExactParts[]; nextCursor?: string }>
function fetchCanonicalRecoveryPage(input: {
  auth: MailboxAuthParams; cursor?: string; limit?: number
}): Promise<CanonicalRecoveryPage>
function ackCanonicalRecovery(input: {
  auth: MailboxAuthParams; obligation: ExactRecoveryObligation
}): Promise<void>
```

`CanonicalRecoveryPage`/`ExactRecoveryObligation` must reuse existing public recovery economic fields and add only exact canonical provenance needed by the accepted route, with no opaque provider bodies or new sweep authority. `submissionIdentity` algorithm and `deliveryEvidence`/reason vocabulary are frozen runtime details to approve jointly with R; the signature above does not allocate a hash domain or FRNK frame. T verifies identity against the exact request; W rechecks it before durable transition. Disposition field names on HTTP may differ only after a single accepted R/T contract update.

```ts
// W owns these in stamp-attempt-journal.ts, versioned namespace independent of legacy rows.
interface CanonicalAttemptBinding {
  readonly accountId: string
  readonly network: string
  readonly senderT1: Uint8Array
  readonly recipientT1: Uint8Array
  readonly preparedIdentity: string
}
interface CanonicalAttemptRef {
  readonly attemptId: string
  readonly preparedIdentity: string
  readonly submissionIdentity: string
}
type CanonicalAttemptPhase = 'prepared' | 'pending' | 'delivered' | 'dead' | 'held'
interface CanonicalAttemptRecord {
  readonly version: 1
  readonly ref: CanonicalAttemptRef
  readonly binding: CanonicalAttemptBinding
  readonly exactRequest: CanonicalExactRequest
  readonly reservationIds: readonly string[]
  readonly leaseIndices: readonly number[]
  readonly phase: CanonicalAttemptPhase
  readonly terminal?: CanonicalAcceptedStatus
}
interface CanonicalAttemptJournal {
  getByPreparedIdentity(identity: string): CanonicalAttemptRecord | undefined
  get(ref: CanonicalAttemptRef): CanonicalAttemptRecord | undefined
  getAll(): readonly CanonicalAttemptRecord[]
  putPrepared(record: CanonicalAttemptRecord): Promise<void>
  recordTerminal(ref: CanonicalAttemptRef, result: CanonicalAcceptedStatus): Promise<void>
  retireLive(ref: CanonicalAttemptRef): Promise<void>
  acknowledgeOutcome(ref: CanonicalAttemptRef, consumerIdentity: string): Promise<void>
}
```

Journal transitions enforce exact identity/CAS and durable ordering, not unrestricted caller-supplied phase overwrites. `recordTerminal` accepts only matching delivered/dead after verified transport authority; retained is nonterminal. `retireLive` cannot remove outcome evidence. Storage owner may privately separate live and terminal rows but exposes one versioned journal, not a second bot journal. Startup opens/enumerates only; bundle serializes stateful operations and unions all references before any orphan retirement. Proposed identifiers are public runtime identity values to bind against actual account owner, not directory trust tokens or new cryptographic domains. #703 owns workflow consumer identity and its own terminal commit, never journal internals.
