# [refactor] Move blackjack into a feature-owned codec runtime and UI slice

## Summary

Move pure feature schemas/state and narrowly injected runtime verification behind explicit entry points. Register app/bot feature and UI components in composition. Generic delivery dispatches through the approved codec interface. Delete superseded definitions/import paths without compatibility exports. Preserve existing settlement algorithms; no new game/escrow design.

## Current evidence and reproduction

Blackjack already has canonical type 18, codec vectors, headless state/entropy/deck tests, app and bot consumers. Its plugin imports shared codec and cashweb types and globally registers; all plugin contexts require ethers Provider. ChatMessage.vue still chooses components with v-if; renderer registry controls only bubble size.

Evidence is static inspection and owner reports at `f2231d2ff3d244ea5641e5444722271023c2fa2f`, not a completed browser or live-funds reproduction. Agent handoffs are leads only.

## Expected behavior and impact

This item contributes to usable, reliable messaging without weakening input ownership, original-operation recovery, or chain isolation. Actual behavior and unknowns are stated above; no production root cause is inferred beyond that evidence.

## Acceptance criteria

Codec blackjack-items.jest.test.ts (including retention/budget cases), limits.jest.test.ts, stages.jest.test.ts, and headless plugin/state/entropy/deck tests pass; headless imports contain no Vue/Pinia or wallet implementation dependency. App-to-bot fixture exercises canonical hand send/receive; uninstalled feature is unsupported without execution; malformed installed payload fails before payment preparation. Verification remains bound to the original chain/session. Generic transport/rendering no longer enumerates blackjack.

## Solution contract and scope

- Kind: refactor.
- Planning state: NEEDS_SPECIFICATION until the owner accepts this prepared artifact and the prerequisites below are satisfied. Publication alone does not authorize implementation or mark it READY.
- Proposed execution owner: Shammah (@schancel): product/architecture decisions; root coordinator: contracts and integration; one claimed worker per implementation scope; independent reviewer before landing.
- Tier: 3 for production changes to money, lifecycle, identity, persistence, concurrency or wire; investigation itself is read-only.
- Model lane: strong for contract authoring and affected production work; resolve through the active harness at dispatch.
- Allowed scope: blackjack schema/codec modules; packages/wallet/message-item-plugins/blackjack moved to agreed feature home; cashweb item declarations; app blackjack renderer/composition; bot blackjack consumers; generic dispatch integration only through approved facade.
- Semantic mutexes: codec-schema-and-validation, chat-store-and-outbox-ui, canonical-attempt-lifecycle, bot-composition.
- Open decision / readiness requirement: Use the accepted feature home/dispatch contract from predecessors; preserve existing cryptography and do not overlap active signer worktrees.
- Dependencies: codec-composition, messaging-boundaries. Draft keys must become native GitHub blocked-by edges at publication; prose alone is not the dependency graph.
- Non-goals: no broad unscoped rewrite, legacy migrations, live-funds experiments, new asset framework, stash/worktree cleanup, or independent sibling integration.
- Staging: regression/evidence first; required replacement/refactor next; switch consumers and delete predecessor before completion. Temporary coexistence, if unavoidable between landings, belongs to this item's implementation owner and ends when the immediate successor switches consumers. Do not leave a compatibility layer.
- Durable shape: where records change, freeze current and target ownership and restart/partial-submission semantics before editing. Known consumers are app/bot delivery and supported chain adapters; hypothetical plugins/assets do not justify a framework. Development reset replaces migrations but never deletes custody or unrelated state implicitly.
- Rollback: stop dispatch, preserve operation evidence and keys, and fix forward or revert only when new-format and financial effects permit it. A code revert is not a financial rollback.
- Gates: relevant existing package tests and boundary/browser checks selected at dispatch, plus `yarn typecheck:fast` for source changes. No invented factory gate script. Investigations report evidence rather than claiming source gates passed.

## Queue proposal

Proposed value: 3
Proposed cost: 4
Proposed certainty: 3
Proposed unblocking: 2

Proposed score: 6.75. Provides a real reusable plugin boundary using mature consumers/tests; cross-layer moves cost more than a local refactor. These scores are advisory and do not override readiness, blockers or scope mutexes.

## Related work and provenance

Related existing issues: #950, #780.

Owner discussion establishes chain-scoped pools, per-input reservations, independent normal stealth payments, distinct legacy fan-in, durable pre-submission recovery, partial-payment reporting, and clean format breaks. Current `AGENTS.md` records these decisions. Linked existing issues must be reconciled with these newer decisions, not blindly treated as current implementation truth.

Prepared labels: none. Prepared assignees: none. Implementation claims will be recorded separately after scope/liveness checks.
