# [bug] Preserve conversation identity through activation and hydration

## Summary

Owner decision: one default thread per peer plus independently created conversations with stable IDs and subjects, including multiple conversations with the same bot. This is essential to mail-gateway correctness. Use one authoritative conversation identity and explicit derived lookup. Subject text is editable presentation, never the unique routing key; equal subjects need not identify the same conversation. Show subjects in the sidebar and chat header. Preserve authenticated conversation identity and email reply/reference threading; gateway address alone cannot identify a thread. Preserve distinct peers, groups, topics and email contexts; eliminate legacy peer dictionary ownership in the replacement stage. Logical UI message IDs, attempt references and delivery digests remain explicitly associated instead of interchangeable wildcard lookup. Do not change financial terminalization or signing.

## Current evidence and reproduction

chats.ts:3233 permits reuse when two short participant lists share only one participant; [A,B] then [A,C] may collide. :3266 aliases every participant including self. autoHealDuplicateDirectConversations (:753/:769/:787) groups by peer without topic. That matches earlier #1178 blanket peer-collapse intent, which the owner now supersedes with a default thread plus explicit independent conversations; this behavior must change rather than being treated as an accidental deviation from #1178. Dual chats/conversations storage remains active.

Evidence is static inspection and owner reports at `f2231d2ff3d244ea5641e5444722271023c2fa2f`, not a completed browser or live-funds reproduction. Agent handoffs are leads only.

## Expected behavior and impact

This item contributes to usable, reliable messaging without weakening input ownership, original-operation recovery, or chain isolation. Actual behavior and unknowns are stated above; no production root cause is inferred beyond that evidence.

## Acceptance criteria

Fail-before tests for overlapping participant sets, self aliases, same-peer distinct topics, repeated activation and reload. Verify message ownership, unread counts, tombstones and pending delivery links stay on the intended conversation. Include two bot threads with the same peer, renamed and equal subjects, and two email threads through the same gateway; replies, unread counts, deletion and recovery remain isolated. If a format break is needed, specify ownership of metadata AND separately persisted messages/outgoing recovery before any scoped reset. The distinct-recipient correction itself need not change formats. Separate characterization/regression, model replacement and caller deletion landings if required.

## Solution contract and scope

- Kind: bug.
- Planning state: NEEDS_SPECIFICATION until the owner accepts this prepared artifact and the prerequisites below are satisfied. Publication alone does not authorize implementation or mark it READY.
- Proposed execution owner: Shammah (@schancel): product/architecture decisions; root coordinator: contracts and integration; one claimed worker per implementation scope; independent reviewer before landing.
- Tier: 3 for production changes to money, lifecycle, identity, persistence, concurrency or wire; investigation itself is read-only.
- Model lane: strong for contract authoring and affected production work; resolve through the active harness at dispatch.
- Allowed scope: app/src/stores/chats.ts; conversation identity/hydration/outgoing store tests; app/src/adapters/pinia-chain-adapter.ts for affected lookups; ChatListItem.vue and chat header subject display; EmailThreadView.vue and mail-gateway threading integration tests as required.
- Semantic mutexes: chat-store-and-outbox-ui.
- Open decision / readiness requirement: Owner accepted independent conversations and subjects, including email gateway threads, during planning. Freeze the exact existing conversation/wire/email identity mapping before the model replacement; a first distinct-peer/self-alias correction can land separately. Do not key identity by mutable subject.
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
Proposed unblocking: 3

Proposed score: 20. Wrong-peer isolation and independent bot/email threads are high value; central identity and persisted relationship replacement require substantial review. These scores are advisory and do not override readiness, blockers or scope mutexes.

## Related work and provenance

Related existing issues: #1178, #818, #407, #68, #821. The newer owner decision supersedes blanket direct-peer collapse in #1178.

Owner discussion establishes chain-scoped pools, per-input reservations, independent normal stealth payments, distinct legacy fan-in, durable pre-submission recovery, partial-payment reporting, and clean format breaks. Current `AGENTS.md` records these decisions. Linked existing issues must be reconciled with these newer decisions, not blindly treated as current implementation truth.

Prepared labels: none. Prepared assignees: none. Implementation claims will be recorded separately after scope/liveness checks.
