# Rust preview directory admission

This opt-in Rust facade implements the accepted #719 C1–C14 history policy on
top of #742 signed evidence. It has no HTTP route, writer, provisioning, default
consumer or DM integration. The browser/Node mirror (#749) remains mandatory
before a client trusts a directory head. Existing profile/protobuf stores are
untouched. Parent #133/#696 and held #258 are not completed by this stage.

## Public boundary

`cashweb_registry::directory_admission` exports the public types and borrowed
`Directory` handle. `Db::directory_preview(anchor, mode)` is the only opener.
There is no trusted-record setter, caller `verified` flag, secret-key input,
network fetch, ambient clock, URL-derived identity or automatic re-anchoring.

| Operation | Required input | Result/authority |
| --- | --- | --- |
| Open `NewEnrollment` | Installed network, full P, exact revision-zero T1 | Refuses any existing subject state; no fresh authority |
| Open `Reopen(checkpoint)` | Same installed anchor and external minimum continuity checkpoint | Authenticates all retained evidence and prefix continuity; missing state is unavailable |
| `advance` | Ordered exact bare type4/type2 pairs, trusted ns time, authenticated relay tuple | Durable fresh terminal `Current`, or rejection; verified forks alone persist quarantine |
| `current` | Fresh trusted time/relay context | Rechecks durable state; persists successful checked-time advancement before returning |
| `historical_evidence(T1)` | Exact accepted record identity | Original bare/wrapper bytes only; never fresh routing/stamp authority |
| `status` | Open handle | Validated counters, head, stamp pair, checked time and checkpoint; no freshness |
| `conflict_evidence` | Open handle | Bounded exact proof-only fork records for external investigation |

`Current` is a point-in-time snapshot; consumers must call `current` again for
each new use. Returned buffers are owned copies. The API never accepts a
returned projection as proof. Historical evidence, including expired records,
cannot be converted into `Current`. There is no retired-M new-use grace.

The caller authenticates the relay ID, exact HTTPS endpoint, identity key and
binding expiry independently, and passes the complete tuple each time. This
module allocates no relay-ID algorithm, descriptors, clock source or anchor
distribution. Missing/invalid time, clock rollback, a mismatched tuple or an
expired terminal head fails closed. A failed policy check does not advance the
checked clock; it is the last successful acceptance/check or verified-fork
observation time. Unsuccessful expired checks therefore do not create an
invented successful acceptance timestamp.

## Authentication and staging

The admission boundary meters retained counters plus the **entire presented
batch**, including duplicate inputs, before costly work. Limits are 4096
retained records, 16,777,216 charged bytes, and 262144 bytes per complete frame.
Each record charges exact bare type4 bytes plus its stable validating type2
wrapper. Replays and alternate wrappers count during candidate preflight but
cannot replace the retained wrapper/accounting baseline.

Callers supply both exact frames to make length charging possible before
decoding. After that initial preflight, a bounded `Operation::Generic` pass in
the existing codec checks that each type2 actually embeds the supplied type4.
It opens neither the child nor any curve point/signature. Only after every
pair matches does typed decoding and cryptographic authentication begin. A
dishonest short bare frame therefore cannot undercharge signature work. This
uses the existing canonical parser and aggregate limits, not a second parser.
Reopen similarly meters all raw rows and exact embedded lengths before
authenticating retained signatures.

The private policy authenticates the whole candidate batch, then stages
contiguous same-network/P history. It enforces the installed bootstrap,
predecessor T1, schema/issue ordering, independent exact generation increments
and historical x-coordinate no-reuse, including negation. Arithmetic never
wraps. Every intermediate issue time must be no later than the trusted current
time. Signed one-hour validity windows and relay coverage are checked by the
codec. Expired intermediates may lead to a fresh head; intermediate bindings
do not need to equal today's authenticated tuple.

S10a current/previous stamp state advances at every staged rotation, including
expired intermediates. Renewals and M-only rotations preserve previous stamp.
Only a fresh terminal head matching today's exact relay tuple commits the
staged history. There is no partial head, pair, counter or clock update on
ordinary rejection. Identical current bare bytes are idempotent at the same
time; later successful checks can advance checked time but never expiry.
An older retained exact record is rollback, even in an already-applied batch.
After a lost catch-up acknowledgement, reopen and inspect `current`, or retry
the exact terminal record; do not replay the batch's older prefix as an update.

A competing child is quarantined only after its signature, installed subject,
known predecessor, exact revision/generations, ordering and ancestor no-reuse
checks pass. Invalid signed transitions cannot poison a healthy subject.
A different revision-zero record is not the installed anchor. A verified
competitor against an observed predecessor preserves the previously accepted
head and pair, stores the competitor plus any staged links needed to prove it,
and disables fresh use. Further submissions cannot grow a quarantined store.
If the fork is found during initial catch-up, a marker and proof are stored
with no accepted head. Proof rows count toward both cumulative limits. The
terminal competitor may be historical: cryptographic conflict evidence does
not require a current routing authorization. Fork resolution is external.

## Durable layout and continuity

Three additive column families belong to the existing `Db` owner:

| Family | Key | Value |
| --- | --- | --- |
| `directory_preview_enrollment_v1` | u8 network-byte-length, network, full compressed P | Local version and installed anchor |
| `directory_preview_head_v1` | Same subject key | Versioned metadata, local sequence, head/revision/generations, S10a pair, checked time, counts/charge, fork flag, evidence digest |
| `directory_preview_evidence_v1` | Subject key, u32 slot, u64 revision, exact T1 | One original validating wrapper |

Integers in keys are big endian. Metadata is strict, bounded local JSON; local
storage version 1 is not a wire allocation. The exact bare frame is recovered
from its wrapper without re-encoding. History is stored once per record, not
inside each successor. Accepted rows precede proof-only rows. A single
directory mutex serializes reads, validation and writes within the exclusive
RocksDB owner. All marker/head/history/pair/counter/fork changes use one
`WriteBatch` with `sync = true`. No accepted result precedes successful write.

Each operation rereads the bounded durable state rather than trusting a stale
cached projection. Reopen verifies every signature, chain transition, key-use
rule and proof, then compares recomputed projections, counters and the exact
evidence digest with metadata. Missing marker/head/row, truncated data, wrong
keys, inconsistent derived values, unknown version or excess budget fails
unavailable. Nothing resets, prunes or repairs it automatically. Complete
history is required to reconstruct and compare previous stamp; this store
does not implement the proposal's separately established current-only recovery
mode. Partial loss is not permission to erase previous grace.

An external `Checkpoint` pins network/P identity, installed anchor, exact
accepted head, accepted/retained prefix counts, exact stable-wrapper prefix
digest, checked-time floor and fork status. `Reopen` requires that prefix to
remain present and authentic; it accepts a verified descendant committed after
the caller's last acknowledgement. A pinned fork may never disappear or change.
Foreign identity, older/missing/corrupt prefix or rolled-back checked time
fails. `Checkpoint::for_enrollment` can prepare an external expectation from
the exact signed installed revision-zero candidate and trusted time before the
first write. Its explicit `ProspectiveEnrollment` kind asserts only the exact
anchor evidence/time expectation, so it may reopen that evidence inside a
validated proof-only initial fork quarantine after a lost acknowledgement.
It never asserts an accepted head. `CommittedPrefix` checkpoints retain their
strict accepted-head requirement; they cannot be downgraded to proof-only
state. Both kinds require an actual marked enrollment and exact retained
evidence, so neither creates permission to bootstrap a missing database.

The caller must durably retain checkpoints and new-versus-reopen intent
**outside this database's rollback domain**. Ordinary RocksDB cannot detect
complete disk rollback/deletion on its own. A checkpoint that was itself
rolled back cannot protect later observations. The installed anchor alone
cannot distinguish an old complete valid database. `Db::open` may create its
generic database path; a subsequent preview `Reopen` still refuses missing
enrollment. After a storage error the current handle fails unavailable until
verified reopen. Sync durability depends on RocksDB, the filesystem and device
honoring their guarantees; process-restart tests are not machine power-loss
proof. No existing database is deleted or migrated by this facade.

## Conformance and gates

`cbor/vectors/directory-admission.json` expands the frozen #719 cases into
language-neutral inputs and complete expected accepted/proof history, exact
head, generations, stamp pair, counts, charged bytes, fork state and checked
time. It references exact original frame bytes by pinned source digest and
record ID. Codec rejection categories are represented as `evidence`; history
policy categories are local API errors, not new protocol validation stages.
The mechanical expander imports only the generic codec, not admission policy.
The existing TS proposal oracle remains read-only. Its complete historical
runner fails the intentionally stale frozen-document guards after active
allocation; it is not reported as passing. `directory_preview_oracle.cjs`
hash-pins that original source and replays its unchanged policy functions for
all 102 original outcomes and the shared cases, separately from the obsolete
artifact/generation driver. No source semantics or frozen vectors are edited.

The public-facade Rust gate is `cargo test --locked -p cashweb-registry --test
directory_preview` in `backend/cashweb`, through `.agents/scripts/with-cargo-slot`.
The corpus consistency gate is `node
backend/cashweb/cashweb-registry/tests/directory_preview_corpus.cjs --check`
with the repository's existing Node dependencies.
The separately labeled semantic replay is `node
backend/cashweb/cashweb-registry/tests/directory_preview_oracle.cjs`.
Scoped format/clippy, production-boundary restart/failure/concurrency/resource tests and backend CI
are required before integration. No active route, DM, profile consumer, writer
or default codec context is switched by this enabling stage.

Before adoption, rollback can remove the unused additive facade and namespace
definition while preserving any created records. Once records are relied upon,
changes to their meaning require an explicit migration. Trust provisioning,
client persistence (#749), publication/routes and atomic directory-plus-secret
ownership are separate reviewed successors.
