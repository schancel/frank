# Q2: awaited eCash ledger I/O

Coordinator-authored contract. Exact base: `07f3cfbbff07bd6538e5cc7fa9353453c65da922`. Branch: `refactor/async-ecash-ledger`. Implementation owner: blackjack_evidence, GPT-6.1 Sol medium; independent review and integration: root. Start only on root's dispatch after Q1 review. This is a separate predecessor to qualified durable storage and atomic swaps, not a claim that localStorage is crash durable. Local commits and tests only; no push, merge, deployment, funded execution or unrelated cleanup.

## Outcome and ownership

Replace synchronous `EcashOperationStore.get/put` with Promise-returning methods. Await authoritative reads and commits throughout `EcashWallet`. The current version-1 ledger remains the sole owner of eCash operation intent, input claims, original signed bytes, change allocation, consumed-input tombstones and public stealth receipts. SDK/Chronik inventory remains derived. The native-attempt store retains distinct historical submission obligations.

Move ledger hydration out of the constructor into awaited initialization before wallet publication. Missing state is an in-memory empty view, never a write. Corrupt or foreign-wallet/chain records fail activation. Convert concrete `getEcashOperations` and `getStealthReceipts` to promises and update every caller. Q1 already supplies asynchronous shared observation methods. No cached ledger may become selection authority.

Every read/modify/write obtains fresh state inside the existing canonical-wallet exclusive section. Await the write before returning prepared state, advancing derived change floors, exposing signed bytes, calling `onSigned`, or broadcasting. Preserve network waits outside short selection sections. Storage completion failure is not proof that its mutation did not commit: reread/reconcile the original operation before further authorization; never free potentially exposed claims on an exception.

Retirement of a confirmed native-attempt obligation stays under the same lock: validate the exact current old record, derive its consumed outpoints, read current ledger, await the tombstone union commit, then delete only the matching old obligation. A failed tombstone commit retains the old row. Failed deletion leaves both records safely recoverable. Preserve their distinct authorities.

## Boundary and scope

Exclusive allowed files: `packages/wallet/ecash-operation-store.ts`, `ecash-wallet.ts`, `ecash-operation-store.jest.test.ts`, `ecash-preparation.jest.test.ts`, `ecash-stealth.jest.test.ts`, `app/src/accounts/session.jest.test.ts`, and evidence in this directory. No other discovered caller may be silently changed; report any additional required path. No native-attempt API replacement, ledger schema change, new derivation, migration, network config, crypto protocol, or UI feature.

Existing memory/localStorage implementations adopt the asynchronous interface only. Their replacement belongs to Q3: a qualified strict-durability adapter with explicit factory ownership/open/close, removing implicit production memory and localStorage defaults. Q3 must close owned resources on initialization failure and session release, never caller-owned stores. Do not add an unused lifecycle framework in Q2.

## Evidence and reversal

Extend existing behavioral tests with deferred and rejected reads/writes. Prove initialization waits; absent/corrupt reads do not write; preparation and exposure cannot escape pending commits; separate instances reserve disjoint inputs with monotonic change; unrelated inputs remain usable during pending broadcasts; and tombstone commit precedes old-row deletion across failure/reopen. Include chain/wallet isolation and repeated reconciliation. A failed acknowledgment after successful commit must reconcile the original operation rather than produce another payment.

Run focused affected wallet/app suites and all configured `yarn typecheck:fast` projects. No live funded execution. Persisted shape is unchanged, so reversal is a coordinated source revert with no data deletion. Q3 is required before claiming durable browser swap readiness; this source refactor alone cannot establish it.

## Confirmed review correction Q2-1

Independent verification at `d512de468846a200923a66099eb71aa8498f91ce` demonstrates a same-ID preparation returning signed prepared state while the first preparation still awaits its write acknowledgment. The store wrapper writes a visible backing record and then delays completion; the existing-operation fast path reads outside the wallet lock. Exposure still waits behind the lock, so no broadcast escape was demonstrated.

Route idempotent preparation admission/read/return through the same canonical-wallet exclusive section. Preserve network synchronization outside that section and avoid making an already prepared retry depend on a new indexer response. Add the exact visible-write/delayed-ack, two-instance same-ID regression. Keep it separate from the existing distinct-ID delayed-selection test. Freeze a new tip, rerun affected eCash gates and configured typechecks, then obtain a fresh independent review. No scope expansion is needed.

Clarify the store read contract: following a failed durability attempt, an authoritative read must return durably committed state or reject while durability remains uncertain; merely volatile write visibility is insufficient. A genuinely committed write with a lost acknowledgment may be reread. Document this requirement on the interface; Q3 must enforce and test it in the actual durable adapter. Do not infer it from the memory-store test double or introduce a generic filesystem-recovery mechanism in Q2.
