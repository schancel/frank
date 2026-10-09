# [refactor] Separate stable-session delivery execution from UI and chain composition

## Summary

Extract a headless delivery workflow with explicit stable wallet/session, messaging and persistence capabilities. Pinia owns presentation; composition owns lifecycle and network selection. Keep financial recovery semantics from prior fixes. Trace reachable waits first, enforce no network waits within broad UI mutation locks, and make reentrancy rules explicit. Establish an injected dispatch seam and move existing feature dispatch into application composition. The successor blackjack-slice extracts feature ownership behind that seam; this predecessor does not absorb the full feature migration.

## Current evidence and reproduction

Chat store owns payment reconciliation, retries and durable delivery mutations; chain composition mixes environment/browser configuration, wallet construction and message services. activeChain is mutable across async operations. A module-global delivery mutation queue is non-reentrant, but current nested deadlock reachability has not been proved.

Evidence is static inspection and owner reports at `f2231d2ff3d244ea5641e5444722271023c2fa2f`, not a completed browser or live-funds reproduction. Agent handoffs are leads only.

## Expected behavior and impact

This item contributes to usable, reliable messaging without weakening input ownership, original-operation recovery, or chain isolation. Actual behavior and unknowns are stated above; no production root cause is inferred beyond that evidence.

## Acceptance criteria

Existing send/retry/discard/receive/restart tests execute through the new facade; deterministic session switch cannot redirect an in-flight operation; headless and UI paths share behavior; serialization protects atomic mutations without hanging on reentrant work. Include app-to-bot fixture and dependency checks. Remove the predecessor implementation in the same staged outcome.

## Solution contract and scope

- Kind: refactor.
- Planning state: NEEDS_SPECIFICATION until the owner accepts this prepared artifact and the prerequisites below are satisfied. Publication alone does not authorize implementation or mark it READY.
- Proposed execution owner: Shammah (@schancel): product/architecture decisions; root coordinator: contracts and integration; one claimed worker per implementation scope; independent reviewer before landing.
- Tier: 3 for production changes to money, lifecycle, identity, persistence, concurrency or wire; investigation itself is read-only.
- Model lane: strong for contract authoring and affected production work; resolve through the active harness at dispatch.
- Allowed scope: app/src/stores/chats.ts; app/src/adapters/pinia-chain-adapter.ts; packages/wallet/chain/monad-chain.ts and monad-canonical-dm.ts; narrowly scoped new delivery/composition modules.
- Semantic mutexes: chat-store-and-outbox-ui, canonical-attempt-lifecycle, chain-composition.
- Open decision / readiness requirement: freeze current/target delivery owners, facade, dependency direction and any durable-format effects after the urgent fixes. Do not break formats merely to perform extraction.
- Dependencies: disjoint-sends, conversation-identity, session-generation, evm-boundaries. Draft keys must become native GitHub blocked-by edges at publication; prose alone is not the dependency graph.
- Non-goals: no broad unscoped rewrite, legacy migrations, live-funds experiments, new asset framework, stash/worktree cleanup, or independent sibling integration.
- Staging: regression/evidence first; required replacement/refactor next; switch consumers and delete predecessor before completion. Temporary coexistence, if unavoidable between landings, belongs to this item's implementation owner and ends when the immediate successor switches consumers. Do not leave a compatibility layer.
- Durable shape: where records change, freeze current and target ownership and restart/partial-submission semantics before editing. Known consumers are app/bot delivery and supported chain adapters; hypothetical plugins/assets do not justify a framework. Development reset replaces migrations but never deletes custody or unrelated state implicitly.
- Rollback: stop dispatch, preserve operation evidence and keys, and fix forward or revert only when new-format and financial effects permit it. A code revert is not a financial rollback.
- Gates: relevant existing package tests and boundary/browser checks selected at dispatch, plus `yarn typecheck:fast` for source changes. No invented factory gate script. Investigations report evidence rather than claiming source gates passed.

## Queue proposal

Proposed value: 4
Proposed cost: 4
Proposed certainty: 3
Proposed unblocking: 4

Proposed score: 15. A stable headless delivery seam reduces recurring fixes and enables plugin work; intertwined UI/state ownership makes review costly. These scores are advisory and do not override readiness, blockers or scope mutexes.

## Related work and provenance

Related existing issues: none found in the inspected open and recent closed set.

Owner discussion establishes chain-scoped pools, per-input reservations, independent normal stealth payments, distinct legacy fan-in, durable pre-submission recovery, partial-payment reporting, and clean format breaks. Current `AGENTS.md` records these decisions. Linked existing issues must be reconciled with these newer decisions, not blindly treated as current implementation truth.

Prepared labels: none. Prepared assignees: none. Implementation claims will be recorded separately after scope/liveness checks.
