# Complete idle mailbox readiness

Authorized bounded local fix; base integration61c6d468 (resolve full SHA in evidence). Implementation claim negotiation_empty_mailbox owns packages/wallet/chain/monad-canonical-dm.ts, its canonical DM tests, narrow scan interface documentation in active-chain.ts, packages/swap-protocol/src/runtime.ts and runtime tests. Parent owns review/integration. No app/session/chat/UI, journal/storage/protocol or financial execution edits.

## Failure and intended outcome

Actual signed negotiation UI flow cannot start with an empty mailbox: readMailbox returns the unchanged inclusive cursor after a complete empty read, while NegotiationRecovery equates unchanged cursor with incomplete. Idle scans after an earlier complete scan similarly lose ready status. UI worker observed Timed out: incomplete in both paid/free mounted variants; mutable local test signed-negotiation.flow.jest.test.ts currently seeds an ordinary message to continue testing. Final UI acceptance must remove that workaround after this fix.

Do not simply remove the unchanged-cursor check: readMailbox currently sets truncated only for pagination failures/cutoffs, while missing directory evidence sets earliestIncomplete and withholds affected timestamps without setting truncated. Both no-progress and advancing-prefix partial reads must remain incomplete.

Make scan completeness explicit through the existing truncated flag if full caller trace supports this: true for any incomplete scan (pagination cutoff/failure OR withheld unresolved timestamp group); false for a fully processed read including empty/idle reads. Document exact semantics in scanner and runtime interfaces. Runtime reports ready only after admission and durable coverage reconciliation of a non-truncated read, regardless of cursor movement. Preserve cursor monotonicity and no fabricated wall-clock advancement. If existing consumers require a distinct flag, report the finite interface amendment before editing beyond scope.

## Ownership and invariants

Scanner owns authenticated evidence and complete raw timestamp coverage; runtime owns admission, durable coverage and visible recovery status; app consumes readiness. Preserve original-envelope-only validation, no wallet effects, bounded pages, missing-directory replay, complete timestamp groups, terminal malformed/unreadable handling and inclusion boundary. Preserve lost-CAS reconciliation, storage failure states, account/chain affinity, timeout ownership and non-overlap. Do not broaden app readiness to ignore incomplete status. No wire/persistent format change or compatibility shim.

## Acceptance

1. Fail-before/pass-after actual scanner empty result feeding runtime reaches ready with unchanged cursor, including a brand-new store and repeated idle scans after earlier coverage.
2. Missing authenticated directory evidence remains incomplete with zero progress and with an earlier completed prefix. Recheck succeeds and becomes ready only when missing evidence is supplied. Rows at the incomplete timestamp and later remain replayable.
3. Pagination truncation/equal timestamp cutoff remains incomplete; normal complete read with terminal inert rows remains ready according to existing scanner semantics.
4. Existing timeout/nonoverlap/stop, durable-prefix writes, CAS and storage error tests remain valid. No synthetic cursor increments or UI bypass.
5. Run focused scanner/runtime plus relevant app/bot recovery tests and all25 configured typechecks. Tests prove the joined production boundary, not only mocked flags. Coordinate with UI owner to rerun unseeded fresh-account mounted paid/free flow after reviewed integration.

Keep candidate-local dependency overlays; every @frank link resolves to this candidate packages, external existing root deps allowed. No install/shared dependency edits/live services/funds/main merge/push/deploy/cleanup/attribution trailers. Record exact frozen commit, changed paths, tests and limitations. Independent read-only verifier host_frontier_design is investigating same source; do not mutate their disposable fixtures. No broad refactor. Local source revert does not touch durable wallet records.

Parent authorized the affected bot restart assertion in `packages/bot-framework/test/bot-host-reliability.jest.test.ts` to expect ready after a complete unchanged-cursor scan. Production bot scope remains unchanged.
