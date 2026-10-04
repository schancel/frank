# Suite-1 directory preview allocation proposal

Status: **PROPOSED — NOT ALLOCATED, NOT ACTIVE**. Issue [#719](https://github.com/schancel/frank/issues/719).
Repair base: `2f2ae5bfda5b23b48d2b42fcac6fdf0802ecaeb4` (original frozen-artifact
base `6a8cbdf7cb44296f646d233474afc9784323f63b`). All choices below need independent
protocol/security review and coordinator approval. None authorizes a production writer.

This proposes the smallest self-contained directory statement that can supply
the exact directory hashes and independent public keys required by frozen
[S2d](../../cbor/README.md#5-semantic-ordering-and-uniqueness). It is a bounded,
no-real-users preview, **not** the replicated directory specified as the clean
target in [main specification §8](../../../CASHWEB-PROTOCOL-SPEC.md#8-directory-provider-and-profile-topology).
The target additionally needs descriptor revisions, provider-installed capabilities,
instance generations, recovery and federation policy. This proposal does not allocate them.

## Allocation and authenticated bytes

Propose FRNK version 1, type 4, **schema 4 / minimum reader 4**. Choosing matching
schema and reader numbers makes the new required interpretation visibly separate
from registration schema 3 / reader 2; reader 3 is not allocated by this proposal.
The type-2 wrapper remains schema 1 / minimum reader 1 with its existing structure.
An old reader can parse the wrapper but must reject its required type-4 child at
stage 7. Opaque storage is not directory acceptance. There is no codec fallback.

| Field | Proposed interpretation | Relation to existing fields |
| ---: | --- | --- |
| 0 | Network, frozen S1 syntax | Unchanged |
| 1 | Subject and directory authority `P`, key type 1 | Unchanged authority role |
| 2 | Revision, uint64, starting at 0 | Same monotonic role; preview requires contiguous increments |
| 3 | Issue timestamp | Same timestamp shape; preview enforces clock policy |
| 4 | Exactly one caller-supplied relay binding | Existing S4 structure; preview cardinality narrowed |
| 6 | Required expiry timestamp | Existing field; preview makes validity mandatory |
| 8 | Stamp key `P'`, key type 1 | Existing stamp role, stricter point/separation checks |
| 10 | Message-DH key `M`, key type 1 | New, never profile field 9 |
| 11 | `mailbox_key_generation`, uint64 | New; preview only grants suite-1 DM use, not mailbox authentication |
| 12 | `stamp_key_generation`, uint64 | New |
| 13 | Exact predecessor type-4 T1 digest, or null at bootstrap | New |

Fields 5 (type-7 transitions), 7 (recovery authorities), and 9 (presentation
profile) retain their existing meanings but are **unsupported in this preview**.
They must be absent. Field 9 is not a place to carry message keys or target
profile semantics. Schema-4 unknown fields are rejected. For a future compatible
schema with minimum reader 4, unknown optional fields are retained in the exact
original frame under V6.3 and remain covered by both T1 and T2; they grant no
new authority. New required semantics require a higher reader floor. The corpus's
schema-5 optional-extension example is proof-only, not a schema-5 allocation.

`directory.cddl` is a standalone proposal grammar. Frozen C1–C12 canonicality,
FRNK framing, common field bounds and R1 aggregate resource accounting still apply.
The complete type-2 **and** bare type-4 frame each have a 256 KiB limit in this
preview. Exactly one relay and one signature are permitted; endpoint <= 2048
UTF-8 bytes, relay ID 16..64 bytes, and the frozen generic limits bound retained
optional data. Implementations must meter envelope, payload and opened children
together, reject before costly curve work, and never return partial state.

The exact complete type-4 frame, including header, versions, payload byte string
and optional bytes, is the statement identity:

```text
T1 = SHA256(u16be(21) || "frank/content-hash/v1" ||
            u16be(len(network)) || network || u32be(len(type4)) || type4)
T2 = SHA256(u16be(28) || "frank/directory-signature/v1" ||
            u16be(len(network)) || network || u32be(len(type4)) || type4)
```

Lengths above count ASCII/UTF-8 bytes; context is empty. These are the existing
T1/T2 transcripts, not new cryptography. The wrapper contains exactly one
algorithm-1, strict-DER low-S secp256k1 ECDSA signature by exactly field 1.
Sign the T2 **digest**, not T1, payload bytes, wrapper bytes, or a second hash of
T2. Type-2 identity is separately computable but never a predecessor or S2d
directory commitment. Never decode/re-encode bytes before hashing, verifying,
persisting or forwarding. Canonical round-trip in tooling is an interoperability
check, not a retention implementation.

All three role keys must be valid, non-infinity compressed SEC1 secp256k1 points
of key type 1. Reject role collisions even under point negation (equal 32-byte
x coordinate), since the secret for `-P` is trivially obtained from the secret
for `P`. A same-subject history may never reuse an old role point, or its
negation, in a different role; a rotated M or stamp point may never recur in
its own role. This public check cannot establish independent derivation or
knowledge of either secret. P's signature proves possession only of P.
The accepted S10a proof-of-possession gap for P' remains; likewise M publication
does not prove decryptability. Writers must possess and safely retain their
own independent secrets before publishing. No derivation schedule is allocated:
[#696](https://github.com/schancel/frank/issues/696) is a predecessor to wallet
activation. The frozen registry has no **dedicated stamp domain-root purpose**.
The owner has selected the existing `evm-wallet` purpose 2 as the preview stamp
root, with a separate fully hardened S10a child branch; P and M retain distinct
auth/message roots. This selects a root mapping, not identity/EVM public-key
reuse. The [successor contract](derivation-successor.md) requires explicit child
allocation and exact vectors without a new purpose or registry/recovery-format
migration. Those child constants still need review before activation.

## Proposed preview state machine

The state is keyed by `(network, P)` and atomically stores exact current frame,
T1, revision, both key generations, current and immediately previous stamp
points, last checked clock value, and verified predecessor history. Retain the
history needed to prove no key reuse and to open dependent messages. A cache
of a projection alone is insufficient. Persist an accepted update and its
stamp state together before acknowledging it.

1. **Bootstrap:** require a trusted, caller-installed `(network, P, exact T1)`
   anchor; self-signature, relay response, URL and highest timestamp are not
   anchors. The pinned revision-0 record requires both generations 0 and
   predecessor null. It may be expired when first encountered: authenticate it
   as a historical link and verify every successor through a fresh head under
   the atomic catch-up rule below. A revision-0 record used directly as the
   head must itself be fresh. Initial previous stamp is null. A missing anchor,
   missing trusted clock or missing trusted relay tuple fails closed. A reset
   is not a bootstrap opportunity: if any durable state existed, restore and
   verify it or require explicit operator re-anchoring outside this profile.
2. **Update:** fully authenticate first; require the same network and P,
   revision exactly prior+1, predecessor exactly prior's T1, and issue time
   >= prior issue time; same-subject schema version must never decrease. An identical already-current exact frame is an
   idempotent duplicate (does not extend expiry or change stamp state).
   A lower revision is rollback. A different statement at an observed revision
   or a competing child of an observed predecessor is a fork: retain both as
   conflict evidence, disable new routing for that subject and require external
   resolution. Never select by arrival, timestamp, hash or largest revision.
   Missing intermediate revisions must be fetched and verified, not skipped.
   The last durable head remains the authority anchor even after expiry; expiry
   blocks its use for new messages, not P's ability to sign linked successors.
3. **Independent generations:** an unchanged point requires an unchanged
   generation. A changed point requires exactly +1 of its own generation and
   the no-reuse checks above. Rotating M does not rotate P', and conversely.
   Revision uint64 max is terminal; generation uint64 max cannot rotate that
   role, though other changes remain possible until revision max. Arithmetic
   never wraps. Generation is a public sequence, **not** a child-path index.
4. **Authority transitions:** P changes, field 5, and field 7 fail closed as
   unsupported. Frozen S10/type-7 can authorize transitions in existing
   schemas, but this preview deliberately does not specify how new generations,
   role-history and anchor identity cross an authority transition. A valid old
   type-7 proof is not sufficient to enable that missing policy. No recovery
   authority can be introduced and consumed in the same update.
5. **Validity:** trusted Unix time with nanosecond precision is caller input.
   Every record requires `issue <= now`, `0 < expiry-issue <= 366 days`, and
   every binding expiry >= statement expiry. The final head additionally
   requires `now < expiry`; expired intermediate links are allowed only inside
   atomic catch-up or archive verification. No implicit clock-skew allowance.
   Persist last accepted/check time; rollback of that clock, unknown clock or
   expired state disables new use. Historical signature/link verification does
   not assert that a client observed or accepted the record before it expired;
   no invented historical clock or acceptance timestamp is needed. Expired
   historical bytes cannot become a fresh routing record. A renewal is a new revision and
   signature; an unchanged key does not reset its generation or previous stamp.
6. **Binding:** caller supplies a previously authenticated real relay tuple
   `(relay_id, exact endpoint, relay identity, binding expiry)` and the final
   head must match it byte-for-byte. The key is a valid key-type-1 point. S4 URI
   syntax applies; this preview additionally permits HTTPS only. No placeholder,
   ambient default, fallback URL, or hash-of-URL identity. The relay ID's
   registered derivation/provisioning must be validated by that caller. This
   proposal does not allocate an ID algorithm or a provider descriptor.
   Changing the head's tuple needs a newly authenticated caller configuration and a
   signed directory successor. Its expiry cannot be extended by directory
   signature alone. Fixture tuples are explicitly synthetic offline inputs;
   they do not demonstrate contact with a real relay.

**Atomic historical catch-up:** start with the last durable verified head and
history, or the caller-pinned revision-0 anchor for a genuinely new contact.
Accept an ordered, bounded list of complete type-2 attestations. Authenticate
each exact type-4/T2 signature and enforce network/P, schema order, contiguous
revision, exact predecessor, monotonic issue time, internal validity window,
generation and no-reuse rules on a private staged history. Intermediate
bindings need valid signed structure, point/URI syntax and binding expiry >=
their statement expiry; they need not match today's caller relay tuple, and
neither their bindings nor their expired keys may authorize new use. This
explicitly permits a client at rev0 to verify an expired rev1 and reach fresh
rev2, or a late contact to reach rev2 from an expired pinned rev0.

Only after the terminal head is fresh and matches today's authenticated relay
tuple may the consumer atomically commit the entire verified history, terminal
head, both generations, current/previous stamp pair and current checked clock.
Process all rotations in order, including intermediate rotations, to compute
the S10a pair. Any invalid/missing link, bad signature, exhausted budget,
untrusted terminal binding or expired terminal head leaves head and stamp
state unchanged. A verified fork is retained as bounded conflict evidence and
disables routing; failure does not authorize a partial head or pick a winner.
Staged/historical validation is an internal proof step, never an independently
usable directory acceptance result. An empty batch cannot revive an expired
head. Freshness/convergence limitations below still apply.

**Cumulative preview bound:** per `(network, P)`, retain at most **4096 accepted
statements** and **16,777,216 charged bytes** across the entire history. Charge
each statement's exact type-4 bytes plus one validating type-2 wrapper, even
though the wrapper contains the statement. Keep that wrapper stable; alternate
wrappers are not extra authority and cannot replace the accounting baseline.
Before parsing or signature verification, apply both limits to retained state
plus the complete presented candidate batch; duplicate/replayed inputs also
consume the batch budget until rejected or recognized. Bound conflict-evidence
storage by the same byte budget. Per-frame 256 KiB and frozen decoder budgets
still apply. Commit counters atomically with history. At either cap, reject
extensions; never prune no-reuse/predecessor evidence, reset counters or treat
an existing account as a new bootstrap to continue. A separately reviewed
compaction/migration is required before operating past the bound. With hourly
renewals the count bound permits roughly 170 days from bootstrap; this is an
intentional preview limit, not a permanent directory design.

Bootstrap pins prevent undetected stale bootstrap only to the extent that the
caller obtained a fresh anchor. The 1-hour validity is a proposed preview bound,
not a global convergence guarantee. A provider can withhold a newer record;
partitions remain possible within the bound. This is not the target federation
freshness or provider fencing protocol. Authorization to populate that trust
configuration is a deployment prerequisite outside this corpus.

## Stamp grace, message retirement, and restart

Preserve frozen S10a exactly for an accepted same-subject update: if P' is
unchanged, neither current nor previous stamp changes. Otherwise previous
becomes old current and current becomes new P'. A consumer accepts only current
or immediately previous P' under S10a.4, with no time or revision-count grace
cutoff. A non-rotation renewal never clears previous. After a compromise,
two distinct rotations are necessary to eject the compromised point from this
pair; one is insufficient. Retain retired stamp secrets while their children
or accepted/exposed obligations can still need spending. Expiry disables fresh
directory use; it does not alter S10a's definition of the previous key.

On a normal restart, restore the verified pair atomically with the exact head.
If previous-key state is lost but a trustworthy fresh head survives, frozen
S10a's conservative reconstruction permits current only, previous null; do not
guess previous from an untrusted record. Restore verified contiguous history
before re-enabling previous-key grace. If head/rollback-protection state is
lost, block new use until external re-anchoring. Losing secret material also
blocks the corresponding receive/open action; public directory state cannot
reconstruct a secret. No codec accept result claims crash durability.

For **newly authored** suite-1 messages, resolve fresh sender and recipient
heads and use their exact T1 hashes, M points and recipient P'. S2d binds those
exact values, not a projected profile. M rotation immediately excludes retired
M from new preview use; it does not allocate mailbox authentication or revoke
sessions. Previously sealed in-flight messages may use a verified historical
recipient statement only if its M still equals the current M and its P'
equals current/previous under S10a. The old statement must still be unexpired
at admission. That is stamp grace, not permission to roll back directory state.
The sender tuple must equal its freshest locally verified valid head. Generation
is committed indirectly by the exact directory hash; this proposal does not
add fields to the frozen type-5 schema-2 context.

An explicit **archive-open** operation may resolve old authenticated statement
bytes and their matching retained M secret to decrypt old ciphertext. It grants
no new admission, mailbox authorization, stamp credit, or sender-authorship
proof. Preserve those statement bytes/secrets while dependent deliveries or
replay remain; destructive retirement needs separate user policy. Static-key
compromise limitations and lack of forward secrecy remain unchanged. Fixture
message checks prove tuple-selection policy only, not encryption or delivery.

The clean target in main spec §8.2 has **current-only P' after provider-effective
capability installation** and bounded, explicitly authorized M grace. This
preview has **S10a current/previous P'** and **no retired-M new-use grace**.
Neither rule silently replaces the other. A later target migration requires
new allocations, explicit authenticated predecessor/migration evidence and
provider fencing. This proposal cannot be advertised as that migration.

## Choice and review register

Every row is proposed, not accepted. Protocol/security reviewers assess the
choices; @schancel / coordinator owns their disposition.

| ID | Choice and security rationale | Review/deferred boundary |
| --- | --- | --- |
| C1 | Type4 schema4/min4; old required-child readers reject | Numeric allocation requires approval; schema2/3 unchanged |
| C2 | Fields10–13; explicit null predecessor; exact T1 identity | No profile smuggling or type2-hash identity |
| C3 | All roles type1, valid points, x-coordinate separation and history no-reuse | No proof of M/P' possession or independent derivation; #696 owns schedules |
| C4 | Frozen algorithm1/T1/T2; exactly one subject signature | No new crypto or arbitrary algorithm negotiation |
| C5 | Zero-based, contiguous uint64 generations and revisions | 4096-statement / 16 MiB cumulative history cap; target compaction deferred |
| C6 | Exact pinned rev0 or durable head; authenticated historical links commit only with a fresh terminal head | Owner selected atomic catch-up; anchor provisioning/fork resolution remain external |
| C7 | One-hour validity, trusted clock, no skew/rollback; expired intermediates never authorize use | Owner selected historical verification; not target global freshness |
| C8 | One caller-authenticated HTTPS relay tuple and expiry | Descriptor/ID-algorithm allocation, federation and multi-provider use deferred |
| C9 | Frozen S10a pair persists; restart current-only degradation | Target current-only capability policy explicitly deferred |
| C10 | Current M for new use; old M only for explicit archives | Mailbox capabilities, sessions, compromise fencing deferred |
| C11 | No type7/authority/recovery/cross-schema transitions | Validity of an old type7 signature does not decide new lifecycle policy |
| C12 | V6 optional retention; exact-version unknowns reject | Unsupported required semantics never authorize projection |
| C13 | 256 KiB frames plus cumulative 4096-statement / 16 MiB cap, one binding/signature | Exact cap proposed for approval; no eviction/reset bypass; harness is not a production validator |
| C14 | Stamp preview root is existing purpose2 `evm-wallet`, separate fully hardened S10a child branch | Owner-selected mapping; child allocation/vectors remain #696 successor; no new root purpose or format migration |

Current durable shape is registration schema3 with P/P' and optional profile.
The proposed shape adds explicit M, independent generations and predecessor;
the known successor is target directory/provider admission, whose descriptor,
capability and migration boundaries remain separate. Reversal before activation
is deletion of these three proposal directories. Reversal after activation
would require migration, which is why review and allocation precede any codec
change. No runtime, generic extension framework, wallet path, active CDDL,
manifest, mailbox capability or provider federation record is added here.

## Proof and next stages

[`vectors.json`](vectors.json) is shared language-neutral evidence. Its manual
outcome labels describe this proposal, not what active typed codecs accept.
[`fixtures.md`](fixtures.md) defines the manifest and exact reproducible gates.
The TS harness generates deterministic complete type-4 and signed type-2 bytes
and checks proposed acceptance/state policy. The independent Rust harness checks
canonical bytes, T1/T2, signatures, old-reader rejection, and independently
constructs the bootstrap. It does **not** implement all proposed state policy.

Required sequence: independent protocol/security review, separate verification
of concrete findings, coordinator approval of choices, then a separately owned
active CDDL/codec/conformance allocation stage; then #696 child schedules and
normal writer/read/route cutover with protobuf fallback removal. #258 stays held.
No merge of this draft alone means the choices are accepted, and neither #458
nor #133 is completed by it.
