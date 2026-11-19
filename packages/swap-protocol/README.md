# `@frank/swap-protocol`

Testnet-only atomic swaps between eCash testnet XEC and Monad testnet MON. The package holds:

- the signed negotiation (offer, accept, reject; payload v2), its journal and its account-scoped
  storage;
- the HTLC swap: the pure decision core `src/htlc-swap.ts`, the headless runner
  `src/htlc-swap-runner.ts` and its record store `src/storage/htlc-swap-browser.ts`;
- the research models `src/stage0.ts` and `src/state-channel-pair.ts`, which no app or bot runs.

The protocol, deadlines, state machines and known gaps are described in
`docs/atomic-swap-specification.md` ("Implemented: the HTLC swap") and in the plan
`docs/plans/htlc-swaps/README.md`. This README covers the package's entry points.

This package never imports `@frank/wallet`. It declares the capabilities it needs (`Clock`,
`SwapSecretCapability`, `XecHtlcCapability`, `EvmHtlcCapability`); the wallet implements them and
the host composes them (`src/runtime-boundary.jest.test.ts`, `check-deps`).

## HTLC swap runner

A offers XEC and holds the secret; B offers MON. A locks XEC first (refund after T_A), B locks MON
second (refund from T_B), A withdraws MON with the secret, and B reads the secret from the
contract and claims XEC. Nothing is sent between the parties after the accept.

- `htlcSwapTermsOf` builds both locks' terms from the journal's `usableAcceptance`: the eCash
  P2SH script terms and GenericHTLC's lock id (`htlcLockIdOf`, the contract's `lockIdOf` with B's
  main account as sender).
- `resolveHtlcSwapRole`: party 1 is B. Party 0 is A only if the swapId re-derives from the offer
  under the account's keyed hash (`deriveOfferSwapId`), so the secret is never asked for a swapId
  this account did not create.
- `htlcSwapCutoffs`: A funds XEC while now ≤ T_B − (M_xec + S_xec + W), B locks MON while
  now ≤ T_B − `evmLockMargin`, A withdraws while now ≤ T_B − M_evm. On testnet that is T_B − 6 h,
  T_B − 2 h and T_B − 600 s; on regtest proof T_B − 40 s, T_B − 20 s and T_B − 5 s.
- `nextAction(input)` is pure. From the negotiation state, the swap record, both chains'
  observations, the device clock and whether this is the active device, it returns one phase, at
  most one action (`fund-xec`, `release-xec-lock`, `lock-evm`, `withdraw-evm`, `refund-evm`,
  `sign-xec-spend`, `broadcast-xec-spend`, `claim-owed`) and warnings (`claim-gas-low`,
  `xec-double-funded`, `xec-foreign-output`). An inactive device gets only the actions that finish
  its own exposed work: resuming an exposed XEC lock and re-broadcasting a spend it stored.
- `HtlcSwapRunner` (`start`, `poke`, `tick`, `stop`, `subscribe`, `snapshot`) ticks over every
  negotiation of one account. Ticks never overlap. It checks the terms against this device's keys,
  addresses and contract, then observes the chains and performs the one action. Write-ahead:
  `fundingAuthorizedAt` and `xecLockOperationId` are written before funding, and each signed eCash
  claim or refund is written before it is broadcast; later ticks re-broadcast the same bytes.
- Swap record v1 (`parseHtlcSwapRecord` / `serializeHtlcSwapRecord`, strict, canonical): the
  keys `version`, `swapId`, `conversationId`, `owner`, `role`, `termsHash`, and optionally
  `fundingAuthorizedAt`, `xecLockOperationId` and `xecSpends`. EVM call facts are not stored here; the wallet's EVM journal
  owns them and the runner reads them with `EvmHtlcCapability.ownCalls`.
- `BrowserHtlcSwapRecordStore` stores records in IndexedDB `frank-swap-htlc-v1-<namespace>` with
  revision compare-and-swap under a Web Lock. `MemoryHtlcSwapRecordStore` is for tests and
  single-process hosts.

The app starts the runner in `app/src/swap/htlc-swap-execution.ts`. Verification:

```sh
yarn --cwd packages/swap-protocol test --runInBand
yarn --cwd packages/swap-protocol test:htlc-swap-browser
yarn --cwd packages/bot regtest:htlc-swap
```

The last command needs Bitcoin ABC binaries (`FRANK_BITCOIN_ABC_BIN_DIR`, or
`yarn --cwd packages/bot regtest:fetch`) and anvil. It runs two parties, each in its own
process with real wallets, on xec-regtest and anvil.

## Authenticated negotiation

`@frank/swap-protocol/src/negotiation` is a separate pure entry point. The existing package entry
and Stage-0/pair experiments are unchanged. It freezes offer/accept/reject payload version 2,
pair-policy version 2, lane0 and manifest-local message types1/2/3, with A depositing XEC and B
EVM, for the HTLC swap (docs/plans/htlc-swaps/README.md). Principal quantities use bigint, with
uint64 XEC and fixed big-endian uint256 EVM wire encodings. These amounts exclude execution fees.
An offer additionally signs the HTLC terms: `hashLock` (sha256 of A's 32-byte preimage), A's
per-swap `xecRefundPublicKey`, A's main account `evmRecipient`, the absolute deadlines
`xecRefundTime` (T_A) and `evmExpiry` (T_B), and `evmHtlcContract`; `expiry` is the acceptance
deadline E. An accept adds B's per-swap `xecClaimPublicKey` and B's main account `evmSender`; a
reject carries no extra fields. Negotiation contains no inputs, nonces or funding authorization.

The reducer treats signed terms that cannot execute as a violation, never an accepted swap: the
deadline rules R1 `T_A − T_B ≥ minRefundGap`, R2 `T_B − E ≥ minClaimWindow`, R3
`T_A − E ≤ maxSpan` (`negotiationDeadlineRules`; testnet 6 h / 8 h / 72 h), T_A a 32-bit CLTV
timestamp, `xecPrincipal ≥ 546`, non-zero recipient/sender/contract, distinct eCash claim and
refund keys and `evmSender ≠ evmRecipient`. Builders refuse the same terms. The UI defaults are
`defaultNegotiationDeadlines` (E = now + 1 h, T_B = E + 12 h, T_A = T_B + 12 h on testnet).

A's swapId is `deriveOfferSwapId(facts, keyedHash)`: a keyed hash, under A's private account
salt, of the `frank/swap-offer-id/v1` transcript of the offer facts (policy, conversation,
parties, principals, E, T_A, T_B, recipient, contract). `authorizeNegotiation` signs an offer only
for the swapId the account's `offerSwapId` capability derives, so a swapId is never taken from a
peer or the wire and never reused for different terms.

Callers must select `TESTNET_NEGOTIATION_POLICY` (`xec-monad-testnet-v2`) or the separately
named `REGTEST_PROOF_NEGOTIATION_POLICY` (`xec-monad-regtest-proof-v2`, the same rules with
margins in seconds). Stored journal rows of the retired v1 policies fail with that reason and a
reset instruction (delete the account's negotiation storage namespace). The implementation reads
IDs, family and JSON-RPC permission directly from `docs/protocol/chains/v1.json`; it neither
accepts aliases nor substitutes native IDs. This structural registry check is not upstream
checkpoint or chain-state verification.

Builders receive explicit swap/conversation IDs, ordered identity keys and an asynchronous
`signDigest` capability. They snapshot their inputs before awaiting it, hash the existing
`frank/swap-event-signature/v1` preimage exactly once, and verify the returned central algorithm-1
strict-DER low-S signature. Identity key IDs use `frank/swap-identity-key-id/v1`; terms hashes use
`frank/swap-negotiation-terms/v2`. Golden vectors pin all these bytes in the negotiation tests.
The signer capability provides identity authorization only, never financial transaction signing.

`decodeNegotiationEventSchema` lets a stateless transport plugin parse and verify the self-contained
signer under an explicitly installed pair policy. Offers contain both party keys; responses contain
only B. This schema result has no operation-admission or state-effect authority. The full-context
`decodeNegotiationEvent` additionally binds the expected swap, conversation and ordered parties;
its internal parse/bind split decodes the payload once under the same supplied budget.

`decodeNegotiationEvent` and `reduceNegotiation` require a `NestedItemBudget`: transport plugins
must pass the enclosing message's budget. Only explicitly named `...Standalone` paths create
one for a distinct tool/journal reconstruction operation. Admission limits are64 input events,
1024 bytes per event,65536 total bytes and512 payload bytes, checked before signature verification;
duplicates count toward admission. Every event is fully prevalidated, including response orphans
which the core reducer would otherwise buffer without visiting their descriptors.

A canonical receive host calls `validateAuthenticatedNegotiationEvent` with the authenticated
sender/recipient identity keys, actual wire conversation and local key. It must explicitly name
incoming versus outbound replay. This helper checks those assertions; it cannot establish their
provenance. Do not supply profile lookups or arbitrary restored display messages as authentication.

Reduction preserves historical offer/decision evidence and reports violations separately.
`usableAcceptance` is always null on a violation. `negotiationEligibility` accepts an explicit
Unix-seconds clock, requires `now < expiry`, and does not erase old acceptance. Eligibility means
only that further preparation may be considered: it never authorizes funding, signature release,
reservation release, data deletion or cancellation of financial recovery. Execution belongs to
the HTLC swap runner above, which reads `usableAcceptance` from the journal.

The package's declared runtime dependency check can be run with:

```sh
node packages/nakamoto/scripts/check-deps.mjs --root packages/swap-protocol
```

The separate `src/message-plugin.ts` entry provides the inert `swap-negotiation-v1` application
plugin. Supply an explicit pair policy to `createNegotiationMessagePlugin`; each descriptor owns
its validation cache and never registers globally. It projects exact signed bytes as
`{eventHex: string}` for ordinary JSON persistence, validates restored projections fully, and
continues the enclosing receive budget. Its factual previews and hydration have no admission,
signing, funding or settlement authority. App and the concrete all-bots target explicitly install
the testnet policy. Wallet defaults and other bot targets do not install this feature. The app's
writers are `app/src/swap/negotiation-commands.ts` (offer dialog `OfferSwapDialog.vue`, answers
in `SignedNegotiationCard.vue`). A wire change requires coordinated feature
writer/reader changes; no compatibility reader or migration is provided.

## Authenticated single-negotiation journal

`@frank/swap-protocol/src/negotiation-journal` is a separate headless entry.
`new NegotiationJournal({ owner, context, store })` binds one immutable existing
`NegotiationContext` to an explicit account incarnation, local party identity and
canonical messaging chain. Inputs, including Buffers, are copied before storage
awaits. Incarnation is an opaque nonempty scalar UTF-8 string of at most256 bytes;
it is not derived from a key or automatically rebound after account restoration.
The app and bot hosts use it through `NegotiationRecovery` (`src/runtime.ts`).

The host supplies `read(key): Promise<string | undefined>` and
`compareAndSwap(key, expectedRaw, nextRaw): Promise<boolean>`. This capability must
provide linearizable comparison+commit across handles, durable success before
`true`, committed reads or observable failure, and absent inspection without
initialization. `false` means another committed writer won. Exceptions can mean
ambiguous writes and propagate without an automatic retry. An adapter cannot
implement CAS as independently queued get and put operations. The test memory
capability proves the algorithm only; it is not a production storage fallback or
physical durability qualification.

`journal.read()` returns explicit `presence`, copied evidence entries and the S5a
reduction. It fetches and validates the actual row each time, without writes or a
competing authoritative cache. `journal.admit({ eventBytes, authenticated,
messageId, stampedPayloadDigest })` requires actual signed bytes plus trusted
canonical host delivery assertions. `authenticated` includes S5a's explicit
incoming/outbound-replay direction, local/sender/recipient keys and actual wire
conversation, plus `messagingChainIdentifier`, which must match the owner.
Message ID is exactly16 bytes and stamped payload digest exactly32 bytes; the
latter is distinct from contentDigest. This engine checks supplied assertions;
it cannot establish outer-envelope provenance or authenticate arbitrary restored
presentation messages.

Admission validates the fresh row and new delivery, retains original signed bytes,
and uses CAS to append. CAS-false retries from a fresh row at most eight times;
exhaustion raises `NegotiationJournalError` with `code: 'contention'`. Invalid
inputs, corrupt rows and capacity have distinct codes; storage exceptions retain
their original identity. Exact event-byte duplicates authenticate again and write
nothing, including at capacity or under a different valid delivery ID/digest. The
first valid metadata remains sufficient. Distinct valid signatures count as
distinct evidence bytes, while S5a decides semantic duplication. Signed conflicts
remain present and produce an unusable acceptance; response-before-offer remains
buffered. No accepted/status flags are persisted.

The exact version1 JSON shape is `{ version, owner, context, entries }`. Owner is
`{ accountIncarnation, localPublicKey, messagingChainIdentifier }`; context is
`{ swapId, conversationId, parties, policy }`, with existing explicit ordered pair
policy fields. Every entry is `{ eventBytes, senderPublicKey, recipientPublicKey,
direction, messageId, stampedPayloadDigest }`. Byte fields use lowercase hex.
The messaging chain is stored once in the owner binding. Unknown fields, versions,
invalid signatures and changed immutable/authenticated bindings fail visibly.
Duplicate entries in a stored row are malformed. Limits are262144 UTF-8 JSON bytes,
64 entries,1024 original bytes per event and65536 aggregate original bytes, checked
before expensive validation. No eviction, reset, migration or compatibility parser
is provided.

`rowKey` is lowercase SHA256 hex over twelve concatenated length-framed components.
Each component uses its unsigned four-byte big-endian byte length followed by its
bytes, in this order: UTF-8 domain `frank/swap-negotiation-journal-key/v1`, UTF-8
version `1`, UTF-8 incarnation, raw local compressed key, UTF-8 messaging chain,
raw swap ID, raw conversation ID, raw party A key, raw party B key, UTF-8 policy
name, UTF-8 XEC chain, UTF-8 EVM chain. This is a public local storage identifier,
not a confidentiality boundary or cross-user identifier. Golden key and serialized
record vectors are fixed in the co-located tests.

`inspectNegotiationJournalRecord(raw)` performs the same strict pure validation
and reconstruction, returning rowKey plus owned copies of owner/context/evidence
and reduction. It assumes no host account affinity: concrete adapters must compare
account incarnation, local key and requested row key explicitly before CAS.
Local admission metadata remains trusted application state; changing valid-looking
local metadata or rolling back storage is not cryptographically prevented, and
stored outer envelopes are not reauthenticated.

Required successors qualify actual native/browser CAS storage, atomically bound
the number of negotiations per account, and install authenticated host polling,
streaming and outbound replay with lifecycle revocation and retention. Account
restoration versus incarnation rebinding and pre-activation history need explicit
host policy. Negotiation remains historical evidence; it provides no signing,
funding, reservation, secret, acceptance automation or financial recovery authority.

Verification from the repository root:

```sh
node_modules/.bin/jest --config packages/swap-protocol/jest.config.cjs --runInBand
node packages/nakamoto/scripts/check-deps.mjs --root packages/swap-protocol
node_modules/.bin/prettier --single-quote --no-semi --trailing-comma all --check packages/swap-protocol/src/negotiation-journal.ts packages/swap-protocol/src/negotiation-journal.jest.test.ts
yarn typecheck:fast
```

### Account-scoped negotiation storage

`src/storage/negotiation-browser.ts` and `src/storage/negotiation-native.ts` expose explicit
`createBrowserNegotiationJournalStore` / `createNativeNegotiationJournalStore` factories.
Both require `hostDiscriminator`, `accountIncarnation` and a valid compressed `localPublicKey`.
Native additionally requires an approved existing `rootLocation`; it creates no ancestors.
The returned capability exposes `read`, `compareAndSwap`, `listRecords`, `readCoverage`,
`compareAndSwapCoverage`, `namespace` and `close`.
The app uses the browser adapter (`app/src/utils/negotiation-recovery.ts`) and the bot host the
native one (`packages/bot-framework/src/negotiation-recovery.ts`).

One deterministic versioned namespace belongs to that host/account incarnation/public key,
across messaging chains. Complete binding metadata is validated separately from journal rows.
The pure journal inspector owns row semantics, signatures and canonical identity validation;
storage additionally enforces account/key affinity and the derived row key. Accepted raw JSON
is preserved exactly, including equivalent whitespace/property order. Account capacity is
128 rows and 8,388,608 UTF-8 serialized row bytes; metadata is separate. Rows retain the pure
journal's 262,144-byte bound. Limits are derived from current records on each operation, with
no eviction or competing persisted counters. Comparison failure returns false; capacity failure
throws the existing journal capacity error, leaving the handle usable.

`listRecords()` returns a frozen snapshot of validated `{ key, raw }` entries sorted by key.
`readCoverage(chainIdentifier)` returns the committed inclusive replay position, or absence.
`compareAndSwapCoverage(chainIdentifier, expected, next)` commits only if the expected position
matches. Positions are nonnegative safe integers and cannot decrease; equal positions are
allowed. Chain identifiers must be exact members of `docs/protocol/chains/v1.json`; this does
not assert that a host scanner is installed for that chain. Input validation precedes storage
effects. Absent listing/reads and failed expected-value comparisons never initialize storage.
All operations validate the complete inventory and its account/local-key affinity first.

Optional `coverage-v1` contains exactly `{version: 1, positions: [{chainIdentifier,
resumeFromInclusive}]}`. Entries are unique and lexically sorted; at most 32 positions and
16,384 UTF-8 metadata bytes are permitted independently of signed-row capacity. Every present
namespace requires the unchanged `binding-v1`. Coverage and journal writes preserve each
other and share the same atomic initialization/ownership barriers. Corrupt/unknown metadata
fails observably without repair. Coverage is a host consumption fact; negotiation state still
comes exclusively from signed journal reduction. After an ambiguous write acknowledgment,
close/reopen/read to reconcile the committed position before retrying; never infer a greater
position or absence from an exception.

This is an additive local storage format with a reversal limitation: older adapter code rejects
`coverage-v1`. Reverting code must preserve the namespace rather than delete or repair it.
There is no migration, fallback, separate index, wire change, or derivation change. An explicitly
authorized development reset may remove only this host/account negotiation namespace; it must
never delete keys, funded wallets or unrelated application data. Scan scheduling belongs to the
hosts' `NegotiationRecovery` installations. The composed regression exercises signed admission, failed
coverage consumption, reopen, duplicate replay and discovery; it proves this storage seam.

Browser storage uses direct IndexedDB schema version 1, one out-of-line `records` store and
explicit Web Locks. Absent reads abort unexpected creation. A namespace lock covers every new
connection's opening/inspection and the first strict transaction that atomically writes binding
and the first row or coverage record. Reopening performs no readwrite durability probe. An interrupted schema-only
namespace remains an observable error, never an empty replacement or repaired database.
Normal read/CAS operations use IndexedDB transactions; CAS compares, validates capacity and
writes in one verified strict transaction, acknowledging its completion rather than request
success. Closing revokes admission and aborts pending initialization; abandoned requests cannot
publish late connections or initialize a replacement. A pending native IndexedDB open cannot
be canceled directly, so close observes its terminal cleanup after any external blocker releases.

Native storage owns one private Level7 handle, serializes the whole operation, uses `sync:true`
for writes, synchronizes the namespace directory on every actual open/recovery, and synchronizes
its parent after creation. A module-private canonical-location token prevents duplicate
same-process Level construction: on the tested POSIX backend, closing a failed duplicate could
drop the first owner's OS exclusion. The token releases only after its own handle cleanup.
Actual Level OS locking remains required across processes. This guard covers one loaded module
in a process; it does not qualify independently duplicated module copies or unrelated raw Level
consumers. Tested native qualification is macOS 26.6 arm64, Node 26.10.0, Level 7.0.1 / leveldown
6.1.1; Linux and other storage/media environments were not qualified by this run.

Success means acknowledged durable commit under the qualified backend. An exception may follow
a committed write; the handle poisons before queued later work and requires close/reopen to
reconcile original evidence. There is no automatic retry, rollback, deletion or absence claim.
Close drains admitted work; an already admitted CAS may commit. Cleanup failures stay visible.
Browser eviction/profile loss, malicious rollback, physical media corruption, reset, account
incarnation restoration, host lifecycle and saturation policy remain separate work. No financial
execution, signing capability, acceptance automation or custody secret is added.

From the repository root, qualification commands are:

```sh
yarn --cwd packages/swap-protocol test --runInBand
yarn --cwd packages/swap-protocol test:storage-browser
node packages/nakamoto/scripts/check-deps.mjs --root packages/swap-protocol
yarn typecheck:fast
```

The browser command bundles with existing installed tooling, checks pure/browser import
boundaries, and uses an owned temporary Chrome profile with loopback transport. Set
`NEGOTIATION_STORE_CHROME` for an explicitly selected installed executable. It runs actual
production limits, independent pages, strict-capability refusal, fault-injected lost
acknowledgment, and process-kill/reopen tests; it does not download a browser or access chains.
The separate browser/native tsconfigs are both required gates in `scripts/typecheck.ts`.
