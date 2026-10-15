# S5b implementation evidence

Candidate branch `feat/swap-negotiation-transport`, exact starting commit
`51c93f95e8a288434bc6e8826a156e51629fd2f3` (root contract/design documents on reviewed
source `10c55621bed385a1967c82d92009c1fb30257266`). Parent owns independent review and
integration; requested/selected implementation lane is GPT-6.1 Sol medium. This is a Tier-3
inert enabling candidate, not completed atomic swaps.

The new pure `swap-protocol/src/message-plugin.ts` descriptor owns the exact bounded
`{eventHex}` projection, S5a schema/signature validation and factual previews. App and the
all-bots target explicitly install the testnet pair policy through their production factories.
Bot-framework gains only an optional registry factory; omission preserves its defaults. The
factory resolves before either wallet-scoped hook installs, and failure follows existing
wallet/directory/journal cleanup. No core negotiation, custody, wallet transport, generic
renderer, central allocation or existing wire bytes changed. The only persisted representation
is the JSON-safe signed-event hex projection; no store, migration or compatibility reader.

The descriptor's WeakMap holds only validated kind for exact plugin-created frozen objects.
It is per instance, weakly owned and carries no authenticated admission authority. A received
payload parses once under the supplied enclosing budget; the neutral bridge's subsequent read
recognizes that exact frozen object. Arbitrary/restored objects fully validate again and return
a newly frozen projection. Repeated received bytes always parse/charge again, irrespective of
cache equivalents. Parent approved this bounded bridge adaptation during implementation.

## Fresh verification

All commands run in this candidate checkout with candidate-local `@frank` workspace links,
existing installed external dependencies and wallet-local Chronik 4.3.1. No install/download,
public or funded network, native expensive proof or external message was used. Synthetic
canonical two-wallet fixtures retain their actual testnet identity/configuration; these are not
aliased native regtest proofs. Overlays are retained for independent/combined verification.

| Command | Result |
| --- | --- |
| `yarn --cwd packages/swap-protocol test --runInBand` | PASS: 5 suites / 52 tests, including unchanged S5a golden vectors and Buffer regressions |
| `yarn --cwd packages/bot-framework test --runInBand` | PASS: 17 suites / 179 tests |
| `yarn --cwd packages/bot test --runInBand` | PASS: 48 suites / 762 tests; 1 suite / 7 tests skipped |
| `yarn --cwd packages/bot test --runInBand test/message-items` | PASS: actual app/all-bots encrypted composition |
| `yarn --cwd app test:unit:ci --runInBand src/utils/message-items.jest.test.ts` | PASS: 1 suite / 1 test |
| `yarn --cwd packages/wallet test --runInBand message-item-plugins/application-item.jest.test.ts message-item-plugins/default-registry.jest.test.ts message-item-plugins/registry.jest.test.ts message-item-plugins/wire.jest.test.ts chain/canonical-item-roundtrip.jest.test.ts` | PASS: 5 suites / 141 tests |
| `node packages/nakamoto/scripts/check-deps.mjs --root packages/swap-protocol` | PASS: 2 justified runtime dependencies; new entry also has an automated exact production-import whitelist |
| `yarn typecheck:fast` | PASS: all 23 configured projects |
| `node_modules/.bin/prettier --config app/.prettierrc.json --check packages/swap-protocol/src/message-plugin.ts packages/swap-protocol/src/message-plugin.jest.test.ts packages/bot/src/message-items.ts packages/bot/test/message-items.jest.test.ts app/src/utils/message-items.ts app/src/utils/message-items.jest.test.ts` | PASS |
| `node_modules/.bin/prettier --check packages/bot-framework/src/types.ts packages/bot-framework/test/bot-host-message-items.jest.test.ts` | PASS |
| `git diff --check` | PASS |

The actual encrypted flow sends orphan Accept/Reject from bot to app before an offer arrives,
then carries Offer/Accept/Reject app-to-bot and back, preserving exact event bytes and the
explicit selected conversation16 through encrypted send/fetch and JSON storage. Hydration
uses a provider that throws on any property access. Unknown IDs, missing installation and
unsupported outer versions retain exact frames; known malformed bytes/signatures and inner
versions retain exact malformed frames. Preconsumed enclosing counters admit one valid event
then reject the next as whole-message budget exhaustion, despite S5a wrapping the resource
exception. Unit tests separately verify once-only parsing, received duplicate charging,
frozen identity/mutation rejection and full restored-object revalidation. Real host tests prove
factory consumption, default behavior, visible error, closure and successful reopen of real
Level state/journals after factory failure.

## Inherited formatting and residual limits

Default whole-file Prettier fails at the exact starting revision and candidate for
`packages/bot-framework/src/bot-host.ts` and `packages/bot/targets/all-bots.ts`. Base-to-formatted
hunks begin at base lines 1, 249, 345, 644, 730, 798, 1103, 1136, 1182, 1590, 1615, 1674,
1760, 2000 and 2134 in bot-host; 60 and 81 in all-bots. Existing style is preserved rather
than sweeping unrelated source. New sections follow the existing default style. Parent
explicitly directed preserving these inherited failures. Other affected sources pass the
scoped commands above.

Initial full-bot verification passed 47 suites / 761 tests with 1 skipped suite / 7 tests,
but the newly tightened unknown-version fixture failed. It incorrectly expected outer
schema2/min-reader2 to be unsupported by readerVersion2; the protected codec intentionally
projects that newer schema. The fixture now uses min-reader3. No production change was made
for this correction; the focused encrypted proof passed after correction and the full-bot gate
was rerun successfully (exit 0). The initial result remains in `/tmp/frank-s5b-bot.log` and the corrected focused
result is `/tmp/frank-s5b-transport-final.log`.

Logs: `/tmp/frank-s5b-{swap,framework,bot-final,transport-final,app,wallet,typecheck,format}.log`.
These are fresh local assertions; earlier native saved proofs are unchanged and not rerun or
claimed here. No authenticated runtime journal, operation admission, proposal UI, automatic
acceptance/reply, signing capability, funding, reservation or settlement authority is added.
The full bot command emits Jest's delayed-exit warning before exiting successfully; the new
focused encrypted suite exits normally. This broad-suite warning was observed, not diagnosed
or silently represented as proof that every existing background handle closes. Explicit host
factory cleanup/reopen passed separately. Other bot targets remain unsupported. S5c must bind canonical authenticated records and durable
account/conversation/ordered-party evidence before reduction. Main merge/deploy remains held.
