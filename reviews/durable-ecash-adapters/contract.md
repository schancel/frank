# Q3a: durable eCash operation-store adapters

Root-authored Tier-3 contract. Exact base `3951bbf2557a31d7380a3ae6b07431f966e031b5`; branch `feat/durable-ecash-adapters`. Implementation owner: blackjack_evidence, GPT-6.1 Sol medium; independent review/integration: root. Local commits and disposable synthetic tests only. No production funds, deployment, push, merge, deletion of existing user data or release-hold change.

## Outcome and ownership

Implement concrete browser and native durable adapters for the reviewed asynchronous `EcashOperationStore`. Each adapter is bound to one canonical chain/wallet and the existing `nativeTransactionAttemptKey`. One version-1 ledger retains the same operation/claim/transaction/change/tombstone/receipt authority. No schema migration, competing inventory or application state cache. Factory inputs are host-approved location/namespace and wallet-validated canonical chain/address; reject wrong key and ledger affinity on every operation. No aliases/default network.

Use explicit browser/native factory entry points so a browser bundle does not import native filesystem code. Factories return an owned closeable store; resource ownership remains with the caller. Q3b separately installs the factories, closes/revokes wallets, removes implicit memory/localStorage defaults and checks old records. Q3a does not change production composition or claim swaps are crash-safe yet.

## Layout and admission

Use one bounded deterministic namespace per wallet, derived from SHA-256 of the existing wallet key, with an explicit versioned eCash-store prefix. Native location is under the caller's existing approved root; resolve its canonical physical path before opening. Browser namespace also incorporates the caller's bounded namespace discriminator. Document the exact name derivation and record key beside the implementation. This is a storage location, not a replacement wallet identity. Persist only the unchanged serialized ledger, with no keys or message plaintext.

Creating a factory/reading an absent namespace must not create persistent storage or defaults. Native: inspect existence before constructing Level (which auto-opens); only genuine absence returns undefined. Existing malformed/incomplete namespace or inspection failure is visible. Browser: directly use IndexedDB with an existing-only open that aborts unexpected creation/upgrades; do not rely on an enumeration snapshot followed by an unguarded Level open. No global monkeypatch. Authorized first `put` may initialize the namespace. Document and test interruption during first creation; never silently reset an existing malformed store.

## Durable operations and lifecycle

Serialize adapter-local reads/writes through a short queue; authoritative reads fetch actual storage and parse fresh copies. Wallet's existing canonical selection lock still owns multi-instance read/modify/write. Validate/snapshot caller data before asynchronous work so mutation cannot change admitted contents. No asynchronous fire-and-forget write.

Native uses the existing Level dependency and `sync:true` write helper. Observe initial open completion, then fsync the database directory after EVERY successful native open/recovery, and the parent when creating a new namespace. With installed LevelDB's default non-reused WAL recovery, this closes the post-rename directory barrier before recovered rows are exposed. Do not invent a `paranoidChecks` JS option: the installed binding does not expose it. Qualify the actual installed POSIX backend; explicitly exclude physical WAL corruption/whole-store rollback and unsupported platforms from stronger guarantees. Malformed application records and wrong affinity must still fail visibly.

Browser uses strict-durability readwrite transactions, verifies the transaction's durability property and awaits transaction completion, never request success. Normal reads use readonly transactions. Require the supported browser capability and Web Locks availability; the adapter queue is not a cross-tab selection lock. Existing-only reads need no write capability probes. No memory/localStorage fallback.

Any storage operation failure poisons the handle before its queue is released; queued/subsequent authoritative operations reject. A visible value after failed persistence is not proof of durability. Close the poisoned owner completely and requalify a new owner before rereading. Input validation failures before any storage access need not poison it. Native reopen completes the engine/directory barrier; browser reopen observes committed transactions. Do not rewrite application rows merely to open them.

`close()` synchronously prevents new admission, drains already admitted storage work, closes the owned handle exactly once and never deletes data. A concurrent first-open/close cannot leak a usable owner. Borrowed-store behavior belongs to Q3b, not a new generic ownership framework here.

## Scope

Allowed new directory `packages/wallet/storage/ecash-operations/`: small common helpers/types, separate browser/native adapters, focused Jest tests, browser fixture/runner and README. Existing `packages/wallet/storage/level-durability.ts` and its Jest test may receive only the narrowly required reusable native post-open directory barrier if useful; do not change other stores' behavior incidentally. Evidence in this directory. No other source, package/dependency manifest, registry, custody, wallet algorithm or host composition edits without root's scope update.

Prefer a few cohesive files, no backend plugin framework. Use existing dependencies and browser harness conventions; a documented direct `node` runner is sufficient without package-script changes. Own temporary Chrome profiles and synthetic native namespaces only; retain evidence, never clean another task's resources.

## Acceptance

Prove fresh/copy-isolated reads, exact affinity, absent hydration leaving namespaces absent, acknowledged signed bytes/claims/change/tombstones surviving native close/reopen and real Chrome process restart, pending writes blocking reads, failed/visible writes poisoning queued readers, successful qualified reopen, strict-durability refusal, malformed/unsupported namespace refusal, competing native owner refusal, and close during delayed initialization/write. Browser independent contexts must see fresh committed rows and serialize a ledger update using the existing canonical wallet lock; full actual-wallet selection integration belongs to Q3b.

Tests must exercise actual Level and actual disposable Chrome for their respective qualification; mocks alone are insufficient. Use narrow fault seams where needed for failed fsync/transaction acknowledgments, with no production bypass switch. Include exact supported runtime/backend versions and commands. Run focused new suites plus the existing durability tests and all configured `yarn typecheck:fast` projects. No expensive native-chain experiments are needed.

Reversal removes the uninstalled adapter while retaining its exact namespace for deliberate recovery; no reset/migration or automatic namespace rollover. Host integration is the immediate required successor before any production path may claim durable eCash swap preparation.
