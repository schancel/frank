# Q2 implementation evidence

Base: `07f3cfbbff07bd6538e5cc7fa9353453c65da922`. Branch: `refactor/async-ecash-ledger`. Coordinator contract: [contract.md](contract.md).

`EcashOperationStore.get/put` and concrete eCash operation/receipt getters now return Promises. Initialization awaits journal validation before publishing the wallet. Every mutation reloads authoritative state under the existing wallet lock and awaits its write; network/indexer waits remain outside selection sections. Preparation cannot return or advance the derived change floor before commit, and native/external exposure cannot escape an incomplete commit. Native-attempt retirement awaits consumed-input tombstones and rechecks the exact old record before deleting it. No ledger schema, derivation, native-attempt API or owner changed.

Five contract-authorized code/test files changed: `ecash-operation-store.ts`, `ecash-wallet.ts`, and the store/preparation/stealth tests. The authorized app session test contains no synchronous store/getter consumer to convert; it runs unchanged as an integration boundary. All existing callers were inspected. No source scope expansion was needed.

## Gates

| Gate | Command and result |
| --- | --- |
| Configured projects | Root: `yarn typecheck:fast`; 22/22 projects pass. |
| eCash behavior | From `packages/wallet`: `../../node_modules/.bin/jest --runInBand --runTestsByPath ecash-operation-store.jest.test.ts ecash-preparation.jest.test.ts ecash-stealth.jest.test.ts ecash-wallet.jest.test.ts`; 4/4 suites, 56/56 tests pass on the corrected candidate, natural exit. |
| App session boundary | From `app`: `../node_modules/.bin/jest --config test/jest/accounts.config.cjs --runInBand --runTestsByPath src/accounts/session.jest.test.ts`; 101/101 tests pass, including both historical/current eCash SDK restore/respend fixtures. |
| Write-barrier mutation | Temporarily remove `await` from the four wallet `operationStore.put` sites. From `packages/wallet`: `../../node_modules/.bin/jest --runInBand --runTestsByPath ecash-preparation.jest.test.ts ecash-stealth.jest.test.ts -t 'awaits selection|does not call onSigned|waits for external|commits prior-obligation|awaits receipt persistence'`; all 5 selected tests fail. Restore source, then the full 55-test eCash gate above passes. |
| Diff | `git diff --check` passes. |

Seven added preparation cases exercise deferred initialization; rejected/corrupt/foreign reads without writes; delayed claim commits with separate-instance selection; native exposure before `onSigned`/broadcast; external exposure with committed-but-rejected acknowledgments; original-byte recovery after lost preparation/native-exposure acknowledgments; and tombstone commit/deletion failures across reopen. The receipt-persistence regression now delays and asynchronously rejects the write, proving no SDK key import occurs while it is pending. Existing network-wait concurrency, canonical isolation, repeated reconciliation and current-ledger balance filtering remain covered.

Worktree-local dependency overlays mapped `@frank/*` to this candidate and third-party packages to the installed dependencies. No dependency manifests changed. Only those locally created links are removed after verification.

Assigned lane: GPT-6.1 Sol medium; the inherited runtime exposes no additional independently verifiable model identifier. Root owns independent review and integration.

## Remaining limits

The memory/localStorage adapters only adopt the async interface; this does not qualify localStorage as strictly durable. Q3 must supply the qualified adapter and host resource lifecycle. Historical native-attempt storage retains its own obligations. Atomic-swap runtime, crypto, UI and release/deployment remain outside this candidate. No funded/live execution, push, publication, merge or deployment occurred.


## Confirmed review correction Q2-1

At `d512de468846a200923a66099eb71aa8498f91ce`, an initial existing-ID read bypassed the wallet lock. A backing write could be visible while its acknowledgment remained pending, allowing a second instance to obtain signed state early. Exposure/broadcast still waited behind the lock; no broadcast escape was demonstrated.

The initial idempotent read, intent validation and return now execute under the canonical-wallet exclusive section. Network/indexer synchronization remains outside that section. The new same-ID fixture commits visible backing state, delays acknowledgment, and starts a retry on a second instance whose indexer is offline. Both preparations remain pending until acknowledgment; afterward they return identical original bytes with one write, one operation and one change-index allocation. Repeated prepared retries do not query the indexer and neither instance broadcasts.

Fail-before command from repository root: `node_modules/.bin/jest --config packages/wallet/jest.config.js --runInBand --runTestsByPath packages/wallet/ecash-preparation.jest.test.ts -t 'keeps same-ID preparation'`. It fails on the original candidate with `retryDone: true !== false`. With the fix, the full affected four-suite gate above passes 56/56; configured fast typechecks pass 22/22. The prior 101-test app-session gate was not repeated for this correction; no app interface or fixture changed.

The store read interface now explicitly requires durably committed state or rejection when a previous durability attempt is uncertain. Volatile visibility is insufficient. The lost-ack fixtures model completed writes followed by failed acknowledgments; Q3 must enforce this contract in its actual durable adapter.
