# [bug] Distinguish intended value from verified partial payment on received messages

## Summary

Trace intended amount, signed transaction membership, observed settlement, stamp costs and optional content payments separately. Reuse existing authenticated intent where suitable. Present pending, partial and complete outcomes from actual evidence; do not conflate message delivery or signed value with received funds. Preserve recipient rechecking/rebroadcast of the same transactions and idempotent credit. No new payment suite or guessed wire allocation.

## Current evidence and reproduction

Owner requires a recipient indicator when an already delivered message is underpaid, and believes intended-amount metadata already exists. Receive paths currently sum signed stamp transaction values into stampValueWei; that alone is not evidence of settlement. Exact intended content-payment versus stamp representation and any existing receipt observer must be traced before declaring missing functionality.

Evidence is static inspection and owner reports at `f2231d2ff3d244ea5641e5444722271023c2fa2f`, not a completed browser or live-funds reproduction. Agent handoffs are leads only.

## Expected behavior and impact

This item contributes to usable, reliable messaging without weakening input ownership, original-operation recovery, or chain isolation. Actual behavior and unknowns are stated above; no production root cause is inferred beyond that evidence.

## Acceptance criteria

Deliver a message containing multiple payments and settle only a subset: recipient shows intended and observed amounts plus pending/partial status. Later settlement/rebroadcast/restart updates without double credit. Distinguish fees and stamps from content-payment amount. If a schema change is necessary, agree the exact format and update producer/consumer fixtures together before implementation.

## Solution contract and scope

- Kind: investigation and bounded fix.
- Planning state: NEEDS_SPECIFICATION until the owner accepts this prepared artifact and the prerequisites below are satisfied. Publication alone does not authorize implementation or mark it READY.
- Proposed execution owner: Shammah (@schancel): product/architecture decisions; root coordinator: contracts and integration; one claimed worker per implementation scope; independent reviewer before landing.
- Tier: 3 for production changes to money, lifecycle, identity, persistence, concurrency or wire; investigation itself is read-only.
- Model lane: strong for contract authoring and affected production work; resolve through the active harness at dispatch.
- Allowed scope: packages/wallet/chain/monad-canonical-dm.ts receive accounting; packages/cashweb/types/messages.ts; existing payment intent schema if needed; app received-payment state and renderer; co-located tests.
- Semantic mutexes: canonical-attempt-lifecycle, chat-store-and-outbox-ui, payment-receipt-accounting.
- Open decision / readiness requirement: First trace the existing intended-amount and receipt observation path. Product outcome is accepted; producer/consumer scope and state representation require a short contract before edits.
- Dependencies: payment-recovery. Draft keys must become native GitHub blocked-by edges at publication; prose alone is not the dependency graph.
- Non-goals: no broad unscoped rewrite, legacy migrations, live-funds experiments, new asset framework, stash/worktree cleanup, or independent sibling integration.
- Staging: regression/evidence first; required replacement/refactor next; switch consumers and delete predecessor before completion. Temporary coexistence, if unavoidable between landings, belongs to this item's implementation owner and ends when the immediate successor switches consumers. Do not leave a compatibility layer.
- Durable shape: where records change, freeze current and target ownership and restart/partial-submission semantics before editing. Known consumers are app/bot delivery and supported chain adapters; hypothetical plugins/assets do not justify a framework. Development reset replaces migrations but never deletes custody or unrelated state implicitly.
- Rollback: stop dispatch, preserve operation evidence and keys, and fix forward or revert only when new-format and financial effects permit it. A code revert is not a financial rollback.
- Gates: relevant existing package tests and boundary/browser checks selected at dispatch, plus `yarn typecheck:fast` for source changes. No invented factory gate script. Investigations report evidence rather than claiming source gates passed.

## Queue proposal

Proposed value: 5
Proposed cost: 3
Proposed certainty: 3
Proposed unblocking: 3

Proposed score: 20. Visible shortfall is an owner-required correctness outcome; existing intent/receipt representation must be traced before fixing presentation. These scores are advisory and do not override readiness, blockers or scope mutexes.

## Related work and provenance

Related existing issues: #71, #681.

Owner discussion establishes chain-scoped pools, per-input reservations, independent normal stealth payments, distinct legacy fan-in, durable pre-submission recovery, partial-payment reporting, and clean format breaks. Current `AGENTS.md` records these decisions. Linked existing issues must be reconciled with these newer decisions, not blindly treated as current implementation truth.

Prepared labels: none. Prepared assignees: none. Implementation claims will be recorded separately after scope/liveness checks.
