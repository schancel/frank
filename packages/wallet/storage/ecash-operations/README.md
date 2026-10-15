# Durable eCash operation-store adapters

Explicit entry points are `createNativeEcashOperationStore` in `native.ts` and
`createBrowserEcashOperationStore` in `browser.ts`. They retain the existing
version-1 `EcashOperationLedger` owner and serialized shape. The app installs the browser factory with namespace discriminator `local-account-v1`.
`EcashWallet` and `EcashChainConfig` require exactly one explicitly borrowed store
or owned factory; no implicit memory/localStorage operation owner remains. Direct
native livecheck hosts require `ECASH_OPERATION_STORE_ROOT` to name an approved
existing directory. Livechecks are opt-in and are not qualification commands.

The host supplies an already validated canonical chain/address and an approved
existing native root or bounded browser namespace discriminator. The existing
`nativeTransactionAttemptKey` remains wallet identity. Storage names are
`frank-ecash-operations-v1-` plus optional browser discriminator and `-`, then the
lowercase SHA-256 hex digest of the UTF-8 wallet key. Native root aliases resolve
to one physical path. The only record key is `ledger-v1`; browser object store is
`ledger`, database version 1. No signing keys or message plaintext are added.

Factories and absent reads do not initialize a namespace. Only the first admitted
put may create it. An interruption after directory/schema creation but before the
first ledger commit leaves a namespace that rejects further opening; there is no
automatic reset, migration, rollover or deletion. Retain that namespace for
explicit recovery. Unsupported formats, extra records and wrong affinity reject.

Every read fetches actual storage and parses a fresh copy. Put validates and
serializes its input before awaiting. Each handle serializes storage work; it
never replaces the wallet's canonical selection lock. Native Level exclusively
locks an opened physical database. Browser callers must use the wallet's existing
`runNativeTransactionExclusive` for read/modify/write across tabs; Web Locks is
required at factory creation. The adapter queue alone cannot prevent lost updates
between independent browser owners.

Native writes use the existing `sync:true` Level helper. Every successful open,
including recovery, fsyncs the database directory before exposing rows; first
creation also fsyncs its parent. Qualified backend: Darwin POSIX filesystem,
Node 26.10.0, level 7.0.1, leveldown 6.1.1, installed LevelDB 1.20. The factory
admits Darwin/Linux POSIX directory-fsync platforms; Linux needs deployment
qualification. Filesystem/device honesty remains required. The installed binding
does not expose `paranoidChecks`; default LevelDB WAL recovery can tolerate
physical WAL corruption. Physical corruption, whole-store rollback, unsupported
platforms and hostile filesystem mutation are outside the stronger durability
claim. Malformed application records still reject visibly.

Browser writes require a strict-durability readwrite transaction, verify
`transaction.durability`, and await transaction completion. Readonly inspection
does not probe write capability. Qualification uses actual Chrome 155.0.8059.40;
other browsers need equivalent qualification. There is no Level-js, localStorage,
memory fallback or production transaction monkeypatch. Profile deletion, browser
storage eviction and whole-store rollback are outside the storage guarantee.

A storage failure poisons the owner before queued work can proceed. A visible
value after a failed acknowledgment does not establish durability. Close the
owner and qualify a new one before reading again. Input validation before storage
does not poison it. `close()` immediately prevents new admission, drains earlier
work and closes the owned handle once, without deleting data.

## Host lifetime and old records

Wallet close synchronously revokes new operations, future signing and exposure.
It drains admitted work before closing an explicitly acquired owner once; borrowed
stores remain the caller's responsibility. Already-started submission may finish
its durable accounting using original signed bytes and claims. Closure does not
prove non-submission, release reservations or authorize replacement payments.
Relays revoke opening and open wallets; ready sessions register relays before
awaiting wallet construction and close them on release. Call session wallet
creation only after the session is ready: initialization/replacement revokes a
pending relay, and its late result cannot publish. Cache reuse checks relay
liveness even when account and revision are unchanged.

The browser factory inspects the exact old
`frank:ecash-operations:v1:${nativeTransactionAttemptKey(binding)}` localStorage key
before admitting new storage. Any presence or inspection failure rejects. Preserve
the original bytes and signed obligations for explicit recovery; do not delete,
reset or move them to bypass the guard. There is no automated migration or dual
writer. Existing native-attempt records retain their separate recovery owner.
Rolling source back must retain new namespaces; once new operations exist, the old
writer cannot safely resume without recovery handling. Swap retention, secret
storage, protocol/runtime and UI remain separate prerequisites.

## Qualification

From the repository root:

```sh
yarn typecheck:fast
(cd packages/wallet && ../../node_modules/.bin/jest storage/ecash-operations/native.jest.test.ts storage/level-durability.jest.test.ts --runInBand)
node packages/wallet/storage/ecash-operations/browser-test.mjs
```

`ECASH_STORE_CHROME` may specify an installed qualified Chrome executable. The
runner bundles only browser code, starts its own disposable local server/profile,
and kills only its own recorded Chrome process. Fixtures contain synthetic
ledger bytes, no usable signing keys and no funded-chain execution.

Native tests exercise real Level writes/reopen, pending/ambiguous acknowledgment,
poisoned queued readers, directory barriers and failures, competing owners,
malformed/interrupted namespaces and close during delayed initialization. Chrome
qualification checks exact bytes/claims/tombstones after process kill/restart,
strict completion versus request success, failed visible acknowledgments,
strict-mode refusal, missing locks, delayed opening/closing, malformed namespaces,
and independent pages serializing updates with the existing canonical wallet lock.
Fault injection is test-only; neither production adapter exposes bypass options.
