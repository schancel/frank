# [bug] Keep explicitly unaccepted proposals out of the worker ready queue

## Summary

The autonomous queue must honor explicit readiness and unresolved decisions instead of treating the presence of words and scores as acceptance. Human-reviewed bounded work can still be dispatched manually while this reporting defect is fixed.

## Current evidence and reproduction

At f2231d2ff3d244ea5641e5444722271023c2fa2f, `.agents/scripts/ready_queue.py:26` and `ticket_triage.py:54` derive READY solely from numeric scores and the words `acceptance` and `owner`. A body explicitly marked NEEDS_SPECIFICATION but containing those words and four scores can be reported ready. `issue_export.py` parses score fields without acceptance state. This conflicts with the skill's own exclusion of unaccepted proposals. No automated implementation was dispatched by this planning pass.

## Expected behavior and impact

Explicit non-ready state and unresolved approval must exclude an item. Scores rank accepted work; they do not grant acceptance. A shared parser should implement the existing documented states, not invent a new authority system. The currently drafted backlog withholds machine-readable score lines until acceptance so proposals cannot accidentally enter the present queue.

## Acceptance criteria

A deterministic fixture explicitly marked NEEDS_SPECIFICATION, with an owner, acceptance criteria and complete scores, remains absent from dispatchable output. An accepted READY fixture with satisfied dependencies is included. Blocked/unresolved proposals stay excluded even when a predecessor is omitted from the scored list. Triaging and ready-queue reporting agree. Missing acceptance remains non-ready. Existing native dependency ordering and scope-conflict behavior remain intact.

## Solution contract and scope

- Planning state: NEEDS_SPECIFICATION until owner acceptance and normal claim checks.
- Owner: root coordinator for contract/integration; Shammah for acceptance semantics; one bounded automation worker; independent review.
- Allowed files: `.agents/scripts/issue_export.py`, `ticket_triage.py`, `ready_queue.py` and their existing tests; relevant readiness documentation only if needed to remove ambiguity.
- Mutex: queue-readiness-reporting.
- Proposed tier: 2; requested lane strong for the initial acceptance/dispatch boundary contract. No edits to the worker-spawning implementation, no new external mutations or autonomous dispatch.
- Proof: existing Python script tests plus the explicit-state fixture through export/triage/queue. No monorepo typecheck is needed for Python-only edits.
- Rollback: retain manual coordinator acceptance gate; never fall back to blind automatic dispatch.
- No dependencies within the repair plan. Completion is a prerequisite for unattended backlog-loop use of the newly proposed items, not a blocker for manually accepted wallet fixes.

## Queue proposal

Proposed value 4, cost 2, certainty 5, unblocking 4; score 50. A small deterministic reporting fix prevents premature autonomous work. Do not emit machine-readable score fields until this contract is accepted.

## Related work

No matching open issue found in the inspected 68 open items. Related to the repository's issue-readiness, backlog-grooming and backlog-loop contracts. Prepared labels and assignees: none.
