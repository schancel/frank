# [refactor] Derive shared chain identity from the protocol registry

## Summary

Choose direct consumption or generation after tracing build constraints; shared identity/family/native evidence comes from the protocol registry. Client metadata extends by canonical key, relay operator settings remain distinct. Reject unregistered static keys and clearly document supported subsets. Keep native IDs distinct from Frank identity; preserve identity probes. Do not advertise capabilities a relay has not configured or invent checkpoints.

## Current evidence and reproduction

Rust includes v1.json directly. TS chains-registry.ts declares a separate table; no generation relationship established. Its tests at :702 compare shared rows, skip unknown wallet keys, and require completeness only for EVM/Solana rows. Client/operator metadata and shared protocol facts need explicit provenance.

Evidence is static inspection and owner reports at `f2231d2ff3d244ea5641e5444722271023c2fa2f`, not a completed browser or live-funds reproduction. Agent handoffs are leads only.

## Expected behavior and impact

This item contributes to usable, reliable messaging without weakening input ownership, original-operation recovery, or chain isolation. Actual behavior and unknowns are stated above; no production root cause is inferred beyond that evidence.

## Acceptance criteria

Add/remove/change a protocol entry and demonstrate affected consumers agree; reject unregistered extension keys; check all supported families and intentional subsets. Verify deterministic generation if used and exact regeneration command. Preserve registry probe tests and native chain ID uses.

## Solution contract and scope

- Kind: refactor.
- Planning state: NEEDS_SPECIFICATION until the owner accepts this prepared artifact and the prerequisites below are satisfied. Publication alone does not authorize implementation or mark it READY.
- Proposed execution owner: Shammah (@schancel): product/architecture decisions; root coordinator: contracts and integration; one claimed worker per implementation scope; independent reviewer before landing.
- Tier: 3 for production changes to money, lifecycle, identity, persistence, concurrency or wire; investigation itself is read-only.
- Model lane: strong for contract authoring and affected production work; resolve through the active harness at dispatch.
- Allowed scope: docs/protocol/chains/v1.json; docs/protocol/chains/README.md; packages/wallet/chain/chains-registry.ts and tests; backend/cashweb/cashweb-config/src/lib.rs and registry tests; specific generator/build configuration only if chosen.
- Semantic mutexes: chain-registry-schema.
- Open decision / readiness requirement: None beyond acceptance of this contract and active-work conflict clearance.
- Dependencies: none within this plan. Draft keys must become native GitHub blocked-by edges at publication; prose alone is not the dependency graph.
- Non-goals: no broad unscoped rewrite, legacy migrations, live-funds experiments, new asset framework, stash/worktree cleanup, or independent sibling integration.
- Staging: regression/evidence first; required replacement/refactor next; switch consumers and delete predecessor before completion. Temporary coexistence, if unavoidable between landings, belongs to this item's implementation owner and ends when the immediate successor switches consumers. Do not leave a compatibility layer.
- Durable shape: where records change, freeze current and target ownership and restart/partial-submission semantics before editing. Known consumers are app/bot delivery and supported chain adapters; hypothetical plugins/assets do not justify a framework. Development reset replaces migrations but never deletes custody or unrelated state implicitly.
- Rollback: stop dispatch, preserve operation evidence and keys, and fix forward or revert only when new-format and financial effects permit it. A code revert is not a financial rollback.
- Gates: relevant existing package tests and boundary/browser checks selected at dispatch, plus `yarn typecheck:fast` for source changes. No invented factory gate script. Investigations report evidence rather than claiming source gates passed.

## Queue proposal

Proposed value: 4
Proposed cost: 3
Proposed certainty: 4
Proposed unblocking: 3

Proposed score: 21.3333. Shared identity consistency enables later family cleanup; source provenance is clear enough to investigate, while build integration needs a bounded design choice. These scores are advisory and do not override readiness, blockers or scope mutexes.

## Related work and provenance

Related existing issues: #1118, #681.

Owner discussion establishes chain-scoped pools, per-input reservations, independent normal stealth payments, distinct legacy fan-in, durable pre-submission recovery, partial-payment reporting, and clean format breaks. Current `AGENTS.md` records these decisions. Linked existing issues must be reconciled with these newer decisions, not blindly treated as current implementation truth.

Prepared labels: none. Prepared assignees: none. Implementation claims will be recorded separately after scope/liveness checks.

## Accepted bounded direct-JSON predecessor

The maintainer accepted direct consumption after the build and consumer trace. The current implementation contract is recorded in [issue comment 6081369866](https://github.com/schancel/frank/issues/1238#issuecomment-6081369866) and reproduced below. This annex supersedes the broad draft scope and generator choice for this stage only; the full family/session consumer cutover remains separate.


Base: a4459ddbccc74e0664f38012503b56d6dcc3bd7d in /Users/shammah/repos/frank. Parent accepted the direct-JSON architecture and default implementation lane after strong contract authoring. This bounded annex supersedes the broad draft's generator choice and allowed production scope; it does not complete #1238.

The protocol JSON docs/protocol/chains/v1.json is the sole owner of canonical id, family, network, CAIP-2, native chain identity, permitted proxy capabilities and identity probes. Rust already includes it directly. Wallet will directly import it, not generate another identity table. Client extensions own only presentation/kind/units/curve-key selection, public endpoints, deployment and feature settings keyed by an explicit supported canonical subset. They cannot redefine protocol identity or broaden protocol capabilities. Native chain IDs must retain the existing consumer representation through checked conversion, never unsafe numeric truncation. Preserve exact required probe/checkpoint data; no new checkpoints or protocol edits.

Construct a pure, immutable registry projection with an explicit typed extension shape excluding protocol-owned fields and runtime rejection of unknown extension keys or protocol-fact overrides. Validate the consumed schema/row fields that the projection relies on, duplicates and supported references. The supported subset is explicit across EVM, Solana and Bitcoin-family networks; omitted protocol rows are intentionally unsupported, not silently incomplete. Derive isTestnet from authoritative network semantics. Existing selected network metadata/units/public defaults remain unchanged for supported entries.

Remove client-only Ethereum Holesky exposure and the dynamic registration bypass after tracing all readers and production callers. Do not retain an alternative writer or compatibility registry. Unsupported lookup must be explicit at this registry boundary. Persisted obligations remain untouched. If removing an unsupported entry causes downstream recovery to silently default, overwrite or discard data, stop that cutover and surface the exact caller seam; do not edit payment/session/sync implementation under this contract. Alias/default consumer cleanup, EVM/Monad inheritance and session address fallback remain separately tracked successors.

Exclusive files: packages/wallet/chain/chains-registry.ts and chains-registry.jest.test.ts; optional new pure chain/protocol-chain-registry.ts and its test; packages/wallet/sync-router.jest.test.ts only to replace obsolete dynamic-registry fixture while preserving dispatch-negative assertions; docs/protocol/chains/README.md; chain/index.ts only obsolete registry export removal, preserving the three U0 status exports. U0 explicitly handed this barrel scope off in issue1289 comment6081349813. No protocol JSON, Rust, active-chain, monad-chain, sync-router production, wallet pool, journal, custody, app or runtime edits. No new package, generator, format migration or environment access.

Evidence: all-family fixture mutation changes shared protocol fields through the same projection, unknown/duplicate/override extension rejection, exact supported-key set and every intentional omitted row, native ID conversion edge, real main source agreement including identity probes/capability limits, immutability and existing lookup semantics. Existing registry and sync-router tests must retain actual negative dispatch coverage; no unknown-key skip. Exercise app bundling of the imported JSON with the real existing Quasar config: from isolated worktree/app, ../node_modules/.bin/quasar build -m spa (verify CLI availability first). Build writes only isolated generated/dist output and runs under a heavy lease. Do not source owner .env, add build config or claim whole-app compile clean; report any preexisting build blocker independently. Run scoped tests, lint/format and yarn typecheck:fast, then independent exact-tip review. No live RPC/browser/funds action.

Claim before editing, after fresh worktree/PR/claim check. Existing issue-1238 worktree is preserved, so use a new persistent .worktrees/issue-1238-registry-source and branch of that name; issue_worktree.sh cannot choose a suffix and must not replace the earlier workspace. No model attribution trailers. Coordinator alone integrates; root alone owns runtime/funding.
