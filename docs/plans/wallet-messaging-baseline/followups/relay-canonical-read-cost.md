# [bug] Bound canonical relay history validation outside the shared request mutex

Readiness: NEEDS_SPECIFICATION. The observed mechanism is concrete, but the query/index and scheduling contract must be frozen before dispatch. Owner: repair coordinator with independent security review.

## Observed behavior

Read-only profiling of the reviewed RPC repair running as an unoptimized debug executable showed one CPU near saturation while unrelated relay health/proxy handlers timed out. Stacks show canonical Owner::with holding a synchronous mutex across actions; active_after loads and cryptographically validates retained records before checking whether they are active. Mailbox paging repeats synchronous load/validation under the same mutex. Other Tokio request workers wait on that mutex, including authentication challenge mutation. This is a demonstrated local contention mechanism, not evidence of an infinite loop or upstream RPC failure.

The preserved snapshot had approximately 70 owners, predominantly already delivered. The active scan still traverses retained history to find active work; its result page limit does not bound inspected inactive records or signature-validation cost. Source seams: backend/cashweb canonical store monad_dm_cbor.rs Owner::with, active_after, mailbox/load/validate_canonical_retained; HTTP monad_message_cbor.rs private page; monad_dm_verify.rs context construction. Exact line numbers are revision-dependent.

## Current runtime distinction

The optimized release executable of the same reviewed production source restored healthy operation (observed health response about 21 ms). Do not describe the current optimized runtime as overloaded. Optimization does not remove the history-proportional validation or shared critical section. Local profile and snapshot artifacts are preserved under the ignored repair-relay directory; no signed payloads, keys or endpoint credentials belong in this ticket.

## Expected outcome

A separately frozen bounded change should make active scans and mailbox reads proportional to relevant bounded work and avoid occupying asynchronous request workers with broad synchronous validation critical sections. Authentication, canonical validation, durable indexes and crash consistency must remain enforced. Do not disable validation or infer trusted records merely from a phase flag.

## Acceptance and decision to freeze

- Select the minimal owner/query/index boundary and define how derived data is verified/rebuilt without changing financial authority.
- Demonstrate bounded scan/validation work as terminal history grows while active work stays fixed.
- Verify malformed records, concurrent mutation and restart consistency; no stale index may admit invalid financial data.
- Compare debug and release explicitly; include unrelated request responsiveness under representative retained history.
- Independent architecture/security review before integration.

Deduplication: #1214, #1215 and #1216 cover wallet balance caching, client RPC batching and stamp quoting respectively; they do not own this backend canonical database mechanism. Fresh searches found no matching open canonical relay read-cost ticket. This is not a broad whole-tree performance rewrite.
