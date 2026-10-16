# Retained HD funding provenance

Parent-authorized implementation contract for the accepted reorg-recovery program. Base `96c815df75c6f402e9220a28fc275fadb2d8d22d`; branch `fix/hd-funding-provenance`; independent review and local integration remain parent-owned. No main merge, push, deployment, live RPC/funds, private configuration changes, resets or cleanup.

## Feasibility disposition

The required predecessors (`authoritative-pool-mutations` and `funding-observation`) are integrated on base `96c815df75c6f402e9220a28fc275fadb2d8d22d`. Production and schema implementation are authorized under this contract, including the row-owned multi-funder preparation hold/completion boundary identified in `feasibility.md`. All funding outcomes below are required.

The pool store now provides one coordinated durable mutation boundary (`store.mutate`) with revision compare and uncertainty fencing, and `MonadAccountTxSigner.observeFunding` provides anchored receipt and account observation.

For multi-funder preparations, the target sub-account stays `funding` under a durable row-owned preparation hold until the live caller verifies inclusion of all contributions and explicitly marks preparation complete. Interruption before signing or completing a later contributor leaves the row held in `funding` across reopen without manufacturing authority for unsigned future transfers.

## Current and target ownership

`MonadSubAccountPool.finishFundingAttempt` clears exact signed funding bytes when making a row available or retired. Its positive-balance fallback may make the row available without a receipt for the original funding transaction. `recordFundingTransaction` has no production callers. The installed multi-funder burn path funds one HD target several times, so singular lifecycle funding cannot represent the actual history. Spent/retired records already exist and must remain excluded from selection.

The pool row and its existing terminal projection remain authoritative for HD funding provenance; the signer supplies verified observations, never mutates the store. Introduce one retained collection of local funding attempts owned by the row, replacing the transient/singular funding authority. Retain exact original signed bytes before exposure, through success, failure, supersession and restart. Derive transaction facts from signed bytes; do not maintain independently mutable duplicate transaction identities. Native operation journal, received coin store and change pool keep their distinct ownership.

## Frozen behavior

Each attempt retains raw transaction, transaction hash, a safe-integer observation generation and explicit observation. Observation distinguishes unresolved (`pending`, `unavailable`, `unknown-execution`, `inconsistent`), successful or reverted canonical inclusion (height/hash), and supersession supported by a pinned sender nonce. Retain the pinned account observation (height/hash, sender nonce, recipient nonce/balance) that justifies a terminal transition. Deduplicate exact transaction replay; reject conflicting bytes for an identity. Appending a contributor preserves every prior attempt. Failed RPC reads cannot erase existing verified inclusion evidence. No automatic reorg downgrade is installed here.

Pending/missing receipt plus positive recipient balance remains unresolved and `funding`, not selectable. Unknown receipt execution remains unresolved. Only a successful receipt bound to the exact transaction, canonical block and pinned account evidence may permit the existing available transition. Revert or proven supersession retains its artifact and evidence before retirement. Receipt/block mismatch during reads refuses the observation and retains the original operation for retry. Reconcile original bytes; no replacement funding is authorized by timeout or failed verification.

The signer must provide a narrow funding-observation capability using its existing receipt client and captured provider. Do not reuse status-only `getStatus`, which collapses unknown execution into confirmed. Validate receipt transaction identity, block number/hash and execution. Pin nonce/balance reads to one canonical block and recheck its hash after reads; validate receipt ancestry/canonical block as needed. No new transport, generic observer framework or cached success certificate. Preserve unrelated `getStatus` consumers. Reads remain outside storage/admission coordination and respect the owning operation lifetime.

Registering an attempt validates signed hash, captured signer/sender, exact HD recipient, plain-transfer data, positive value and the expected native chain ID from canonical wallet configuration. Restart validates against the same expected chain and derived HD recipient, without assuming every funder is the main account. No default chain ID or network alias. Add narrow configuration forwarding only where required.

Conditional evidence completion must compare captured attempt identity and generation against authoritative current state after coordinated reload, preserving concurrent later contributors and lifecycle facts. Changed evidence increments generation atomically; identical replay is idempotent; overflow refuses mutation. A delayed completion must not overwrite an intervening accepted observation, including A→B→A. Do not treat an instance cache as durable cross-wrapper authority.

Multi-funder interruption is part of this packet: completed contributors remain durable while the next exposed contributor is unresolved, and interruption before a later contributor signs retains the preparation hold so the partial target remains `funding` and excluded from selection and input admission. Reopening resumes only already signed funding obligations; it must not invent/repeat earlier contributions, authorize unsaved later ones, or auto-release an incomplete multi-funder hold. This packet does not promise atomic rollback of independently submitted contributors.

## Format and reversal

This is an intentional incompatible pool baseline, not an optional legacy fallback. Use an explicit versioned funding collection; update actual pool loading/validation and terminal checkpoint projection together. Replace singular funding references in consumers. Preserve spend checkpoint representation and unrelated recovery facts. Terminal projection must retain all funding attempts and anchors, and cannot compact unresolved obligations away.

Choose wallet manifest version 4 with its explicit new pool intent (`sub-account-pool-v4-funding-evidence`) and the existing current change-pool intent (`change-pool-v2`). Accept only that new manifest baseline in this changed path; do not dual-read old pool provenance or invent empty histories for old funded rows. Preserve old manifests, keys, records and signed artifacts and refuse clearly; document that owner disposition is required before release. No new empty namespace, automatic migration or destructive reset. A new-format row with no locally authorized funding may represent that fact explicitly; do not claim it has proven external funding provenance. Existing imported/sync-only terminal facts remain distinct from locally verified settlement and must not be silently discarded.

The cost of reversal is durable-format incompatibility: reverting code after writing new records cannot safely restore the old reader. Release remains held. The immediate successor is typed native-spend reorg holds and owner-specific funding reconciliation, followed by head-driven targeting; this collection must preserve the artifacts those operations need. No numeric retention horizon or new compaction policy is selected.

## Exclusive scope

Production: `packages/wallet/monad-account-tx.ts`, `monad-account-pool.ts`, `evm-input-admission.ts`, `storage/sub-account-pool-storage.ts`, `storage/level-sub-account-pool-store.ts`, `storage/monad-wallet-state-validator.ts`, necessary manifest/terminal/captured-chain forwarding in `storage/monad-wallet-bundle.ts`, and narrow factory forwarding in `chain/monad-chain.ts` if required. Relevant signer/pool/store/validator/bundle/factory tests and documentation are allowed. No app UI, protocol codecs, received-coin or change-pool redesign, all-send identity gating, generic migration cleanup or mechanical naming rewrite. Report additional production needs before edits.

## Acceptance and handoff

Pin actual-base loss through installed funding completion, including two funders to one target. Prove successful/reverted/superseded attempts survive repeated close/reopen and terminal projection; the second interrupted contributor retains the first; positive balance with missing receipt and unknown execution remain held; wrong hash/sender/recipient/native chain or malformed evidence refuses before eligibility; same-height replacement and stale concurrent completion cannot overwrite newer facts; failed durable writes cannot expose eligibility or permit duplicate payment; unresolved physical requests do not authorize another funding operation; unrelated accounts remain usable. Validate actual selection/admission and persistent store paths, not only serialization helpers. Test preservation of existing signing/derivation material and incompatible-format refusal without writes.

Run affected suites, all configured `yarn typecheck:fast` projects, source/diff checks and relevant format/ownership tests. No live funded test is required. Coordinate the broad typecheck slot. Use existing local dependency overlays only; no installs/shared mutation. Record fail-before/final commands, exact scope, compression pass, observed limitations and format disposition in committed evidence. Freeze a clean candidate for independent review; no integration or agent attribution trailers.
