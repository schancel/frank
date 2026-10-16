# Durable per-member observation generation

Authorized code-only breaking-stack correction; exact base61c6d468a1911f05fb469a4d28c512fb049ef78a. Claim native_observation_generation owns journal version/generation scope below. Parent review/integration required. No deployment or replacement of existing private state authorized.

## Confirmed failure and outcome

Independent implementation and reviewer probes /tmp/native-capture-aba-probe.jest.test.ts and /tmp/native-capture-independent-review-aba.log demonstrate: wrapper B captures included A; wrapper A commits pending B then exact inclusion/account A and marks sync applied; B's old missing result passes equality, clears inclusion and syncApplied. The integrated equality repair correctly rejects changed current evidence but cannot detect intervening history.

The native journal member must retain a durable observation generation. Capture it along with the existing immutable signed/evidence basis, then compare inside the existing coordinated reload/mutation. A→B→A changes generation twice, so the old result rejects even though current evidence matches. Rejection leaves durable state unchanged; the caller must obtain fresh network evidence through a new capture. This orders locally accepted evidence, not RPC truth or chain finality.

## Current/target authority and formats

Current operation rows and manifest version1 contain member observation/account but no generation. Target is an explicit version2 native-operation journal baseline: every member requires observationGeneration, a nonnegative safe integer initially0. Increment atomically only when an accepted observation/account value changes semantically, using the same stable field projection as the reviewed equality repair. Identical evidence replay does not increment. Capture generation check applies to every incoming observation state, including included success/revert, and remains independent of exposure/sync acknowledgements and unrelated members. Preserve signed identity checks and exact unknown-inclusion contradiction rules.

Version2 row and manifest validation must reject absent/invalid generations and unsupported old format explicitly, without modifying bytes, clearing reservations or initializing replacement state. Update maximum row/reservation accounting to reserve the largest counter encoding. At maximum generation, a changing observation fails visibly without wrapping, partial writes or silently accepting stale evidence. Do not introduce a migration, dual reader, zero-default for old records, alternate namespace fallback or auto reset. Pure new synthetic test namespaces are allowed; funded/pending old journals are retained and require an explicit release/disposition decision before deploying this format. Document that this is a material release gate.

Known successor is head-driven reorg reconciliation; this field belongs to the existing member owner, not a new universal inventory, second journal or global wallet lock. No wire, key derivation, message-format or swap-format change. Reversal after persisted version2 data is not a source-only operation; preserve those records too.

## Finite scope

packages/wallet/storage/evm-native-operation-journal.ts and its co-located focused storage/concurrency tests; relevant evm-legacy-consolidator/input-admission tests; exact direct type consumers/fixtures requiring rowversion/generation updates; journal documentation and reviews/native-observation-generation/*.md. Trace all observation/account mutation sites. No production app/chat/session/scanner/swap/directory changes. Report any additional production scope before editing. Existing test baseline/equality repair is independently reviewed; preserve it, add harmful ABA fail-before proof, then implement the coherent version/generation correction. No unrelated cleanup.

## Acceptance

- Reproduce harmful ABA on base with real durable two-wrapper interleaving, assert stale result false on candidate and inclusion/account/sync retained. Include restart/reopen between changing commits and the stale attempt where supported by independent-wrapper lifetime.
- Preserve five changed-basis regressions, account-only changes, field-order equivalence, fresh valid lower-height reorg, exact unknown contradiction rules, local supersession/close, original capture affinity and per-member/chain isolation.
- Same evidence and concurrent sync/exposure writes do not create false stale rejection or advance generation. Two contenders changing the same generation yield one accepted update; loser cannot reuse old evidence by merely refreshing capture in production flow.
- Version1 and malformed/missing/negative/fractional/overflow counters reject without changing original bytes. New version2 records persist/reopen; generation and evidence commit atomically. Inject failed/lost write acknowledgement and verify poison/reopen recovery retains actual durable generation and exposure facts. Reservation byte accounting includes maximum generation.
- Actual consolidator recovery and affected journal/input-admission/payment suites plus all25 typechecks and formatting/dependency checks. No broad unrelated suite repetition.

Candidate-owned overlays only; no installs/shareddependency changes/live services/funds/mainmerge/push/deploy/cleanup/attribution. Freeze exactcandidate with evidence and release limitations for independent review. This work fixes the remaining local evidence-ordering defect; it does not restore spent balances, verify funding provenance or complete full reorg recovery by itself.
