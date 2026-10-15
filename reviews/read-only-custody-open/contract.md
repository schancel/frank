# H0: read-only custody and vault opening

Root-authored Tier-3 contract. Base `3951bbf2557a31d7380a3ae6b07431f966e031b5`; branch `refactor/read-only-custody-open`. Implementation: dex_inventory, GPT-6.1 Sol medium. Root reviews/integrates independently. Local candidate and disposable browser tests only; no push, merge, deployment, funded activity or user-data deletion.

## Observed issue and outcome

`openAccountCustody` currently creates its absent IndexedDB state store, then always opens the preview vault. `openPreviewVault` writes a persistent capability probe and creates its absent stores before returning. These read-side effects violate the application's hydration invariant and prevent a future retention inspector from safely examining an empty account.

Preserve the public custody/vault methods, account/root schemas, receipt/derivation semantics, authentication and cleanup ownership. Change opening and read methods to inspect existing state without creating namespaces, probing writes, persisting defaults, migrating or deleting records. Authorized first mutations perform required initialization/capability qualification explicitly. Existing valid account and encrypted records remain byte-for-byte unchanged by reads.

## Implementation boundary

Use a guarded existing-only IndexedDB open that aborts unexpected first creation/upgrades. Enumeration followed by an unguarded open is insufficient. Missing state is distinct from blocked/unsupported/corrupt/I/O failure; only genuine absence permits an empty public snapshot or absent reconciliation. An existing malformed database never becomes a new empty account.

`openAccountCustody` validates any existing public state before touching the vault. Defer vault construction until a method actually needs authenticated secret access or an authorized vault mutation. Snapshot inspection must not require opening custody material. The facade owns lazy connections, observes later creation by another instance rather than caching absence forever, and closes connections that finish opening after it was closed.

`openPreviewVault` must not run the write-based capability probe on opening or authenticated reads. Keep necessary crypto/API availability checks without writes. Perform writable-storage/key-round-trip qualification before its first authorized mutation, then initialize its exact namespace when required. Reads of actual stored keys still authenticate and validate them; removing the eager probe must not make failed restoration succeed or return invented roots.

Mutation methods (`stage`, activation/public-state updates, removal/discard fences) retain their existing authority and precondition semantics. A requested discard may need an owned absent-material fence; that is an authorized mutation, not hydration. Read-side reconciliation must not accidentally call a creation path. Existing documented financial/cleanup reconciliation effects remain effects, not disguised read APIs.

Retain all after-await closed/account-revision/receipt checks. Closing during lazy open, crypto or mutation setup must prevent returning live capabilities and must close newly obtained handles. Do not introduce fallback readers, new schemas, root-purpose allocations, compatibility aliases, global storage wrappers or a generic lifecycle framework.

## Exclusive scope

- `packages/account-vault/src/index.ts`, `storage.ts`, existing `types.ts` only if private/open-mode typing requires it without changing the public method contract; its README and `test/suite.ts`, `test/browser.mjs`, `test/node.test.mjs`.
- `app/src/accounts/custody/index.ts`, `persistence.ts`, README, `test/suite.ts`, `test/browser.mjs`.
- Evidence in this directory.

No session reset rewrite, retention holds, operation-secret API, wallet storage, UI or account record format changes in H0. Report additional necessary paths before editing. Retention and destructive-reset guards are separate immediate successors; this prerequisite does not establish them.

## Acceptance and reversal

Use the actual existing Chrome custody and vault harnesses. Record database inventories before/after opening absent facades and reading snapshots/absent receipts: no custody, vault or capability-probe namespace is added. Repeated absent reads through one facade must see a subsequent authorized creation by another instance. Prove first authorized stage still qualifies persistence, survives close/process restart and restores exact root bytes. Existing corruption, missing-key, lost-ack, replacement and cleanup-race cases remain passing.

Add close-during-lazy-open coverage, storage capability failure on first mutation, and unchanged existing valid records under read-only open/authentication. Avoid tests that merely assert helper calls; exercise visible stored state and returned capabilities. Run both real-browser suites, their relevant node gate, and all configured `yarn typecheck:fast` projects. Missing browser capability fails the qualification; do not substitute mock-only proof.

No persisted format changes, so reversal is a coordinated source revert retaining every namespace. Do not delete old capability probe databases as cleanup. Document that opening no longer proves writable persistence; the first authorized mutation establishes that gate. The parent swap outcome remains incomplete until retention, operation-secret storage and runtime recovery are installed and proven.

## Coordinator scope clarification

The coordinator explicitly authorized a narrow correction to `docs/preview-vault-policy.md`
for its eager-probe sentence and directly coupled claims, reflecting first-authorized-mutation
qualification. No broader policy rewrite is authorized.
