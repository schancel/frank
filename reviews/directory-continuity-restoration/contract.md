# WL-1S: retain directory continuity on restoration failure

Authorized local correction; base61c6d468a1911f05fb469a4d28c512fb049ef78a. Exclusive implementation claim directory_continuity_restoration owns the finite paths below. Independent review and parent integration required. Source investigation: white-label plan99221f50 and current parent trace; record runtime fail-before evidence before claiming fixed.

## Failure and outcome

open-directory.openHandle swallows checkpoint load/reopen failures, clears checkpoints, calls discard and retries new enrollment. admitOwn clears pins/checkpoints and deletes admission stores on invalid/fork/rollback to accept relay history. Browser directory-store-reset unconditionally deletes without checking enrollment and reports success on blocked/error. App production persistence adapters swallow failures, and startMessaging entry-refused branch saves empty pin/pending values. Node supplies recursive discard callbacks. These defeat existing directory-admission continuity: a revision-zero anchor cannot recover a previously accepted high-water mark or fork quarantine from an older signed relay prefix.

Preserve trusted pins, checkpoints, pending authorizations and admitted history on restoration/refusal failures. Surface typed, visible failure; never grant current routing or install messaging through fallback new enrollment. Genuine first contact still works. Interrupted first enrollment must remain bound to its chosen anchor: resume only if existing public continuity APIs prove it safe, otherwise visible unresolved restoration with all evidence retained. Do not manufacture permission for another anchor or silently reset unknown state.

## Owners and finite edit scope

Directory-admission remains trust-state owner; cashweb composes admission and owns external checkpoint/pin lifecycle; app/Node adapters persist those exact facts and propagate errors. No new store, wire format, key derivation, namespace or migration. Rebuildable memory caches are not authority to erase trust.

Production paths:
- packages/cashweb/relay/open-directory.ts: openHandle/pinnedHandle/admitOwn and directly required first-contact/persistence error handling; remove automatic reset/reenrollment behavior. Preserve ordinary valid renewal/publication and peer lookup semantics.
- packages/cashweb/relay/open-directory-node.ts: remove obsolete deletion callbacks/types/imports when caller removal makes them unreachable. No unrelated legacy file-layout refactor.
- app/src/utils/monad-identity-session.ts: concrete checkpoint/pin adapters and entry-refused clearing only, plus narrow extraction into a co-located persistence adapter if needed for actual production-path testing. Preserve negotiation lifecycle, readiness API and signer/session behavior.
- app/src/utils/directory-store-reset.ts: remove obsolete helper once all live automatic-reset callers are removed; do not replace it with unverified empty-store deletion.
- Focused corresponding cashweb/app tests, minimal fake-relay instrumentation, and reviews/directory-continuity-restoration/*.md. Public dependency callback removal must update all actual callers/tests together; report unexpected additional production consumers before expanding.

Explicit exclusions: app/accounts/session.ts, chats, directory-peer, swap UI/protocol/runtime/scanner, custody, wallet inventory and admission storage internals. Signed UI owner acknowledged no edits to these directory files; it owns session/chat/feature work. Empty-mailbox fix owns scanner/runtime. No reader extraction, brand configuration or relay-adoption redesign in this correction; those are successors.

## Behavioral constraints

Load exceptions and malformed persisted values are not absence. Failed reopen cannot clear a checkpoint or change intent to new. An existing pin plus missing committed continuity is not proof of a fresh account. Distinguish newly authorized first-contact creation in the current call from restoration using explicit internal intent, not a fallback. Do not mechanically postpone pin save: preserve partial enrollment ownership and explain interrupt boundaries. Every required pin/checkpoint save failure prevents success. Retain fork evidence. Remove unused destructive callback APIs rather than retain compatibility stubs.

A lost acknowledgement may leave a committed fact; reopen/reconcile it through existing authority or fail visibly without deletion. No network waits under storage locks. Existing unrelated account/chain records remain isolated. Pending signed directory writes must not be erased on refusal or reissued as a new revision-zero chain.

## Acceptance

- Fail-before/pass-after actual openDirectory with real admission storage: later accepted head and separately fork quarantine, then checkpoint read/write failure, missing checkpoint/DB or failed reopen while relay serves an older valid signed prefix. No erase/re-enroll or successful older current; preserve trust records and typed failure.
- Browser production adapters must be exercised (not merely injected successful mocks). Pin/checkpoint load/save errors propagate to visible messaging failure; no installation/message effects after failed admission. No automatic deletion invocation, including previously blocked/error deletion scenario. Keep existing account custody untouched; no claim of new full activation route gate.
- First contact and valid renewal/peer reads still work. Interrupted pin/checkpoint/enroll writes do not choose another anchor; explicit unresolved state is acceptable when safe resume cannot be proved, and must not be presented as success. Restart evidence required.
- Remove tests endorsing destructive self-healing and replace with exact preservation/failure assertions. Existing directory-admission continuity/no-reset gates remain green. Tests must fail against original control flow; real browser qualification where IndexedDB behavior is claimed, synthetic owned storage only.
- Focused cashweb/app directory suites, affected bot/Node callers, all25 typechecks, dependency/format checks. Do not run unrelated exhaustive tests without reason.

No durable format change planned. If existing APIs cannot represent required first-contact/reopen intent, stop with concrete evidence and propose a separate format contract; no hidden default/migration/reset. Source rollback reintroduces defect but does not rewrite retained records. No external services, keys, funds, package installs, shared dependency edits, main merge, push, deployment, cleanup or agent attribution trailers. Use candidate-owned overlays and provide clean frozen commit/evidence for review.
