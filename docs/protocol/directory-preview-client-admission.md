# Client preview directory admission

The additive `@frank/directory-admission` package mirrors the
[Rust admission policy](directory-preview-admission.md). It is unused by runtime
consumers. Its implementation starts at the independently reviewed #748
checkpoint `82cd294f89236aac71f743d057c344439a6f8c87`; #749 remains held until
the actual #748 implementation lands and this client is rebased and retested.
No structural codec result, profile record or supplied projection becomes
directory authority. Consumer restore/routing and publication remain #696/#750
successors; public atomic storage does not implement atomic secret custody.

## Facade and trust inputs

The root entry exports public types. Browser and Node entries export
`openBrowserDirectoryStore` / `openNodeDirectoryStore`, `AdmissionError`, and
those same types. Each handle owns one dedicated database for one explicitly
installed network, full subject P, and exact revision-zero type4 T1. Browser
names and Node locations are caller choices, never network authority.
There is no global database registry: callers must remember enrollment and
continuity per `(network, P)` across namespace names and locations. Changing a
namespace does not make a previously enrolled subject new or permit resetting
its history budget. Each store validates the complete retained history of its
one subject; multi-subject physical database grouping is outside this facade.

| Operation                 | Result and boundary                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Open `new`                | Requires a missing dedicated namespace; validates the installed anchor; grants no current authority                                              |
| Open `reopen`             | Requires an existing enrolled namespace and caller-maintained continuity checkpoint; fully validates history                                     |
| `checkpointForEnrollment` | Prepares a prospective exact-anchor expectation before the first enrolled commit; grants no fresh authority                                      |
| `enroll`                  | Requires explicit new-subject intent, complete ordered signed candidates and fresh trust context; marker and accepted history commit together    |
| `advance`                 | Requires existing enrollment; privately validates the complete ordered batch and commits only a fresh terminal head, or verified-fork quarantine |
| `current`                 | Revalidates durable state and current trust inputs, durably advances checked time and then returns a point-in-time snapshot                      |
| `historicalEvidence`      | Returns only exact retained accepted evidence, visibly marked historical                                                                         |
| `conflictEvidence`        | Returns bounded historical proof rows, without head or fresh authority                                                                           |
| `status`                  | Returns null for unenrolled state or an explicitly historical description and checkpoint; never freshness                                        |
| `close`                   | Drains queued operations and closes the owned handle                                                                                             |

Candidates include exact type4 and type2 bytes so both lengths can be charged
before decoding. A bounded generic codec pass checks that each wrapper embeds
the exact supplied statement. Only then does
`verifyPreviewDirectoryEvidence(bytes, expectedNetwork)` authenticate owned
bytes and recompute exact T1. Neither production entry imports proposal tools,
wallet/account custody, a Rust service or a second signature/parser engine.
Input copying occurs before yielding to queued work; returned arrays are copies.
Known byte fields are bounded by their view lengths and copied into exact-length,
ordinary `Uint8Array` allocations, including shared-buffer-backed input views.
The copy never clones the caller's entire backing buffer. Relay optional fields
use only the codec's bounded data vocabulary; authenticated retained wrappers
come from the codec-owned verified frame.

Every successful fresh result requires explicitly supplied trusted Unix time
with bigint seconds and exact nanoseconds, plus the previously authenticated
exact HTTPS relay ID/endpoint/identity/expiry tuple. The caller owns the trust
provenance, relay-ID algorithm and distribution. No URL-derived trust,
self-signature bootstrap, ambient clock, loopback exception or network fetch
exists. Public type annotations do not protect against arbitrary malicious
same-origin/process code.

Policy matches C1–C14 and the shared #748 corpus: contiguous uint64 revisions,
exact predecessor, nondecreasing issue/schema, independent exact generations,
all historical role x-coordinate no-reuse including negation, and fresh terminal
binding. Expired intermediate links may lead to a fresh terminal head. Every
staged stamp rotation contributes to S10a current/previous; renewals and M-only
rotations preserve previous. There is no retired-M new-use grace. The full
history is required; this store has no partial-loss/current-only recovery API.
Valid remote uint64 generations are not restricted to local derivation indices.

Retained state plus the **whole presented batch**, including duplicates and
alternate wrappers, must fit 4096 records and 16,777,216 charged bytes. The exact
bare statement plus one stable validating wrapper is the charge. Both complete
frames are limited to 262144 bytes, with codec aggregate limits also enforced.
Duplicate current statements never replace stable stored wrappers or extend
expiry/grace. Older exact retained records reject as rollback. Retry a lost
catch-up acknowledgement by reopening/checking current or resubmitting the
terminal record, not an older prefix. There is no pruning or cap reset.

A fully authenticated competing child of a known predecessor persists bounded
proof and disables fresh use. A fork discovered during initial enrollment can
retain only proof and an enrollment marker, without any accepted head. Invalid
transitions/signatures cannot quarantine a healthy subject. Ordinary rejection
changes no head, stamps, counters or successful checked time. If durable fork
recording fails, that handle becomes unavailable until verified reopen.

## Versioned local records and transactions

Both backends store the following string key/value records. These are local
format version 1, not new wire fields or hash transcripts. One dedicated
namespace isolates full network/P identity; `marker` pins both, without delimiter
ambiguity. A new namespace may contain only `format` before enrollment.

| Key                                                | Value                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `format`                                           | `directory-admission-v1`                                                                                                 |
| `marker`                                           | Strict version/network/full-subject/anchor JSON                                                                          |
| `head`                                             | Strict version/identity/anchor/sequence/head/revision/generations/stamps/checked-time/counters/fork/evidence-digest JSON |
| `e:<8-digit slot>:<20-digit revision>:<64-hex T1>` | One original stable wrapper encoded as lowercase hex                                                                     |

Integers use canonical exact decimal strings, except bounded counts and
nanoseconds. Exact type4 is extracted without re-encoding from the wrapper.
History is stored once per retained statement; no row embeds prior history.
Opening and every operation read a bounded consistent snapshot, validate raw
lengths before signatures, reconstruct all links and stamps, and compare every
derived metadata field and evidence digest. Missing/truncated rows, unknown
versions, extra rows, invalid signatures, counter disagreement or previous-stamp
loss fail closed. There is no reset, migration or projection-based repair.

Browser storage uses native IndexedDB object store `records`. All writes use a
`readwrite` transaction requesting `durability: 'strict'`, check the transaction's
reported durability, and resolve only on transaction completion. The open path
proves the same capability. Crypto runs outside write transactions. A single
strict write transaction rereads the bounded snapshot, compares every exact row
(including sequence), and atomically writes added evidence plus marker/head.
Native transaction scope serializes across tabs/connections. A stale comparison
aborts with `retryable`; callers retry the entire operation to reload and
revalidate. There is no stale staged-successor retry or process-local substitute
for cross-tab exclusion. Even an unchanged `current` performs this comparison.
Abort/quota/blocked-open/version-change/close failures yield no fresh result.

Node storage uses the existing pinned Level 7/native LevelDB stack in an
absolute dedicated directory. The parent must exist; initial creation performs
a synchronous format batch and fsync of the directory and parent. The native
exclusive lock excludes other handles/processes. Every operation is serialized
on the one private handle; evidence/head/stamps/counters/enrollment use one
`{ sync: true }` batch. Reopen uses `createIfMissing: false` and first checks
existence. No memory fallback, wallet durability helper, raw handle or public
pluggable storage API is exposed. Backend failures invalidate the handle.

## External continuity and limitations

Checkpoint fields follow the reviewed #748 semantics. Identity is SHA-256 of
the unambiguous length-prefixed network and full P. The evidence digest hashes,
in retained order, each big-endian uint64 revision, 32-byte T1, big-endian uint64
wrapper length and exact stable wrapper. It binds the accepted/proof prefix,
not merely the selected head.

`ProspectiveEnrollment` asserts exact installed revision-zero evidence and a
trusted checked-time floor prepared before enrollment. It can reopen that
evidence in accepted history or a validated proof-only initial fork quarantine;
it never asserts prior accepted-head authority. `CommittedPrefix` asserts the
previously observed accepted head/prefix, retained proof prefix, checked-time
floor and fork state. Descendant commits after lost acknowledgement may reopen,
but an accepted head cannot disappear and a pinned fork cannot change or clear.
Both kinds require real complete marked enrollment; neither bootstraps missing
storage. The complete checkpoint is caller trust configuration, not a receipt
self-authenticated by the same database.

Callers must retain checkpoints and new-versus-reopen intent outside this
database's rollback domain. An anchor alone cannot detect replacement with an
older complete valid database. Ordinary IndexedDB/Level cannot independently
detect complete disk rollback/deletion, nor resist malicious same-origin or
same-process code. A rolled-back checkpoint cannot protect later observations.
There is no automatic reenrollment after eviction. Interrupted empty-namespace
creation may require an external disposal decision; this package deletes nothing.

Strict/sync acknowledgements rely on the browser, LevelDB, OS, filesystem and
device honoring their guarantees. Process termination tests prove restart
behavior, not machine power-loss durability. WebCrypto SHA-256 is required for
local continuity digests (a secure browser context and supported Node runtime).
Before adoption, rollback removes this unused package/workflow while preserving
created databases; after adoption, durable format changes need explicit migration.

## Verification

The package's dedicated CI runs typecheck, format, dependency boundary, the
shared 71 policy cases and nine probes, real native Level restart/failure/lock
tests, public-boundary shared-buffer/bounded-view ownership regressions, and real
Chromium persistence/race/failure tests. The shared corpus and
actual signed retained-history count/byte cap tests exercise production policy
and storage rather than only synthetic counters. The corpus and
frozen source bytes remain owned by #748 and unchanged here. The Rust public
gate remains `cargo test --locked -p cashweb-registry --test directory_preview`
in `backend/cashweb` via the repository cargo-slot wrapper. Existing codec
directory tests and browser boundary regression remain required. A missing
browser or unrun Rust gate must be reported as not run, never as passed.
