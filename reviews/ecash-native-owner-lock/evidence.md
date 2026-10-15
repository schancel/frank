# Native eCash ownership repair evidence

Accepted base: `7da57168a500fe2f1da3fc72cd0d18ad653d9797`.
Root-authored contract/start: `5c47839fa45e8724399c99049b5f2cc50a4c359d`.
Frozen tested source: `0ba0a7110664861e19b2bde855dbccf7e14c431f`.
This evidence-only successor changes no executable source. Tier 3; requested and
selected implementation lane GPT-6.1 Sol medium. Independent review and local
integration remain the parent's next steps; neither is claimed by these gates.

## Defect and bounded repair

The required fail-before regression ran against unchanged base production source
with an actual adapter in the parent and an actual adapter/Level in independent
children. The first owner writes the synthetic ledger and stays live throughout:

1. First child is excluded by the actual OS lock.
2. A second adapter through a physical-root symlink rejects opening, becomes
   poisoned, and is closed.
3. A second child unexpectedly opens the original ledger while the first owner
   remains live. The assertion expecting `locked` fails at line 121 of the initial
   regression. Exit code 1; this is recorded as a failed regression, not a pass.

Log: `/tmp/frank-ecash-owner-fail-before.log`. The independent earlier review
probe was used only as an investigation lead; its existing database/artifacts were
not modified. All new evidence uses owned synthetic temporary databases and
children, without keys, funded transactions or network calls.

The production change is 13 added lines in `native.ts`. A private loaded-module map
uses the existing realpath-resolved root plus canonical wallet namespace. Each
adapter owns a unique symbol. It checks existing ownership before inspection and
checks/claims again without yielding after asynchronous inspection, before mkdir
or Level construction. Thus alias and first-initialization races cannot construct
a second same-process Level handle. Successful absent reads return before claiming
anything. Actual Level OS locking remains intact for separate processes.

Only the acquiring symbol can remove its map entry, after actual handle close
succeeds. A rejected duplicate has no handle/token to release. Constructor/open or
post-open validation/fsync failures remain observable and poisoned until close;
cleanup releases that owner's claim only when successful. Failed actual cleanup
rejects close and retains the fence. StoreQueue's existing admitted-work drain,
poisoning, admission revocation and memoized close behavior are unchanged.

Ownership remains `createNativeEcashOperationStore`; ledger schema, namespace,
affinity, durable writes, reservations and custody do not change. No browser,
common queue, other adapter, dependency, migration or sibling worktree source
changed. Reversal changes source only and preserves ledger bytes.

## Gates and exact outcomes

All final commands exited naturally with code 0, using candidate-local Frank
links and existing installed dependencies on Darwin, Node `v26.10.0`, Level
`7.0.1`. There was no dependency update.

| Gate | Result |
| --- | --- |
| Expanded native ownership/durability suite | 12/12 pass |
| Affected wallet/native/storage selection | 9 suites, 102/102 pass |
| `yarn typecheck:fast` | All 23 configured projects pass |
| Scoped format checks | Pass |
| `git diff --check` | Pass |

Native acceptance includes:

* The actual fail-before child regression now passes: child remains locked after
  the aliased rejected duplicate closes while the first owner still lives. Once
  the first owner closes, a child opens and reads the exact original ledger;
  a subsequent raw read verifies exact persisted JSON bytes before adapter reopen.
* An absent reader reserves no namespace and cannot release a later owner's token
  when its own competing access rejects and closes.
* Competing first initialization rejects while the first owner is paused before
  directory creation. Closing that rejected adapter leaves the first claim and
  eventual actual OS lock intact.
* An injected constructor failure releases its own claim after cleanup and leaves
  the original ledger unchanged. This injection proves the error branch, not OS
  exclusion; the independent-child cases supply actual OS-lock evidence.
* An actual independent child holds the database. Parent adapters receive real
  Level LOCK errors, close their own failed handles, and may try again without a
  stale module claim. The child stays excluded from parent takeover until its
  own close; parent reopen then reads the exact original ledger.
* Injected uncertain close leaves the actual handle open and rejects observably.
  A competing adapter rejects and cannot drop the token; an independent child
  remains OS-locked. The test separately closes only its captured synthetic real
  handle for resource cleanup, without claiming facade recovery or token release.
* Existing post-recovery fsync, malformed/foreign record validation and successful
  cleanup/reopen cases pass. Invalid persisted bytes are never reset by the
  adapter. The test's explicit synthetic restoration permits qualified reopen.
* Close during delayed initialization revokes new admissions but keeps ownership
  through queued writes/reads. A rejected competing adapter and its cleanup do
  not release that owner. After drain/close, reopen preserves the original ledger.

Commands from the candidate root:

```sh
node_modules/.bin/jest --config packages/wallet/jest.config.js --runInBand --runTestsByPath packages/wallet/storage/ecash-operations/native.jest.test.ts -t 'rejects competing native owners'
node_modules/.bin/jest --config packages/wallet/jest.config.js --runInBand --runTestsByPath packages/wallet/storage/ecash-operations/native.jest.test.ts
node_modules/.bin/jest --config packages/wallet/jest.config.js ecash-wallet.jest.test.ts ecash-preparation.jest.test.ts ecash-stealth.jest.test.ts ecash-seed-boundary.jest.test.ts ecash-operation-store.jest.test.ts chain/chain-factory.jest.test.ts chain/utxo-family.jest.test.ts storage/ecash-operations/native.jest.test.ts storage/level-durability.jest.test.ts --runInBand
yarn typecheck:fast
node_modules/.bin/prettier --check packages/wallet/storage/ecash-operations/native.ts packages/wallet/storage/ecash-operations/native.jest.test.ts
node_modules/.bin/prettier --config app/.prettierrc.json --check packages/wallet/storage/ecash-operations/native-owner-child.cjs
git diff --check
```

The first command initially failed before the production repair as described
above. Final passing logs: `/tmp/frank-ecash-owner-native-final.log`,
`/tmp/frank-ecash-owner-wallet.log`, `/tmp/frank-ecash-owner-typecheck.log`,
`/tmp/frank-ecash-owner-format.log`. The full affected wallet gate passed in
34.134 seconds; native-only final gate in 1.985 seconds. No failed final gate is
represented as passing. Owned subprocesses exit and all synthetic database roots
are cleaned by the tests. Dependency overlays remain preserved.

## Qualification limits

The private map coordinates instances using this loaded native adapter module.
Independently duplicated module copies and unrelated raw Level users are not
coordinated by it; the map is not a universal process lock or a replacement for
Level's OS lock. Native behavior is actually exercised on the installed Darwin
stack, not independently qualified on Linux. Failed cleanup deliberately remains
fenced; no automatic uncertain-close recovery is added. Physical-WAL corruption,
arbitrary filesystem/store rollback, eviction and other storage adapters are
outside this repair.

No financial state, production admission, operation secret, reset behavior or
browser ownership claim is added. The separate S5c2 adapter repair remains under
its own worker and review. No push, main merge, deployment, external message,
public/funded action or other-worktree cleanup occurred. Exact-candidate
independent review is next.
