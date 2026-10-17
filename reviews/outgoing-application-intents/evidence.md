# Outgoing application intent candidate evidence

Implemented the parent-authored tier-3 contract on `feat/outgoing-application-intents`,
based on `5100b241ae6bf8337124071fdb279c0c5601688f` plus contract `837f62e6`.
The frozen candidate hash is reported in the worker handoff. Parent review/integration
remains required.

## Ownership and scope

Only cashweb MessageStore production files changed. There is one real MessageStore
implementation (`LevelMessageStore`); no alternate persistence implementation or
required mock/interface expansion was found. The new co-located pure record module
owns opaque record validation, canonical ordering and immutable transition decisions.
The metadata adapter owns atomic platform persistence; MessageStore owns lifecycle,
mutation serialization and poison/reopen policy. No wallet imports were added.

The durable key is solely `outgoingApplicationIntent:` plus the semantic key. No
mutable count index, eviction API or second owner was added. Generic storage does not
interpret application choices. Schema 3 is required because history clear now retains
both intent authority and the format marker. Old schema 2 is rejected unchanged.
The development-only fresh synthetic namespace path is documented in
`packages/cashweb/relay/storage/README.md`; no data reset was executed.

Compression checked the final tree for duplicate owners, speculative frameworks,
compatibility paths and redundant indexes. The named public seam and platform
transaction boundary remain distinct. Only current-record validation and transition
logic are shared; existing receipt/suppression/financial-binding behavior remains in
its current owner.

## Gates

Environment: Node `v26.10.0`, macOS/darwin arm64; real Chrome `155.0.8059.80`.

| Command | Result |
| --- | --- |
| `node node_modules/jest/bin/jest.js --config packages/cashweb/jest.config.js --runInBand` | 69 suites, 569 tests, 1 snapshot pass |
| `node packages/cashweb/relay/storage/outgoing-application-intent.browser-test.mjs` | Actual Chrome process interruption/reopen, independent-page claim/completion/capacity races and public recovery pass |
| `node --import tsx scripts/typecheck.ts --fast` | All 25 configured projects pass; same entry point as `yarn typecheck:fast` |
| Scoped Prettier checks (app config for existing single-quote storage/backend/tests and all new harness files; default config for existing `storage.ts`) | Pass |
| `git diff --check` | Pass |

Logs are `/tmp/outgoing-intents-{cashweb,chrome,typecheck,format}.log`.
The Chrome harness also asserts a self-contained browser bundle, no Node builtin
imports and no wallet implementation imports. It uses production MessageStore,
LevelJS encodings, strict transactions and app-equivalent browser polyfills.

Native proof covers synchronous batches/reopen, conflicting claims and context,
missing completion, exact replay, 128-record capacity with independent account scopes,
immutable input snapshots/results, maximum byte/integer bounds, every canonical
registry network, corrupt rows and old schema rejection without deletion. The
synthetic two-choice fixture persists one choice before the interruption, completes
once and reconstructs identical signed fixture bytes/message ID after reopening.
Expected refusals preserve usability. Injected post-commit acknowledgment loss poisons
further mutations; reopening reveals the signed result. Close drains accepted
claim/completion work while rejecting newly requested work.

Actual Chrome uses two independent pages sharing one owned local origin, with no
shared process-local MessageStore queue. Conflicting claim and completion races each
produce one winner. Exact repeats from both pages succeed, including repeats of the
signed result. Starting with 127 retained rows, a two-page capacity race produces
exactly one final slot; completion still succeeds at capacity. The browser is killed
between claim/completion and again after the signed result; the reopened result
preserves the original message identity and bytes. Chrome also verifies clear/delete
retention, missing read nonmutation, altered context rejection, corruption visibility,
lost acknowledgment poison/reopen, close interleavings and schema 2 preservation.

Existing cashweb coverage includes financial binding transitions/retention, receipts,
suppression, quarantine and current restoration/lifecycle behavior. The affected
public type consumers compile under the 25-project gate. No UI, signing, delivery or
app-to-bot behavior changed or is claimed as installed.

## Dependencies and limits

Candidate-owned ignored overlays link external dependencies from the installed
integration checkout and `@frank` packages into this candidate. Existing package-local
overlays are included; wallet-local Chronik remains `4.3.1`. An initial 24/25 typecheck
was caused by missing bot-local `@types` resolution (`assert.ok(result,
failure?.message)`); matching that existing overlay fixed qualification without any
bot source edit. There were no installs or shared dependency mutations.

The contract requests GPT-6.1 Sol medium. This worker was supplied a GPT-6 agent
identity; the session exposes no self-model selection/attestation metadata, so the
requested model cannot be independently attested. No model-selection override was
made by this worker.

Evidence covers local native synchronous persistence and the listed Chrome's strict
transaction/process-restart behavior. It does not qualify physical power failure,
browser eviction/profile loss, other engines/platforms or exclusion across separate
local databases. The fixed retained-record capacity deliberately has no eviction or
reset mechanism. Future feature code must derive private semantic keys and consume
the saved identity/bytes through the existing messaging recovery path.

Only synthetic fixtures and owned temporary profiles were used. No live providers,
relay calls, credentials, actual signatures, funds, external messages, push, deploy,
main merge or unrelated cleanup occurred. Parent independent review is the next step.
