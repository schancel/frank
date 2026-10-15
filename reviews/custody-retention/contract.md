# H1: custody operation retention and replacement exclusion

Root-authored Tier-3 contract. Base `d7eb7e37adeca759dfcfd1f13ad740aecb5613a3`; branch `feat/custody-retention`; implementation dex_inventory, GPT-6.1 Sol medium. H0 read-only opening is integrated and independently reviewed. Local candidate only; no push, main merge, deployment, funded operation or user-data deletion. Parent independently reviews.

## Outcome and boundary

Custody presently atomically changes the active account pointer but knows nothing about outstanding financial operations that need that account. Add a narrow durable retention capability in the same transaction domain. Activation cannot replace an account while any operation hold exists. Exact pending cleanup must prove it owns a non-active, unretained target before calling the existing vault discard. This is a predecessor only: no production swap admission, operation-secret API or reset integration until H2 protects destructive reset paths.

Custody owns account-incarnation association and retention admission; the future financial journal owns operation meaning and settlement. A release instruction is trusted authority from that operation owner, never a custody determination that money settled. Do not import swaps, chains, wallets, messaging or UI into custody. No new root derivation, root export, cryptographic protocol, migration or compatibility readers.

## Durable shape and APIs

Keep the existing public CustodySnapshot schema/account key and IDB store layout unchanged. Add exactly one internal key `retention-v1` in the existing `state` object store, containing `{ schema: 1, nextGeneration: number, holds: RetentionReceipt[] }`. A receipt consists of exact `accountRevision`, exact `accountReceipt: VaultReceipt`, `operationId` (existing bounded custody id syntax), and `generation`. The vault receipt is an immutable reference to the incarnation, not a second account record owner. Use safe integers 0..Number.MAX_SAFE_INTEGER for generations; require a checked increment before new admission. Start absent generation at 0. Maximum 64 simultaneously active holds; reject capacity rather than evict. This local resource bound is not a new protocol registry capability.

Add typed methods:

- `retentionSnapshot()`: read-only snapshot of nullable active `{ accountRevision, accountReceipt }`, nextGeneration and active hold receipts. Inspecting absent custody does not create storage. Returned records are caller-owned copies.
- `acquireRetention(intent)`: intent includes exact accountRevision/accountReceipt/operationId and expectedGeneration. Snapshot input before await. Return exact RetentionReceipt only after strict durable completion.
- `releaseRetention(receipt)`: release only the exact incarnation/operation/generation; return `released` or `absent`. A conflicting live generation for the same operation ID is conflict, never deletion. Absent does not imply financial settlement.

Do not increment the existing account revision for hold changes; staged replacement preconditions rely on it. No random hold identifiers: operation ID is supplied by the authoritative operation and generation is the monotonic admission sequence.

## Atomic semantics

All acquisition/release, activation and cleanup authorization read account and retention records in the same IDB transaction. Callbacks remain synchronous inside the transaction. Use a cohesive private typed helper, not a generic storage/lifecycle framework. Parse/validate the complete retention record before deciding absence/eligibility: exact fields/version, bounded array, unique operation IDs/generations, valid exact receipts, safe counter and all live generations strictly below nextGeneration. Live holds must match the current active incarnation; stale/malformed affinity blocks rather than being dropped. Missing key is the pre-H1 empty state; normal APIs never delete or reset the counter after creation.

Acquisition requires exact current active incarnation and open admission (H2 will extend reset exclusion). An existing hold matching the entire original intent returns the original receipt even if unrelated holds advanced nextGeneration. Otherwise expectedGeneration must equal nextGeneration, capacity must remain, and no same-operation conflicting hold may exist. Insert and increment atomically. Preserve the original intent across ambiguous acknowledgment; never silently refresh expectedGeneration and retry.

Release removes only an exact tuple and never decrements the counter. A stale acquisition after release therefore rejects. A fresh-generation admission using the same operation ID is a distinct hold; a delayed release of the old generation cannot remove it. Permanently forbidding reuse of a terminal financial operation belongs to its authoritative journal, not an unbounded custody tombstone set. Document this limit explicitly.

The final replacement activation transaction rejects any live holds before changing active/pending pointers. A retry of an already committed activation may still authenticate and return the existing active pointer; it must not perform another replacement. Staging/cancelling a different pending account does not need to be blocked merely because the active account is retained, provided exact cleanup cannot affect it.

Before each vault discard, transactionally verify the exact current pending record is `discarding`, is not the active receipt and has no matching hold. Existing pending-discarding status prevents that target from activating; acquire admits only the active receipt. Reuse that exclusion and the vault's existing anti-resurrection fences, rather than adding another tombstone family. Preserve final cleanup CAS that clears only the exact pending record. If the target is no longer current, fail or safely no-op according to the original caller's exact outcome; never discard an unowned target.

Verify `transaction.durability === 'strict'` on every affected mutating custody transaction and await completion. Storage failures/blocked opens/corrupt records remain visible. Missing retention after arbitrary store deletion/rollback cannot be distinguished from pre-H1 absence; that is outside this bounded store guarantee. H2 must preserve this record and durable reset generation instead of deleting/recreating custody. H1 alone does not make existing reset safe.

Close checks from H0 remain before and after awaits; no live capability or successful acknowledgment escapes a closed facade. Already-started authorized transactions may commit despite caller revocation, with retry reconciling the original intent. Read-only hydration must not create default records, run write probes or clean up.

## Scope and proof

Allowed: app/src/accounts/custody/{index.ts,persistence.ts,types.ts,records.ts}, a cohesive private retention.ts if useful, README and existing test/{suite.ts,browser.mjs}; narrow new custody tests; review evidence. No vault source/schema, session/reset/UI, wallet storage or swap code. Public type exports may expand only for these methods/receipts. Existing consumers may require typed test doubles updated solely for new methods; report paths before editing outside custody.

Use actual Chrome custody harness with independent tabs/handles sharing one namespace. Prove hold versus replacement races serialize: either exact hold exists and replacement rejects, or replacement commits and stale admission rejects. Exercise two concurrent admissions at one expected generation, exact acquisition retry after delayed/lost acknowledgment, release/reacquire/delayed old release, old acquisition retry after release, counter exhaustion/capacity, wrong account/receipt, corruption, unsupported strict durability, and retained holds across process restart. Ensure delayed cleanup cannot delete a retained or active root; actual root restoration remains exact after refused replacement. Hold changes must leave staged account revision/preconditions intact. Validate absent inspection preserves database inventory and existing valid records are unchanged by reads.

Run existing custody browser suite and all configured typechecks; existing vault node/browser gates only if dependency changes justify them (no vault source change expected). Use boundary tests, not just transaction-helper call assertions. Record commands and limits. Removal/reversal requires retaining retention records and teaching any older writer to refuse before replacing accounts; do not advise rollback to pre-H1 activation while holds exist. H2 reset admission/deletion cleanup is the immediate successor and must be complete before any operation acquires holds in production.
