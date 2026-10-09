# [bug] Enforce exclusive input ownership and private provisional state in construction views

## Summary

Define operation-owned reservation and publication transitions at the pool boundary. Two views cannot claim the same UTXO or account/nonce. Provisional outputs stay private until chain/operation eligibility permits publication. A per-chain pool owns chain affinity. Preserve separate keyrings and journals; do not replace the entire inventory or choose a universal token model. Explain how this authority maps to canonical journal admission, rather than introducing a second independent lock table.

## Current evidence and reproduction

ChainUtxoView.getCleanCoins at :2412 filters base clean coins only against its own spent set. Commit at :2741 has no competing-operation owner validation; markPending at :1563 allows an already-pending entry. Staged next-nonce residual entries at :2707 may become globally visible on commit. Higher-level serialization may mask these gaps; production double submission is unproven.

Evidence is static inspection and owner reports at `f2231d2ff3d244ea5641e5444722271023c2fa2f`, not a completed browser or live-funds reproduction. Agent handoffs are leads only.

## Expected behavior and impact

This item contributes to usable, reliable messaging without weakening input ownership, original-operation recovery, or chain isolation. Actual behavior and unknowns are stated above; no production root cause is inferred beyond that evidence.

## Acceptance criteria

Barrier-based two-view collision test; disjoint views both proceed; private staged outputs remain hidden; rollback releases only provably unsubmitted claims; restart preserves potentially submitted ownership; old nonce retires and residual state is explicit. Shared contract cases cover supported EVM/Solana/UTXO representations. Align atomic persistence work with #1218 rather than duplicating it.

## Solution contract and scope

- Kind: bug.
- Planning state: NEEDS_SPECIFICATION until the owner accepts this prepared artifact and the prerequisites below are satisfied. Publication alone does not authorize implementation or mark it READY.
- Proposed execution owner: Shammah (@schancel): product/architecture decisions; root coordinator: contracts and integration; one claimed worker per implementation scope; independent reviewer before landing.
- Tier: 3 for production changes to money, lifecycle, identity, persistence, concurrency or wire; investigation itself is read-only.
- Model lane: strong for contract authoring and affected production work; resolve through the active harness at dispatch.
- Allowed scope: packages/wallet/chain-utxo-pool.ts; packages/wallet/chain-utxo-pool.jest.test.ts; directly used pool persistence/reservation boundary and its tests.
- Semantic mutexes: chain-inventory-reservations, inventory-durable-state.
- Open decision / readiness requirement: Freeze which production paths consume this pool and the mapping to existing journal reservations before enabling consumer concurrency. Asset layout is out of scope.
- Dependencies: none within this plan. Draft keys must become native GitHub blocked-by edges at publication; prose alone is not the dependency graph.
- Non-goals: no broad unscoped rewrite, legacy migrations, live-funds experiments, new asset framework, stash/worktree cleanup, or independent sibling integration.
- Staging: regression/evidence first; required replacement/refactor next; switch consumers and delete predecessor before completion. Temporary coexistence, if unavoidable between landings, belongs to this item's implementation owner and ends when the immediate successor switches consumers. Do not leave a compatibility layer.
- Durable shape: where records change, freeze current and target ownership and restart/partial-submission semantics before editing. Known consumers are app/bot delivery and supported chain adapters; hypothetical plugins/assets do not justify a framework. Development reset replaces migrations but never deletes custody or unrelated state implicitly.
- Rollback: stop dispatch, preserve operation evidence and keys, and fix forward or revert only when new-format and financial effects permit it. A code revert is not a financial rollback.
- Gates: relevant existing package tests and boundary/browser checks selected at dispatch, plus `yarn typecheck:fast` for source changes. No invented factory gate script. Investigations report evidence rather than claiming source gates passed.

## Queue proposal

Proposed value: 5
Proposed cost: 4
Proposed certainty: 4
Proposed unblocking: 5

Proposed score: 30. Exclusive ownership is necessary for concurrent construction and maintenance; deterministic view-level tests are clear, while production integration and durability raise cost. These scores are advisory and do not override readiness, blockers or scope mutexes.

## Related work and provenance

Related existing issues: #1218, #1184.

Owner discussion establishes chain-scoped pools, per-input reservations, independent normal stealth payments, distinct legacy fan-in, durable pre-submission recovery, partial-payment reporting, and clean format breaks. Current `AGENTS.md` records these decisions. Linked existing issues must be reconciled with these newer decisions, not blindly treated as current implementation truth.

Prepared labels: none. Prepared assignees: none. Implementation claims will be recorded separately after scope/liveness checks.
